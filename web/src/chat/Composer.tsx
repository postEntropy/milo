import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { api } from '../lib/api.js'
import { isPhone, usePhone } from '../lib/phone.js'
import { formatDuration, formatTokens } from '../../../src/util/format.ts'
import type { ModelInfo } from '../../../src/core/providers/models.js'
import type { CommandCodeModel } from '../../../src/core/command-code-models.js'
import { quotedLead } from '../../../src/core/sessions/format.ts'
import { COMMAND_CATALOG } from '../../../src/gateways/command-catalog.ts'
import type { JobView } from '@protocol'
import type { SessionBackendKind } from '../../../src/core/sessions/types.js'
import { Icon } from '../ui/Icons.js'
import { Select } from '../ui/Select.js'
import { ModelDetails } from '../ui/ModelDetails.js'
import { ModelPicker } from '../ui/ModelPicker.js'
import { ReasoningSlider } from '../ui/ReasoningSlider.js'

interface Props {
  busy: boolean
  queued: number
  /** The background jobs still running, drawn above the composer. */
  jobs?: JobView[]
  /** Stops a running job, from the control on its own row. */
  onKillJob?: (id: string) => void
  sessionBackend: SessionBackendKind
  provider: string
  /** What the provider is called on screen, so its models can be lead with it. */
  providerName: string
  /** The conversation the draft belongs to, so each one keeps its own. */
  draftKey: string
  /** The chat id used while the first session handshake is still pending. */
  pendingDraftKey: string
  model: string
  /**
   * How much of the context budget the last turn filled, when it is known. The
   * budget is where Milo tidies the oldest turns, not the model's raw window.
   */
  context?: { used: number; budget: number }
  effort: 'low' | 'medium' | 'high'
  /** Whether this session is proposing rather than working. */
  plan: boolean
  /** Whether the plan turn has answered, so there is something to approve. */
  planReady: boolean
  /** Whether this chat works in a project, which is where a plan makes sense. */
  canPlan: boolean
  onPlanChange(plan: boolean): void
  onApprovePlan(): void
  /** Bumped when something asks for the cursor, so the field takes the next keystroke. */
  focusSignal: number
  onSend(text: string, intent: 'steer' | 'queue', files?: File[]): Promise<boolean>
  onStop(): void
  /** Sets the pair: the model, and the provider it answers through. */
  onModelChange(model: string, provider: string): Promise<void>
  commandCodeModel?: string
  onCommandCodeModelChange(model: string): void
  onEffortChange(effort: 'low' | 'medium' | 'high'): void
  onProviderChange(provider: string): Promise<void>
}


/** What the app may ask the composer to do from outside it. */
export interface ComposerHandle {
  /** Put the cursor in the field, inside whatever click asked for it. */
  focus(): void
  /** Hold the picked-out words to quote, for the reply being written. */
  insertQuote(text: string): void
  /** Put a message's own words back in the field, to edit and send again. */
  load(text: string): void
  restore(text: string, files: File[]): boolean
}

/** The width at or under which the two toolbar pills fold into one menu. */
const FOLD_QUERY = '(max-width: 520px)'

/**
 * Whether the model and effort pills fold into one control. A narrower question
 * than the app's own phone width — `usePhone` in `lib/phone.ts` — because between
 * the two the pills still fit side by side while the window already counts as a
 * phone for everything else. Two lets named alike would be swapped by accident.
 */
