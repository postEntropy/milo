import { useEffect, useRef, useState } from 'react'
import type { PanelInput, PanelTab, PanelView } from '@protocol'
import { attachmentUrl, browserFramesUrl, panelUrl } from '../lib/api.js'
import { Markdown } from '../chat/Markdown.js'
import { Icon, type IconName } from '../ui/Icons.js'

/** The glyph each kind wears, on its tab and in the header. */
const KIND_ICON: Record<PanelTab['kind'], IconName> = {
  document: 'note',
  page: 'code',
  image: 'eye',
  pdf: 'file',
  file: 'file',
  browser: 'globe',
}

/**
 * The panel beside the chat: the tabs Milo has opened, drawn from the state the
 * server resolved. It holds no logic of its own beyond drawing — the requests, the
 * files and their kinds all come from the server, so a reload restores the same
 * tabs in the same order.
 */
export function Panel({ view, onClose, onInput, onActivateTab, onCloseTab }: {
  view: PanelView
  onClose(): void
  onInput(input: PanelInput): void
  onActivateTab(key: string): void
  onCloseTab(key: string): void
}) {
  // Bumped by the refresh control, to re-read a file that changed on disk: a page
  // reloads, a document is fetched again.
  const [nonce, setNonce] = useState(0)
  const active = view.tabs[view.active] ?? view.tabs[0]
  if (!active) return null
  const title = active.title ?? 'Panel'
  // One tab needs no strip: the head already names it, and a row carrying a single
  // name says nothing the title beside it does not.
  const strip = view.tabs.length > 1
  return <section className="panel" aria-label="Panel">
    {strip && <div className="panel-tabs">
      {view.tabs.map((tab, index) => <span className={`panel-tab ${index === view.active ? 'active' : ''}`} key={tab.key}>
        <button className="panel-tab-name" type="button" title={tab.title ?? 'Panel'} aria-current={index === view.active ? 'true' : undefined} onClick={() => onActivateTab(tab.key)}>
          <Icon name={KIND_ICON[tab.kind]} size={14} />
          <span>{tab.title ?? 'Panel'}</span>
        </button>
        <button className="panel-tab-x" type="button" title="Close tab" aria-label={`Close ${tab.title ?? 'this tab'}`} onClick={() => onCloseTab(tab.key)}><Icon name="x" size={12} /></button>
      </span>)}
    </div>}
    <header className="panel-head">
      <span className="panel-kind"><Icon name={KIND_ICON[active.kind]} size={16} /></span>
      {/* With a strip, the tab in front already carries the name. */}
      {strip ? <span className="panel-head-fill" /> : <h2 className="panel-title" title={title}>{title}</h2>}
      {/* The browser is live; there is nothing to re-read. Everything else can
          have changed on disk since it was shown. */}
      {active.kind !== 'browser' && <button className="panel-icon-btn" type="button" title="Refresh" aria-label="Refresh" onClick={() => setNonce((n) => n + 1)}><Icon name="refresh" size={16} /></button>}
      <button className="panel-icon-btn" type="button" title="Close panel" aria-label="Close panel" onClick={onClose}><Icon name="x" size={16} /></button>
    </header>
    <div className="panel-body" key={`${active.key}:${nonce}`}>
      {renderBody(active, nonce, onInput)}
    </div>
  </section>
}

function renderBody(state: PanelTab, nonce: number, onInput: (input: PanelInput) => void): React.ReactNode {
  if (state.kind === 'browser') return <BrowserView state={state} onInput={onInput} />
  const artifact = state.artifact
  if (!artifact) return <p className="panel-state">Nothing to show.</p>
  const url = panelUrl(artifact.id)

  if (state.kind === 'image') {
    return <div className="panel-image"><img src={url} alt={artifact.name} /></div>
  }
  if (state.kind === 'pdf') {
    return <iframe className="panel-frame" src={url} title={artifact.name} />
  }
  if (state.kind === 'page') {
    // Sandboxed without `allow-same-origin`: the page's own scripts run, but the
    // frame's origin is opaque, so a page can never reach the app around it.
    return <iframe className="panel-frame" src={url} title={artifact.name} sandbox="allow-scripts allow-forms allow-popups allow-modals" />
  }
  if (state.kind === 'document') {
    return <DocumentBody id={artifact.id} name={artifact.name} nonce={nonce} />
  }
  return <div className="panel-file">
    <p className="panel-state">Milo can’t render this here.</p>
    <a className="panel-download" href={attachmentUrl(artifact.id)} download={artifact.name}><Icon name="download" size={16} /><span>{artifact.name}</span></a>
  </div>
}

