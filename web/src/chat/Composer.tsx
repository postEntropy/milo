import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { api } from '../lib/api.js'
import { shortModel } from '../../../src/gateways/model-label.ts'
import { Icon } from '../ui/Icons.js'

interface Props {
  busy: boolean
  queued: number
  provider: string
  model: string
  onSend(text: string, intent: 'steer' | 'queue'): void
  onStop(): void
  onModelChange(model: string): void
}

type ModelInfo = { id: string; name?: string }

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

export function Composer({ busy, queued, provider, model, onSend, onStop, onModelChange }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState('')
  const [menu, setMenu] = useState(false)
  const [models, setModels] = useState<ModelInfo[] | null>(null)
  const [filter, setFilter] = useState('')
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

  useEffect(() => {
    if (!menu) return
    const onDown = (event: MouseEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setMenu(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menu])

  function submit(intent: 'steer' | 'queue'): void {
    const text = draft.trim()
    if (!text) return
    onSend(text, intent)
    setDraft('')
  }

  function choose(name: string): void {
    const next = `/${name} `
    setDraft(next)
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

  async function toggleMenu(): Promise<void> {
    if (menu) {
      setMenu(false)
      return
    }
    setMenu(true)
    setFilter('')
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

  function pick(id: string): void {
    setMenu(false)
    if (id !== model) onModelChange(id)
  }

  const visible = (models ?? []).filter((item) => `${item.id} ${item.name ?? ''}`.toLowerCase().includes(filter.trim().toLowerCase()))

  return (
    <div className="composer-shell">
      <div className="queue-list" aria-live="polite">{queued > 0 && <div className="queue-chip"><Icon name="history" size={14} /> {queued} {queued === 1 ? 'message queued' : 'messages queued'}</div>}</div>
      <div className="composer-box">
        {palette.length > 0 && <div className="command-menu" role="listbox" aria-label="Commands">
          {palette.map((command, index) => <button className={`command-option ${index === highlight ? 'active' : ''}`} type="button" role="option" aria-selected={index === highlight} key={command.name} onMouseEnter={() => setHighlight(index)} onClick={() => choose(command.name)}><code className="command-name">/{command.name}</code><small>{command.hint}</small></button>)}
        </div>}
        <textarea
          ref={ref}
          aria-label="Message Milo"
          placeholder="Ask Milo anything…"
          rows={1}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={key}
          onInput={(event) => {
            event.currentTarget.style.height = 'auto'
            event.currentTarget.style.height = `${Math.min(event.currentTarget.scrollHeight, 180)}px`
          }}
        />
        <div className="composer-toolbar">
          <div className="composer-model-wrap" ref={wrap}>
            <button className="composer-model" type="button" title="Change model" aria-haspopup="listbox" aria-expanded={menu} onClick={() => void toggleMenu()}>
              <Icon name="spark" size={13} />
              <span className="composer-model-name">{model ? shortModel(model) : 'Model'}</span>
            </button>
            {menu && <div className="model-menu" role="listbox" aria-label="Model">
              {models && models.length > 8 && <input className="model-filter" aria-label="Filter models" placeholder="Filter models" value={filter} onChange={(event) => setFilter(event.target.value)} />}
              {loading && <div className="model-menu-note">Loading models…</div>}
              {error && <div className="model-menu-note error">{error}</div>}
              {!loading && !error && visible.length === 0 && <div className="model-menu-note">No models found.</div>}
              {visible.map((item) => <button className={`model-option ${item.id === model ? 'active' : ''}`} type="button" role="option" aria-selected={item.id === model} key={item.id} onClick={() => pick(item.id)}><span className="model-option-id">{item.id}</span>{item.name ? <small>{item.name}</small> : null}</button>)}
            </div>}
          </div>
          <button className="composer-hint" type="button" title="Commands" aria-label="Show commands" onClick={() => { setDraft('/'); setDismissed(null); ref.current?.focus() }}>
            <code className="mono">/</code> commands
          </button>
          <span className="composer-spacer" />
          {busy
            ? <button className="send-button stop" type="button" title="Stop (Esc)" aria-label="Stop Milo" onClick={onStop}><Icon name="stop" size={16} /></button>
            : <button className="send-button" type="button" title="Send (Enter)" aria-label="Send message" disabled={!draft.trim()} onClick={() => submit('queue')}><Icon name="send" size={17} /></button>}
        </div>
      </div>
    </div>
  )
}
