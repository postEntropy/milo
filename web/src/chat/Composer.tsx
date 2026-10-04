import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { api } from '../lib/api.js'
import { formatTokens } from '../lib/format.js'
import { shortModel } from '../../../src/gateways/model-label.ts'
import type { ModelInfo } from '../../../src/core/providers/models.js'
import { EFFORT_LEVELS } from '@protocol'
import { Icon } from '../ui/Icons.js'
import { Select } from '../ui/Select.js'
import { ModelDetails } from '../ui/ModelDetails.js'

interface Props {
  busy: boolean
  queued: number
  provider: string
  /** What the provider is called on screen, so its models can be lead with it. */
  providerName: string
  /** The conversation the draft belongs to, so each one keeps its own. */
  draftKey: string
  model: string
  /** How much of the model's window the last turn filled, when it is known. */
  context?: { used: number; window: number }
  effort: 'low' | 'medium' | 'high'
  /** Bumped when something asks for the cursor, so the field takes the next keystroke. */
  focusSignal: number
  onSend(text: string, intent: 'steer' | 'queue', files?: File[]): void
  onStop(): void
  onModelChange(model: string): void
  onEffortChange(effort: 'low' | 'medium' | 'high'): void
  onProviderChange(provider: string): void
}


/** What the app may ask the composer to do from outside it. */
export interface ComposerHandle {
  /** Put the cursor in the field, inside whatever click asked for it. */
  focus(): void
  /** Hold the picked-out words to quote, for the reply being written. */
  insertQuote(text: string): void
  /** Put a message's own words back in the field, to edit and send again. */
  load(text: string): void
}

/** What each reasoning-effort level is called on screen. */
const EFFORT_TEXT: Record<'low' | 'medium' | 'high', string> = { low: 'Low', medium: 'Medium', high: 'High' }

/** The width at or under which the two toolbar pills fold into one menu. */
const PHONE_QUERY = '(max-width: 520px)'

/**
 * Whether the composer is on a phone, where the model and effort pills do not
 * both fit and become one control instead of two.
 */