/** A text or code file, read from the server and drawn as prose or monospace. */
function DocumentBody({ id, name, nonce }: { id: string; name: string; nonce: number }) {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: `nonce` is the refresh signal — a new value re-reads the same file
  useEffect(() => {
    let live = true
    setText(null)
    setError(null)
    void fetch(panelUrl(id))
      .then((response) => {
        if (!response.ok) throw new Error(`could not read the file (${response.status})`)
        return response.text()
      })
      .then((body) => { if (live) setText(body) })
      .catch((failure: unknown) => { if (live) setError(failure instanceof Error ? failure.message : String(failure)) })
    return () => { live = false }
  }, [id, nonce])

  if (error) return <p className="panel-state">{error}</p>
  if (text === null) return <p className="panel-state">Reading…</p>
  if (name.toLowerCase().endsWith('.md') || name.toLowerCase().endsWith('.markdown')) {
    return <div className="panel-doc"><Markdown text={text} /></div>
  }
  return <pre className="panel-code">{text}</pre>
}

/**
 * The browser Milo is driving, drawn live and interactive. The frames come as an
 * MJPEG stream in an `<img>`; a transparent layer over it captures the person's
 * pointer and keys and sends them, normalized to the viewport, back through the
 * socket. It is their own action, so nothing is confirmed — this is where a login
 * or a 2FA step is handed over.
 */
function BrowserView({ state, onInput }: { state: PanelTab; onInput: (input: PanelInput) => void }) {
  const [error, setError] = useState(false)
  const layer = useRef<HTMLDivElement>(null)
  /** One pointer move a frame at most: a stream of them would swamp the socket. */
  const moving = useRef(false)

  const point = (event: React.MouseEvent): { x: number; y: number } => {
    const rect = event.currentTarget.getBoundingClientRect()
    return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height }
  }

  // The wheel is its own listener, not `onWheel`: React attaches that one as
  // passive, so `preventDefault` would not stop the page behind from scrolling.
  useEffect(() => {
    const node = layer.current
    if (!node || error) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const rect = node.getBoundingClientRect()
      onInput({
        kind: 'scroll',
        x: (event.clientX - rect.left) / rect.width,
        y: (event.clientY - rect.top) / rect.height,
        deltaY: event.deltaY,
      })
    }
    node.addEventListener('wheel', onWheel, { passive: false })
    return () => node.removeEventListener('wheel', onWheel)
  }, [onInput, error])

  return <div className="panel-browser">
    <div className="panel-url"><Icon name="globe" size={14} /><span>{readableUrl(state.url)}</span></div>
    <div className="panel-view">
      {error
        ? <p className="panel-state">The live view is unavailable — the browser may be off.</p>
        : <div className="panel-stage">
            <img className="panel-browser-img" src={browserFramesUrl()} alt="Live browser" onError={() => setError(true)} />
            <div
              ref={layer}
              className="panel-input-layer"
              role="application"
              aria-label="Live browser — click to interact"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: the layer is the live browser's interactive surface — it takes focus to receive keys
              tabIndex={0}
              title="Click to interact"
              onClick={(event) => { layer.current?.focus(); onInput({ kind: 'click', ...point(event) }) }}
              onMouseMove={(event) => {
                if (moving.current) return
                moving.current = true
                const at = point(event)
                window.requestAnimationFrame(() => { moving.current = false })
                onInput({ kind: 'move', ...at })
              }}
              onKeyDown={(event) => {
                if (event.metaKey || event.ctrlKey || event.altKey) return
                if (event.key.length === 1) {
                  event.preventDefault()
                  onInput({ kind: 'type', text: event.key })
                  return
                }
                if (event.key === 'Shift' || event.key === 'Control' || event.key === 'Alt' || event.key === 'Meta' || event.key === 'CapsLock') return
                event.preventDefault()
                onInput({ kind: 'key', key: event.key })
              }}
            />
          </div>}
    </div>
    {!error && <p className="panel-hint">Click the page to take over — Milo hands over logins, 2FA and payments here.</p>}
  </div>
}

/**
 * The address as a person reads it. `location.href` arrives percent-encoded where
 * the URL is not ASCII (`Wikipédia` → `Wikip%C3%A9dia`), which is correct and
 * unreadable; decoding it is display only, and anything undecodable is left alone.
 */
function readableUrl(url: string | null | undefined): string {
  if (!url) return 'the browser is not on a page'
  try {
    return decodeURI(url)
  } catch {
    return url
  }
}