function useFoldedToolbar(): boolean {
  const [folded, setFolded] = useState(() => window.matchMedia(FOLD_QUERY).matches)
  useEffect(() => {
    const media = window.matchMedia(FOLD_QUERY)
    const update = (): void => setFolded(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  return folded
}

/**
 * The context ring: radius 9 in a 22px box, so the 2.5px stroke stays inside it.
 * The circumference is what the dash lengths are measured against.
 */
const RING_CIRCUMFERENCE = 2 * Math.PI * 9

/** A command as one line for the strip: whitespace flattened and clipped. */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 80 ? `${flat.slice(0, 77)}…` : flat
}

export const Composer = forwardRef<ComposerHandle, Props>(function Composer(
  { busy, queued, jobs, onKillJob, sessionBackend, provider, providerName, draftKey, pendingDraftKey, model, context, effort, plan, planReady, canPlan, onPlanChange, onApprovePlan, focusSignal, onSend, onStop, onModelChange, commandCodeModel, onCommandCodeModelChange, onEffortChange, onProviderChange },
  handle,
) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const initialDraft = useRef<{ text: string; error: boolean } | null>(null)
  if (!initialDraft.current) {
    try { initialDraft.current = { text: localStorage.getItem(`milo-draft:${draftKey}`) ?? '', error: false } }
    catch { initialDraft.current = { text: '', error: true } }
  }
  const [draft, setDraft] = useState(initialDraft.current.text)
  const [draftStorageError, setDraftStorageError] = useState(initialDraft.current.error)
  /** The words picked out of a reply, held until the answer is sent. */
  const [quote, setQuote] = useState<string | null>(null)
  /** Which running job's output is expanded, if any. */
  const [openJob, setOpenJob] = useState<string | null>(null)
  /** A clock for the running jobs' elapsed time; it ticks only while one runs. */
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!jobs || jobs.length === 0) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [jobs])
  /** What was typed in each conversation, kept under the one it was typed in. */
  const drafts = useRef(new Map<string, string>([[draftKey, initialDraft.current.text]]))
  const fileDrafts = useRef(new Map<string, File[]>())
  const sending = useRef(false)
  const shownKey = useRef(draftKey)
  const [catalog, setCatalog] = useState<ModelInfo[] | null>(null)
  /** Which provider the loaded catalog belongs to, so the list follows the eye. */
  const catalogFor = useRef<string | null>(null)
  /** Every provider's catalog already read, so the rail can be walked back and
   *  forth without spending a call on a provider already seen. */
  const catalogs = useRef(new Map<string, ModelInfo[]>())
  /** The provider being looked at, and the one that was set when the eye moved:
   *  a browse stops counting the moment the provider is set to something else. */
  const [browsed, setBrowsed] = useState<{ from: string; provider: string } | null>(null)
  const browsing = browsed && browsed.from === provider ? browsed.provider : provider
  const [providers, setProviders] = useState<{ id: string; name: string }[] | null>(null)
  const providersLoaded = useRef(false)
  /** Whether the picker has been opened; before that a provider move spends no call. */
  const pickerOpened = useRef(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [highlight, setHighlight] = useState(0)
  /** The draft Escape was pressed on; the palette stays closed for that text alone. */
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [files, setFiles] = useState<File[]>([])
  const [uploadError, setUploadError] = useState('')
  const [commandCodeModels, setCommandCodeModels] = useState<CommandCodeModel[] | null>(null)
  const [commandCodeModelsError, setCommandCodeModelsError] = useState('')
  const [commandCodeModelsLoading, setCommandCodeModelsLoading] = useState(false)
  const uploadRef = useRef<HTMLInputElement>(null)
  const folded = useFoldedToolbar()
  /** A screen with room for the two panes: the providers and the models side by
   *  side. The app's own phone width is where the settings screen draws this
   *  same pair, so the composer asks the same question in the same place. */
  const wide = !usePhone()
  const codeSession = sessionBackend === 'command-code'

  const palette = useMemo(() => {
    if (codeSession || !draft.startsWith('/') || draft.includes(' ') || dismissed === draft) return []
    const query = draft.slice(1).toLowerCase()
    return COMMAND_CATALOG.filter((command) => command.name.startsWith(query)).slice(0, 8)
  }, [draft, dismissed, codeSession])

  useEffect(() => {
    if (highlight >= palette.length) setHighlight(0)
  }, [palette.length, highlight])

  // Starting a new session leaves the cursor on the button that was pressed.
  // The field takes it back, so the next keystroke is the message. Zero is the
  // first render, where nothing has asked for it yet.
  useEffect(() => {
    if (focusSignal === 0) return
    ref.current?.focus()
  }, [focusSignal])

  /** Puts a message's own words back in the field, ready to edit and send again. */
  const load = useCallback((text: string): void => {
    setDraft(text)
    drafts.current.set(draftKey, text)
    try { localStorage.setItem(`milo-draft:${draftKey}`, text); setDraftStorageError(false) }
    catch { setDraftStorageError(true) }
    requestAnimationFrame(() => {
      const el = ref.current
      if (!el) return
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    })
  }, [draftKey])

  useImperativeHandle(handle, () => ({
    focus: () => ref.current?.focus(),
    /**
     * Holds the picked-out words over the box and puts the cursor in the field,
     * so the reply being written is known to be about exactly them.
     */
    insertQuote: (text: string) => {
      setQuote(text)
      requestAnimationFrame(() => ref.current?.focus())
    },
    load,
    restore: (text, restoredFiles) => {
      const current = drafts.current.get(draftKey) ?? ''
      const combined = [current, text].filter(Boolean).join('\n\n')
      try { localStorage.setItem(`milo-draft:${draftKey}`, combined); setDraftStorageError(false) }
      catch { setDraftStorageError(true); return false }
      drafts.current.set(draftKey, combined)
      setDraft(combined)
      const nextFiles = [...(fileDrafts.current.get(draftKey) ?? []), ...restoredFiles]
      fileDrafts.current.set(draftKey, nextFiles)
      setFiles(nextFiles)
      requestAnimationFrame(() => ref.current?.focus())
      return true
    },
  }), [load, draftKey])

  /**
   * The box is as tall as what is written in it. The height is the textarea's
   * own style, which React never renders, so it has to be kept in step here:
   * setting it only while typing left the box stuck at the height of the last
   * long message long after that message had been sent.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: the draft is the trigger, not a value read here — the height follows the text the element already holds
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`
  }, [draft])

  /** Writes the draft and remembers it, so leaving the conversation keeps it. */
  function editDraft(next: string): void {
    setDraft(next)
    drafts.current.set(draftKey, next)
    try {
      if (next) localStorage.setItem(`milo-draft:${draftKey}`, next)
      else localStorage.removeItem(`milo-draft:${draftKey}`)
      setDraftStorageError(false)
    } catch { setDraftStorageError(true) }
  }

  // Swapping conversations brings the other one's draft back in. The quote does not
  // follow: it is the reply to words picked out of that thread, held only until the
  // answer is sent, so a session it was never picked from opens without it.
  useEffect(() => {
    if (shownKey.current === draftKey) return
    const previous = shownKey.current
    shownKey.current = draftKey
    let restored = drafts.current.get(draftKey)
    if (restored === undefined) {
      try { restored = localStorage.getItem(`milo-draft:${draftKey}`) ?? ''; setDraftStorageError(false) }
      catch { restored = ''; setDraftStorageError(true) }
      drafts.current.set(draftKey, restored)
    }
    // A person can type while the first handshake is still finding its session.
    // Move that draft to the session once its id arrives, without replacing a
    // draft already saved for the session.
    const early = previous === pendingDraftKey ? drafts.current.get(previous) : undefined
    if (early && !restored) {
      restored = early
      drafts.current.set(draftKey, early)
      try {
        localStorage.setItem(`milo-draft:${draftKey}`, early)
        localStorage.removeItem(`milo-draft:${previous}`)
        setDraftStorageError(false)
      } catch { setDraftStorageError(true) }
      drafts.current.delete(previous)
    }
    setDraft(restored)
    setFiles(fileDrafts.current.get(draftKey) ?? [])
    setQuote(null)
  }, [draftKey, pendingDraftKey])

  async function submit(intent: 'steer' | 'queue'): Promise<void> {
    if (sending.current) return
    const text = draft.trim()
    if (!text && files.length === 0) return
    // Sending puts the keys away on a phone: the answer is what is being waited
    // for, and the field is one tap away when the next message is typed. A wide
    // screen keeps the cursor where the next message goes, taken back here — inside
    // the gesture that sent this one — because the send button keeps the press and
    // gives it up when `busy` swaps it for the stop control. `preventScroll` so the
    // browser's own scroll to the field cannot ride on top of the phone's lift.
    if (isPhone()) ref.current?.blur()
    else ref.current?.focus({ preventScroll: true })
    // The picked-out words travel as a quotation ahead of the reply, so what was
    // answered is part of the message and not only in the reader's head.
    const quoted = quote ? quotedLead(quote) : ''
    setUploadError('')
    sending.current = true
    try {
      if (!await onSend(quoted + text, intent, files)) return
      if (drafts.current.get(draftKey) === draft) {
        drafts.current.delete(draftKey)
        try { localStorage.removeItem(`milo-draft:${draftKey}`); setDraftStorageError(false) }
        catch { setDraftStorageError(true) }
      }
      if (fileDrafts.current.get(draftKey) === files) fileDrafts.current.delete(draftKey)
      if (shownKey.current === draftKey) {
        setDraft((current) => current === draft ? '' : current)
        setFiles((current) => current === files ? [] : current)
        setQuote((current) => current === quote ? null : current)
      }
    } finally {
      sending.current = false
    }
  }

  function choose(name: string): void {
    const next = `/${name} `
    editDraft(next)
    setDismissed(next)
    ref.current?.focus()
  }

  function key(event: ReactKeyboardEvent<HTMLTextAreaElement>): void {
    if (palette.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setHighlight((current) => (current + 1) % palette.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setHighlight((current) => (current - 1 + palette.length) % palette.length)
        return
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
        event.preventDefault()
        choose(palette[highlight]!.name)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setDismissed(draft)
        return
      }
    }
    if (event.key === 'Escape' && quote) {
      event.preventDefault()
      setQuote(null)
      return
    }
    if (event.key === 'Escape' && busy) {
      event.preventDefault()
      onStop()
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void submit(!codeSession && busy && (event.ctrlKey || event.metaKey) ? 'steer' : 'queue')
    }
  }

  /** One provider's catalog: from memory when it has already been read, from the
   *  provider otherwise. Asking again for one already being read would spend a
   *  second call on the same provider for the same answer. */
  const loadCatalog = useCallback(async (wanted: string): Promise<void> => {
    if (!wanted) return
    const remembered = catalogs.current.get(wanted)
    if (remembered) {
      catalogFor.current = wanted
      setCatalog(remembered)
      setLoading(false)
      setError('')
      return
    }
    if (catalogFor.current === wanted) return
    catalogFor.current = wanted
    setCatalog(null)
    setLoading(true)
    setError('')
    try {
      const list = await api<ModelInfo[]>('models', { provider: wanted })
      catalogs.current.set(wanted, list)
      if (catalogFor.current !== wanted) return
      setCatalog(list)
    } catch (err) {
      if (catalogFor.current !== wanted) return
      catalogFor.current = null
      // An empty list rather than a missing one: the pane says what went wrong
      // instead of sitting on "reading this provider's models" forever.
      setCatalog([])
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (catalogFor.current === wanted) setLoading(false)
    }
  }, [])

  // The catalog under the open menu follows the provider being looked at; before
  // the picker has ever opened there is nothing to refresh, so no call is spent.
  useEffect(() => {
    if (!pickerOpened.current) return
    void loadCatalog(browsing)
  }, [browsing, loadCatalog])

  /** Clicks a provider in the rail: it only moves the eye, never the choice. */
  function browse(next: string): void {
    setBrowsed({ from: provider, provider: next })
  }

  /**
   * Choosing a model sets the pair, the same act as in the settings screen: a
   * model taken from another provider's list moves the provider with it. The app
   * serialises the two calls, so this hands over the pair and lets it answer.
   */
  function chooseModel(id: string): void {
    void onModelChange(id, browsing)
  }

  /** The providers this install can talk through, read once when the picker opens. */
  async function loadProviders(): Promise<void> {
    if (providersLoaded.current) return
    providersLoaded.current = true
    try {
      setProviders(await api<{ id: string; name: string }[]>('providers'))
    } catch {
      providersLoaded.current = false
    }
  }

  async function loadCommandCodeModels(): Promise<void> {
    if (commandCodeModels !== null || commandCodeModelsLoading) return
    setCommandCodeModelsLoading(true)
    setCommandCodeModelsError('')
    try {
      setCommandCodeModels(await api<CommandCodeModel[]>('command-code-models'))
    } catch (error) {
      setCommandCodeModelsError(error instanceof Error ? error.message : String(error))
    } finally {
      setCommandCodeModelsLoading(false)
    }
  }

  return (
    <div className="composer-shell">
      <div className="queue-list" aria-live="polite">{queued > 0 && <div className="queue-chip"><Icon name="history" size={14} /> {queued} {queued === 1 ? 'message queued' : 'messages queued'}</div>}
        {jobs && jobs.length > 0 && <div className="job-strip">
          {jobs.map((job) => {
            const open = openJob === job.id
            return <div className="job-entry" key={job.id}>
              <div className="job-chip">
                <button type="button" className="job-toggle" aria-expanded={open} title="Background job — show its output" onClick={() => setOpenJob(open ? null : job.id)}>
                  <Icon name="terminal" size={17} />
                  <span className="job-command">{oneLine(job.command)}</span>
                  <span className="job-elapsed">{formatDuration(Math.max(0, now - job.startedAt))}</span>
                  <span className="job-chevron"><Icon name="chevron" size={13} /></span>
                </button>
                {onKillJob && <button type="button" className="job-stop" title="Stop this job" aria-label={`Stop ${job.id}`} onClick={() => onKillJob(job.id)}><Icon name="stop" size={15} /></button>}
              </div>
              {open && <pre className="job-log">{job.lines.length > 0 ? job.lines.slice(-12).join('\n') : 'No output yet.'}</pre>}
            </div>
          })}
        </div>}
      </div>
      {canPlan && plan && <div className="plan-banner" role="status">
        <span className="plan-banner-text">Reading and proposing — Milo is not changing anything.</span>
        <button type="button" className="plan-approve" disabled={!planReady || busy} onClick={onApprovePlan}>Approve plan</button>
      </div>}
      <div className="composer-box">
        {draftStorageError && <div className="composer-upload-error" role="alert">This draft could not be saved on this device.</div>}
        {uploadError && <div className="composer-upload-error" role="alert">{uploadError}</div>}
        {files.length > 0 && <div className="composer-files" aria-live="polite">{files.map((file, index) => <span className="composer-file" key={`${file.name}-${file.size}-${file.lastModified}`}>{file.name}<button type="button" aria-label={`Remove ${file.name}`} title={`Remove ${file.name}`} onClick={() => setFiles((current) => { const next = current.filter((_, item) => item !== index); fileDrafts.current.set(draftKey, next); return next })}><Icon name="x" size={12} /></button></span>)}</div>}
        {palette.length > 0 && <div className="command-menu" role="listbox" aria-label="Commands">
          {palette.map((command, index) => <button className={`command-option ${index === highlight ? 'active' : ''}`} type="button" role="option" aria-selected={index === highlight} key={command.name} onMouseEnter={() => setHighlight(index)} onClick={() => choose(command.name)}><code className="command-name">/{command.name}</code><small>{command.hint}</small></button>)}
        </div>}
        {quote && <div className="composer-quote">
          <Icon name="quote" size={13} />
          <span className="composer-quote-text">{quote}</span>
          <button className="composer-quote-remove" type="button" title="Remove quote" aria-label="Remove quote" onClick={() => setQuote(null)}><Icon name="x" size={14} /></button>
        </div>}
        <textarea
          ref={ref}
          aria-label={codeSession ? 'Message Command Code' : 'Message Milo'}
          placeholder={codeSession ? 'Message Command Code…' : 'Ask Milo anything…'}
          rows={1}
          value={draft}
          onChange={(event) => editDraft(event.target.value)}
          onKeyDown={key}
        />
        <div className="composer-toolbar">
          <input ref={uploadRef} type="file" accept="image/*,audio/*,application/pdf,text/*,.docx,.xlsx,.pptx" multiple hidden onChange={(event) => { setFiles((current) => { const next = [...current]; const seen = new Set(current.map((file) => `${file.name}:${file.size}:${file.lastModified}`)); for (const file of Array.from(event.target.files ?? [])) { const key = `${file.name}:${file.size}:${file.lastModified}`; if (!seen.has(key)) { next.push(file); seen.add(key) } } fileDrafts.current.set(draftKey, next); return next }); event.target.value = '' }} />
          <button className="composer-pill attach-button" type="button" title="Attach files" aria-label="Attach files" onClick={() => uploadRef.current?.click()}><Icon name="plus" size={14} /></button>
          {canPlan && <button
            type="button"
            className="composer-pill mode-pill icon-only"
            aria-pressed={plan}
            aria-label={plan ? 'Plan mode' : 'Build mode'}
            disabled={busy}
            title={busy ? 'Wait for the turn to finish before changing the mode' : plan ? 'Plan mode is on — Milo proposes and changes nothing' : 'Build mode — Milo can change the folder; switch to plan first'}
            onClick={() => onPlanChange(!plan)}
          >
            <Icon name={plan ? 'list-check' : 'code'} size={15} />
          </button>}
          {sessionBackend === 'milo' ? <div className="composer-model-wrap">
            <Select
              className={`composer-pill${folded ? ' icon-only' : ''}`}
              label="Model and reasoning effort"
              icon="spark"
              body={wide ? (close) => <ModelPicker
                className="composer-model-panes"
                presets={providers ?? []}
                provider={provider}
                model={model}
                browsing={browsing}
                catalog={catalog}
                note={error || 'This provider reports no models.'}
                onBrowse={browse}
                onPick={(id) => { chooseModel(id); close() }}
              /> : undefined}
              filterExtra={wide ? undefined : <div className="composer-provider">
                <Select
                  label="Provider"
                  value={provider}
                  triggerLabel={providerName}
                  choices={(providers ?? []).map((item) => ({ value: item.id, label: item.name }))}
                  onChange={(next) => void onProviderChange(next)}
                  onOpen={() => void loadProviders()}
                  note="No other provider with a key is configured."
                />
              </div>}
              foot={<div className="composer-effort">
                <span className="composer-effort-title">Reasoning effort</span>
                <ReasoningSlider value={effort} onChange={onEffortChange} />
              </div>}
              value={model}
              triggerLabel={folded ? '' : model}
              choices={(catalog ?? []).map((item) => ({
                value: item.id, label: item.id, meta: <ModelDetails model={item} />,
              }))}
              onChange={chooseModel}
              onOpen={() => { pickerOpened.current = true; void loadProviders(); void loadCatalog(browsing) }}
              note={loading ? 'Loading models…' : error || 'No models found.'}
            />
          </div> : <Select
            className={`composer-pill${folded ? ' icon-only' : ''}`}
            label="Command Code model"
            icon="spark"
            value={commandCodeModel ?? ''}
            triggerLabel={folded ? '' : commandCodeModel || 'Choose model'}
            choices={(commandCodeModels ?? []).map((item) => ({
              value: item.id,
              label: item.id,
              meta: <span className="command-code-model-description">{item.description}</span>,
            }))}
            onChange={onCommandCodeModelChange}
            onOpen={() => void loadCommandCodeModels()}
            note={commandCodeModelsLoading ? 'Loading models…' : commandCodeModelsError || 'No Command Code models found.'}
            disabled={busy}
          />}
          <span className="composer-spacer" />
          {busy && (draft.trim() !== '' || files.length > 0) && <>
            <button className="composer-send-action" type="button" onClick={() => void submit('queue')} title="Send after the current turn finishes"><Icon name="history" size={14} />Queue</button>
            {!codeSession && <button className="composer-send-action" type="button" onClick={() => void submit('steer')} title="Send guidance to the running turn"><Icon name="reply" size={14} />Steer</button>}
          </>}
          {!codeSession && context && context.budget > 0 && <span className={`composer-context${context.used / context.budget >= 0.8 ? ' full' : ''}`} title={`${context.used.toLocaleString()} of ${context.budget.toLocaleString()} tokens — Milo tidies the oldest turns at ${context.budget.toLocaleString()}`}>
            <svg className="composer-context-ring" width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
              <circle className="composer-context-track" cx="11" cy="11" r="9" />
              <circle className="composer-context-arc" cx="11" cy="11" r="9" strokeDasharray={RING_CIRCUMFERENCE} strokeDashoffset={RING_CIRCUMFERENCE * (1 - Math.min(1, context.used / context.budget))} />
            </svg>
            <span className="composer-context-count">{formatTokens(context.used)} / {formatTokens(context.budget)}</span>
          </span>}
          {busy
            ? <button className="send-button stop" type="button" title="Stop (Esc)" aria-label={codeSession ? 'Stop Command Code turn' : 'Stop Milo turn'} onClick={onStop}><Icon name="stop" size={24} /></button>
            : <button className="send-button" type="button" title="Send (Enter)" aria-label="Send message" disabled={!draft.trim() && files.length === 0} onClick={() => void submit('queue')}><Icon name="send" size={17} /></button>}
        </div>
      </div>
    </div>
  )
})