function usePhone(): boolean {
  const [phone, setPhone] = useState(() => window.matchMedia(PHONE_QUERY).matches)
  useEffect(() => {
    const media = window.matchMedia(PHONE_QUERY)
    const update = (): void => setPhone(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  return phone
}

/**
 * The context ring: radius 9 in a 22px box, so the 2.5px stroke stays inside it.
 * The circumference is what the dash lengths are measured against.
 */
const RING_CIRCUMFERENCE = 2 * Math.PI * 9

/** What `/` offers: the names the gateways share, with what each one does. */
const COMMANDS: Array<{ name: string; hint: string }> = [
  { name: 'help', hint: 'the commands, and what they do' },
  { name: 'status', hint: 'permission mode, display and effort' },
  { name: 'mode', hint: 'permission mode: ask | auto | yolo' },
  { name: 'yolo', hint: 'toggle yolo mode' },
  { name: 'tools', hint: 'how much of a tool call to show: full | name | off' },
  { name: 'thinking', hint: "show the model's reasoning: on | off" },
  { name: 'effort', hint: 'how hard the model thinks: low | medium | high' },
  { name: 'new', hint: 'start a new session' },
  { name: 'sessions', hint: 'the saved sessions' },
  { name: 'resume', hint: 'switch to a session: /resume <id>' },
  { name: 'stats', hint: 'numbers for the current session' },
  { name: 'compact', hint: 'fold the oldest turns into the summary now' },
  { name: 'export', hint: 'write this conversation to a file: /export [md|json]' },
  { name: 'skills', hint: 'the skills installed, and where they live' },
  { name: 'memory', hint: 'what Milo keeps: /memory [forget <id>]' },
  { name: 'clear', hint: 'forget this conversation' },
  { name: 'stop', hint: 'stop the turn running now' },
  { name: 'steer', hint: 'hand text to the turn running now' },
  { name: 'queue', hint: 'say it as its own turn, after this one' },
]

export const Composer = forwardRef<ComposerHandle, Props>(function Composer(
  { busy, queued, provider, providerName, draftKey, model, context, effort, focusSignal, onSend, onStop, onModelChange, onEffortChange, onProviderChange },
  handle,
) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [draft, setDraft] = useState('')
  /** The words picked out of a reply, held until the answer is sent. */
  const [quote, setQuote] = useState<string | null>(null)
  /** What was typed in each conversation, kept under the one it was typed in. */
  const drafts = useRef(new Map<string, string>())
  const fileDrafts = useRef(new Map<string, File[]>())
  const shownKey = useRef(draftKey)
  const [models, setModels] = useState<ModelInfo[] | null>(null)
  /** Which provider the loaded catalog belongs to, so a switch reloads it. */
  const modelsFor = useRef<string | null>(null)
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
  const uploadRef = useRef<HTMLInputElement>(null)
  const phone = usePhone()

  const palette = useMemo(() => {
    if (!draft.startsWith('/') || draft.includes(' ') || dismissed === draft) return []
    const query = draft.slice(1).toLowerCase()
    return COMMANDS.filter((command) => command.name.startsWith(query)).slice(0, 8)
  }, [draft, dismissed])

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
  }), [load])

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
  }

  // Swapping conversations brings the other one's draft back in.
  useEffect(() => {
    if (shownKey.current === draftKey) return
    shownKey.current = draftKey
    setDraft(drafts.current.get(draftKey) ?? '')
    setFiles(fileDrafts.current.get(draftKey) ?? [])
  }, [draftKey])

  async function submit(intent: 'steer' | 'queue'): Promise<void> {
    const text = draft.trim()
    if (!text && files.length === 0) return
    // The picked-out words travel as a quotation ahead of the reply, so what was
    // answered is part of the message and not only in the reader's head.
    const quoted = quote ? `${quote.split('\n').map((line) => `> ${line}`).join('\n')}\n\n` : ''
    setUploadError('')
    onSend(quoted + text, intent, files)
    setFiles([])
    fileDrafts.current.delete(draftKey)
    editDraft('')
    setQuote(null)
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
      void submit(busy && (event.ctrlKey || event.metaKey) ? 'steer' : 'queue')
    }
  }

  /** The provider's own catalog, read the first time the picker is opened, and
   *  again when the provider moves so the list on screen follows it. */
  const loadModels = useCallback(async (): Promise<void> => {
    if (!provider || modelsFor.current === provider) return
    const wanted = provider
    modelsFor.current = wanted
    setLoading(true)
    setError('')
    try {
      const list = await api<ModelInfo[]>('models', { provider: wanted })
      if (modelsFor.current !== wanted) return
      setModels(list)
    } catch (err) {
      if (modelsFor.current !== wanted) return
      modelsFor.current = null
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (modelsFor.current === wanted) setLoading(false)
    }
  }, [provider])

  // A provider switch reloads the catalog under the open menu; before the picker
  // has ever opened there is nothing to refresh, so no call is spent.
  useEffect(() => {
    if (!pickerOpened.current) return
    setModels(null)
    void loadModels()
  }, [loadModels])

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

  return (
    <div className="composer-shell">
      <div className="queue-list" aria-live="polite">{queued > 0 && <div className="queue-chip"><Icon name="history" size={14} /> {queued} {queued === 1 ? 'message queued' : 'messages queued'}</div>}</div>
      <div className="composer-box">
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
          aria-label="Message Milo"
          placeholder="Ask Milo anything…"
          rows={1}
          value={draft}
          onChange={(event) => editDraft(event.target.value)}
          onKeyDown={key}
        />
        <div className="composer-toolbar">
          <input ref={uploadRef} type="file" accept="image/*,audio/*,application/pdf,text/*,.docx,.xlsx,.pptx" multiple hidden onChange={(event) => { setFiles((current) => { const next = [...current]; const seen = new Set(current.map((file) => `${file.name}:${file.size}:${file.lastModified}`)); for (const file of Array.from(event.target.files ?? [])) { const key = `${file.name}:${file.size}:${file.lastModified}`; if (!seen.has(key)) { next.push(file); seen.add(key) } } fileDrafts.current.set(draftKey, next); return next }); event.target.value = '' }} />
          <button className="composer-pill attach-button" type="button" title="Attach files" aria-label="Attach files" onClick={() => uploadRef.current?.click()}><Icon name="plus" size={15} /></button>
          <div className="composer-model-wrap">
            <Select
              className="composer-pill"
              label={phone ? 'Model and reasoning effort' : `${providerName} models`}
              icon="spark"
              filterExtra={<div className="composer-provider">
                <Select
                  label="Provider"
                  value={provider}
                  triggerLabel={providerName}
                  choices={(providers ?? []).map((item) => ({ value: item.id, label: item.name }))}
                  onChange={onProviderChange}
                  onOpen={() => void loadProviders()}
                  note="No other provider with a key is configured."
                />
              </div>}
              foot={phone ? <div className="composer-effort-seg">
                {EFFORT_LEVELS.map((level) => <button
                  key={level}
                  type="button"
                  aria-pressed={level === effort}
                  onClick={() => onEffortChange(level)}
                >{EFFORT_TEXT[level]}</button>)}
              </div> : undefined}
              value={model}
              triggerLabel={phone && model ? `${shortModel(model)} · ${EFFORT_TEXT[effort]}` : model ? shortModel(model) : 'Model'}
              choices={(models ?? []).map((item) => ({
                value: item.id, label: item.id, meta: <ModelDetails model={item} />,
              }))}
              onChange={onModelChange}
              onOpen={() => { pickerOpened.current = true; void loadProviders(); void loadModels() }}
              note={loading ? 'Loading models…' : error || 'No models found.'}
            />
          </div>
          {!phone && <div className="composer-effort-wrap">
            <Select
              className="composer-pill"
              label="Reasoning effort"
              icon="light"
              value={effort}
              choices={EFFORT_LEVELS.map((level) => ({ value: level, label: EFFORT_TEXT[level] }))}
              onChange={(next) => onEffortChange(next as 'low' | 'medium' | 'high')}
            />
          </div>}
          <span className="composer-spacer" />
          {context && context.window > 0 && <span className={`composer-context${context.used / context.window >= 0.8 ? ' full' : ''}`} title={`${context.used.toLocaleString()} of ${context.window.toLocaleString()} tokens of context`}>
            <svg className="composer-context-ring" width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
              <circle className="composer-context-track" cx="11" cy="11" r="9" />
              <circle className="composer-context-arc" cx="11" cy="11" r="9" strokeDasharray={RING_CIRCUMFERENCE} strokeDashoffset={RING_CIRCUMFERENCE * (1 - Math.min(1, context.used / context.window))} />
            </svg>
            <span className="composer-context-count">{formatTokens(context.used)} / {formatTokens(context.window)}</span>
          </span>}
          {busy
            ? <button className="send-button stop" type="button" title="Stop (Esc)" aria-label="Stop Milo" onClick={onStop}><Icon name="stop" size={16} /></button>
            : <button className="send-button" type="button" title="Send (Enter)" aria-label="Send message" disabled={!draft.trim() && files.length === 0} onClick={() => void submit('queue')}><Icon name="send" size={17} /></button>}
        </div>
      </div>
    </div>
  )
})
