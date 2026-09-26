import { useEffect, useRef, useState } from 'react'
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

export function Composer({ busy, queued, provider, model, onSend, onStop, onModelChange }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState('')
  const [menu, setMenu] = useState(false)
  const [models, setModels] = useState<ModelInfo[] | null>(null)
  const [filter, setFilter] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

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
      {busy && <div className="stream-bar"><span className="pulse" /><span>Milo is replying…</span></div>}
      <div className="queue-list" aria-live="polite">{queued > 0 && <div className="queue-chip"><Icon name="history" size={14} /> {queued} {queued === 1 ? 'message queued' : 'messages queued'}</div>}</div>
      <div className="composer-box">
        <textarea
          ref={ref}
          aria-label="Message Milo"
          placeholder="Ask Milo anything…"
          rows={1}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onInput={(event) => {
            event.currentTarget.style.height = 'auto'
            event.currentTarget.style.height = `${Math.min(event.currentTarget.scrollHeight, 180)}px`
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && busy) { event.preventDefault(); onStop(); return }
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              submit(busy && (event.ctrlKey || event.metaKey) ? 'steer' : 'queue')
            }
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
          <span className="composer-spacer" />
          {busy
            ? <button className="send-button stop" type="button" title="Stop (Esc)" aria-label="Stop Milo" onClick={onStop}><Icon name="stop" size={16} /></button>
            : <button className="send-button" type="button" title="Send (Enter)" aria-label="Send message" disabled={!draft.trim()} onClick={() => submit('queue')}><Icon name="send" size={17} /></button>}
        </div>
      </div>
      <p className="composer-disclaimer">Milo can make mistakes. Check commands before letting them run.</p>
    </div>
  )
}
