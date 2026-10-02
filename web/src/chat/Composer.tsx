import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { api } from '../lib/api.js'
import { formatTokens } from '../lib/format.js'
import { formatContext, shortModel } from '../../../src/gateways/model-label.ts'
import { EFFORT_LEVELS } from '@protocol'
import { Icon } from '../ui/Icons.js'
import { Select } from '../ui/Select.js'

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
  onSend(text: string, intent: 'steer' | 'queue'): void
  onStop(): void
  onModelChange(model: string): void
  onEffortChange(effort: 'low' | 'medium' | 'high'): void
}

type ModelInfo = { id: string; name?: string; context?: number }

/** What the app may ask the composer to do from outside it. */
export interface ComposerHandle {
  /** Put the cursor in the field, inside whatever click asked for it. */
  focus(): void
  /** Hold the picked-out words to quote, for the reply being written. */
  insertQuote(text: string): void
  /** Put a message's own words back in the field, to edit and send again. */
  load(text: string): void
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
  { busy, queued, provider, providerName, draftKey, model, context, effort, focusSignal, onSend, onStop, onModelChange, onEffortChange },
  handle,
) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [draft, setDraft] = useState('')
  /** The words picked out of a reply, held until the answer is sent. */
  const [quote, setQuote] = useState<string | null>(null)
  /** What was typed in each conversation, kept under the one it was typed in. */
  const drafts = useRef(new Map<string, string>())
  const shownKey = useRef(draftKey)
  const [models, setModels] = useState<ModelInfo[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [highlight, setHighlight] = useState(0)
  /** The draft Escape was pressed on; the palette stays closed for that text alone. */
  const [dismissed, setDismissed] = useState<string | null>(null)

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
  }, [draftKey])

  function submit(intent: 'steer' | 'queue'): void {
    const text = draft.trim()
    if (!text) return
    // The picked-out words travel as a quotation ahead of the reply, so what was
    // answered is part of the message and not only in the reader's head.
    const quoted = quote ? `${quote.split('\n').map((line) => `> ${line}`).join('\n')}\n\n` : ''
    onSend(quoted + text, intent)
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
      submit(busy && (event.ctrlKey || event.metaKey) ? 'steer' : 'queue')
    }
  }

  /** The provider's own catalog, read the first time the picker is opened. */
  async function loadModels(): Promise<void> {
    if (models || !provider) return
    setLoading(true)
    setError('')
    try {
      setModels(await api<ModelInfo[]>('models', { provider }))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="composer-shell">
      <div className="queue-list" aria-live="polite">{queued > 0 && <div className="queue-chip"><Icon name="history" size={14} /> {queued} {queued === 1 ? 'message queued' : 'messages queued'}</div>}</div>
      <div className="composer-box">
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
          <div className="composer-model-wrap">
            <Select
              className="composer-pill"
              label="Model"
              icon="spark"
              heading={providerName}
              value={model}
              triggerLabel={model ? shortModel(model) : 'Model'}
              choices={(models ?? []).map((item) => ({
                value: item.id, label: item.id, ...(item.context ? { badge: formatContext(item.context) } : {}),
              }))}
              onChange={onModelChange}
              onOpen={() => void loadModels()}
              note={loading ? 'Loading models…' : error || 'No models found.'}
            />
          </div>
          <div className="composer-effort-wrap">
            <Select
              className="composer-pill"
              label="Reasoning effort"
              icon="light"
              value={effort}
              choices={EFFORT_LEVELS.map((level) => ({ value: level, label: level.charAt(0).toUpperCase() + level.slice(1) }))}
              onChange={(next) => onEffortChange(next as 'low' | 'medium' | 'high')}
            />
          </div>
          <span className="composer-spacer" />
          {context && context.window > 0 && <span className={`composer-context${context.used / context.window >= 0.8 ? ' full' : ''}`} title={`${context.used.toLocaleString()} of ${context.window.toLocaleString()} tokens of context`}>
            <svg className="composer-context-ring" width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
              <circle className="composer-context-track" cx="11" cy="11" r="9" />
              <circle className="composer-context-arc" cx="11" cy="11" r="9" strokeDasharray={RING_CIRCUMFERENCE} strokeDashoffset={RING_CIRCUMFERENCE * (1 - Math.min(1, context.used / context.window))} />
            </svg>
            {formatTokens(context.used)} / {formatTokens(context.window)}
          </span>}
          {busy
            ? <button className="send-button stop" type="button" title="Stop (Esc)" aria-label="Stop Milo" onClick={onStop}><Icon name="stop" size={16} /></button>
            : <button className="send-button" type="button" title="Send (Enter)" aria-label="Send message" disabled={!draft.trim()} onClick={() => submit('queue')}><Icon name="send" size={17} /></button>}
        </div>
      </div>
    </div>
  )
})
