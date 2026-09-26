import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './lib/api.js'
import { randomUUID } from './lib/uuid.js'
import { MiloSocket, type ConnectionState } from './lib/ws.js'
import { Composer } from './chat/Composer.js'
import { MessageList, type ChatMessage } from './chat/MessageList.js'
import { Permissions } from './chat/Permissions.js'
import { Studio } from './studio/Studio.js'
import type { ServerFrame, PermissionRequest } from '@protocol'
import { toolDetail } from '../../src/gateways/tool-line.ts'
import { shortModel } from '../../src/gateways/model-label.ts'
import { Icon } from './ui/Icons.js'
import { miloAvatar } from './ui/milo.js'

type SessionSummary = { id: string; title?: string; preview: string; messageCount: number; updatedAt: number; recap?: string }
type PendingPermission = { id: string; request: PermissionRequest; expiresAt: number }
type SessionGroup = { label: string; sessions: SessionSummary[] }

const studioSections = [
  ['provider', 'cpu', 'Provider & model'], ['keys', 'key', 'API keys'], ['memory', 'database', 'Memory'],
  ['gateways', 'server', 'Gateways'], ['tools', 'settings', 'Tools'], ['permissions', 'shield', 'Permissions'],
  ['display', 'eye', 'Display'], ['skills', 'spark', 'Skills'], ['sessions', 'history', 'Sessions'],
] as const

export default function App() {
  const [conversationId, setConversationId] = useState(() => localStorage.getItem('milo-conversation') || randomUUID())
  const [sessionId, setSessionId] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const [queued, setQueued] = useState(0)
  const [pendingPermission, setPendingPermission] = useState<PendingPermission | null>(null)
  const [thinking, setThinking] = useState(true)
  const [identity, setIdentity] = useState({ provider: 'milo', model: '' })
  const [connection, setConnection] = useState<ConnectionState>('connecting')
  const [studio, setStudio] = useState(false)
  const [studioSection, setStudioSection] = useState('provider')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [theme, setTheme] = useState(() => localStorage.getItem('milo-theme') ?? 'system')
  const [notice, setNotice] = useState('')
  const socket = useMemo(() => new MiloSocket(), [])
  const messagesRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    localStorage.setItem('milo-conversation', conversationId)
    if (theme === 'system') localStorage.removeItem('milo-theme')
    else localStorage.setItem('milo-theme', theme)
    const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  }, [conversationId, theme])

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const applySystemTheme = () => {
      if (theme === 'system') document.documentElement.dataset.theme = media.matches ? 'dark' : 'light'
    }
    media.addEventListener('change', applySystemTheme)
    return () => media.removeEventListener('change', applySystemTheme)
  }, [theme])

  const refreshSessions = useCallback(async (): Promise<void> => {
    try { setSessions(await api<SessionSummary[]>('sessions')) }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
  }, [])

  const handleFrame = useCallback((frame: ServerFrame): void => {
    if (frame.type === 'ready') {
      setConnection('online')
      setSessionId(frame.sessionId)
      setThinking(frame.thinking === 'on')
      setIdentity({ provider: frame.provider, model: frame.model })
      setMessages(frame.messages.map((message, index) => ({ ...message, id: `loaded-${index}`, loaded: true })))
      return
    }
    if (frame.type === 'error') { setNotice(frame.message); return }
    if (frame.type === 'state') { setBusy(frame.busy); setQueued(frame.queued); return }
    if (frame.type === 'turn-start') {
      setMessages((current) => [...current, { id: `user-${frame.id}`, role: 'user', text: frame.text }, { id: frame.id, role: 'assistant', text: '' }])
      setBusy(true)
      return
    }
    if (frame.type === 'event') {
      setMessages((current) => current.map((message) => {
        if (message.id !== frame.turnId) return message
        const event = frame.event
        if (event.type === 'text-delta') return { ...message, text: message.text + event.delta }
        if (event.type === 'reasoning-delta') return { ...message, reasoning: (message.reasoning ?? '') + event.delta }
        if (event.type === 'tool-start') return { ...message, tools: [...(message.tools ?? []), `⚙ ${event.name}${toolDetail(event.args)}`] }
        if (event.type === 'waiting') return { ...message, status: 'Waiting for this session to free up…' }
        if (event.type === 'waited') return { ...message, status: `Session freed after ${formatMs(event.ms)}.` }
        if (event.type === 'compacted') return { ...message, status: `Tidying the context (${formatMs(event.ms)}).` }
        if (event.type === 'rebased') return { ...message, status: `Session updated by another surface (${event.added} new ${event.added === 1 ? 'message' : 'messages'}).` }
        if (event.type === 'steer') return { ...message, status: 'Correction received by Milo.' }
        if (event.type === 'error') return { ...message, status: `Error: ${event.message}` }
        if (event.type === 'aborted') return { ...message, status: 'Stopped · the partial reply was kept.' }
        if (event.type === 'usage') return { ...message, status: `${event.inputTokens.toLocaleString()} input tokens · ${event.outputTokens.toLocaleString()} output` }
        if (event.type === 'done' && event.finishReason === 'length') return { ...message, status: 'The reply hit the output limit.' }
        return message
      }))
      return
    }
    if (frame.type === 'permission') { setPendingPermission(frame); return }
    if (frame.type === 'permission-result') { setPendingPermission((current) => current?.id === frame.id ? null : current); return }
    if (frame.type === 'turn-end') {
      setMessages((current) => current.map((message) => message.id === frame.id && frame.status === 'stopped'
        ? { ...message, status: 'Stopped · the partial reply was kept.' }
        : message))
      setPendingPermission(null)
      void refreshSessions()
      return
    }
    if (frame.type === 'command-result') {
      if (frame.sessionId) setSessionId(frame.sessionId)
      setMessages((current) => [...current, { id: randomUUID(), role: 'assistant', text: frame.markdown ?? frame.reply }])
      void refreshSessions()
    }
  }, [refreshSessions])

  const newChat = useCallback(async (): Promise<void> => {
    const nextConversationId = randomUUID()
    try {
      const session = await api<{ id: string }>('new-session', { conversationId: nextConversationId })
      socket.close()
      setMessages([])
      setSessionId(session.id)
      setStudio(false)
      setSidebarOpen(false)
      setConversationId(nextConversationId)
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
  }, [socket])

  // biome-ignore lint/correctness/useExhaustiveDependencies: these are re-render triggers, not closure values — the list has already grown by the time this runs, and the scroll follows the rendered height
  useEffect(() => {
    const container = messagesRef.current
    if (!container) return
    const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 120
    if (nearBottom) container.scrollTop = container.scrollHeight
  }, [messages, pendingPermission])

  useEffect(() => {
    const unsubscribe = socket.subscribe(handleFrame)
    const unsubscribeStatus = socket.subscribeStatus(setConnection)
    socket.connect(conversationId)
    void refreshSessions()
    return () => { unsubscribe(); unsubscribeStatus(); socket.close() }
  }, [conversationId, socket, handleFrame, refreshSessions])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSidebarOpen(false)
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        void newChat()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [newChat])

  function send(text: string, intent: 'queue' | 'steer' = 'queue'): void {
    try {
      if (text.startsWith('/')) socket.send({ type: 'command', text })
      else socket.send({ type: 'send', text, intent })
      setNotice('')
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
  }

  async function openSession(id: string): Promise<void> {
    const nextConversationId = randomUUID()
    try {
      await api('resume-session', { conversationId: nextConversationId, id })
      socket.close()
      setMessages([])
      setSessionId(id)
      setConversationId(nextConversationId)
      setStudio(false)
      setSidebarOpen(false)
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
  }

  function handleSessionChange(id: string): void {
    setSessionId(id)
    socket.close()
    setMessages([])
    socket.connect(conversationId)
    setStudio(false)
  }

  const changeModel = useCallback(async (model: string): Promise<void> => {
    try {
      const result = await api<{ model: string }>('set-model', { model })
      setIdentity((current) => ({ ...current, model: result.model }))
      setNotice('')
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
  }, [])

  const query = search.trim().toLowerCase()
  const visibleSessions = sessions
    .filter((session) => session.messageCount > 0)
    .filter((session) => `${session.title ?? ''} ${session.preview} ${session.id}`.toLowerCase().includes(query))
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const sessionGroups = groupSessions(visibleSessions)
  const currentSession = sessions.find((session) => session.id === sessionId)

  return <div className="app-shell">
    {sidebarOpen && <button className="sidebar-scrim" type="button" aria-label="Close menu" onClick={() => setSidebarOpen(false)} />}
    <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`} aria-label="Main navigation">
      {!studio ? <div className="sidebar-chat-nav">
        <div className="brand-row"><img className="brand-mark" src={miloAvatar} alt="" /><span className="brand-name" translate="no">Milo</span></div>
        <div className="sidebar-pad">
          <div className="sidebar-controls">
            <label className="sidebar-search"><Icon name="search" size={16} /><input aria-label="Search sessions" placeholder="Search sessions" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
            <button className="new-chat" type="button" title="New session (⌘K)" aria-label="New session" onClick={() => void newChat()}><Icon name="plus" size={18} /></button>
          </div>
        </div>
        <nav className="session-list" aria-label="Sessions">
          {sessionGroups.map((group) => <div className="session-group" key={group.label}><div className="section-label">{group.label}</div>{group.sessions.map((session) => <SessionRow key={session.id} session={session} active={session.id === sessionId} onClick={() => void openSession(session.id)} />)}</div>)}
          {visibleSessions.length === 0 && <p className="list-empty">{search ? 'No sessions found.' : 'Your saved sessions show up here.'}</p>}
        </nav>
        <div className="sidebar-footer">
          <button className="sidebar-action" type="button" onClick={() => { setStudio(true); setSidebarOpen(false) }}><Icon name="sliders" /><span className="sidebar-action-text"><strong>Studio</strong><small>Models, keys and tools</small></span></button>
        </div>
      </div> : <div className="sidebar-studio-nav">
        <button className="back-button" type="button" onClick={() => setStudio(false)}><Icon name="chevron" size={15} className="back-chevron" /> Back to chat</button>
        <div className="studio-nav-heading"><h2>Studio</h2><p>Settings for this installation</p></div>
        <nav className="studio-nav" aria-label="Studio sections">
          {studioSections.map(([id, icon, label]) => <button type="button" key={id} className={`studio-nav-item ${studioSection === id ? 'active' : ''}`} onClick={() => setStudioSection(id)}><Icon name={icon} /><span>{label}</span></button>)}
        </nav>
      </div>}
    </aside>

    <main className="main">
      <header className="topbar">
        <button className="mobile-menu" type="button" aria-label="Open menu" onClick={() => setSidebarOpen(true)}><Icon name="menu" /></button>
        <div className="topbar-title"><h1>{studio ? 'Studio' : currentSession ? sessionLabel(currentSession) : 'New session'}</h1><p>{studio ? studioLabel(studioSection) : `${identity.provider}/${shortModel(identity.model)}`}</p></div>
        <div className="topbar-actions">
          {!studio && connection !== 'online' && <span className={`connection-status ${connection}`}><span />{connection === 'offline' ? 'Reconnecting…' : 'Connecting…'}</span>}
          <button className="topbar-studio" type="button" onClick={() => { setStudio(!studio); setSidebarOpen(false) }}><Icon name={studio ? 'chat' : 'sliders'} size={16} />{studio ? 'Chat' : 'Studio'}</button>
        </div>
      </header>
      {studio
        ? <Studio section={studioSection} conversationId={conversationId} onClose={() => setStudio(false)} onSessionChange={handleSessionChange} theme={theme} onThemeChange={setTheme} />
        : <section className="chat-view">
          <div className="messages" id="messages" ref={messagesRef}>
            <MessageList messages={messages} thinking={thinking} onPrompt={send} />
            {pendingPermission && <article className="message assistant"><img className="assistant-mark" src={miloAvatar} alt="" /><Permissions request={pendingPermission.request} expiresAt={pendingPermission.expiresAt} onDecision={(allowed) => socket.send({ type: 'control', action: allowed ? 'allow' : 'deny', id: pendingPermission.id })} /></article>}
          </div>
          {notice && <div className="notice error" role="alert">{notice}<button className="icon-button" type="button" aria-label="Dismiss notice" onClick={() => setNotice('')}><Icon name="x" size={15} /></button></div>}
          <Composer busy={busy} queued={queued} provider={identity.provider} model={identity.model} onSend={send} onStop={() => socket.send({ type: 'control', action: 'stop' })} onModelChange={(model) => void changeModel(model)} />
        </section>}
    </main>
  </div>
}

function SessionRow({ session, active, onClick }: { session: SessionSummary; active: boolean; onClick(): void }) {
  return <button className={`session-row ${active ? 'active' : ''}`} type="button" onClick={onClick}><Icon name="history" size={15} /><span className="session-content"><span className="session-title">{sessionLabel(session)}</span><span className="session-preview">{sessionMeta(session)}</span></span></button>
}

function studioLabel(section: string): string {
  return ({ provider: 'Provider & model', keys: 'API keys', memory: 'Memory', gateways: 'Gateways', tools: 'Tools', permissions: 'Permissions', display: 'Display', skills: 'Skills', sessions: 'Sessions' })[section] ?? 'Settings'
}

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`
}

/** What a session is called on screen: its message, never the generated id. */
function sessionLabel(session: SessionSummary): string {
  return session.title || session.preview || session.recap || 'New session'
}

function sessionMeta(session: SessionSummary): string {
  const count = `${session.messageCount} ${session.messageCount === 1 ? 'message' : 'messages'}`
  return session.messageCount > 0 ? `${count} · ${formatWhen(session.updatedAt)}` : formatWhen(session.updatedAt)
}

function formatWhen(timestamp: number): string {
  const elapsed = Date.now() - timestamp
  const minute = 60_000
  const hour = minute * 60
  const day = hour * 24
  if (elapsed < minute) return 'just now'
  if (elapsed < hour) return `${Math.floor(elapsed / minute)} min ago`
  if (elapsed < day) return `${Math.floor(elapsed / hour)} h ago`
  if (elapsed < day * 7) return `${Math.floor(elapsed / day)} d ago`
  return new Date(timestamp).toLocaleDateString()
}

/** Sessions bucketed by how recent they are, newest group first — the list itself arrives already sorted newest-first. */
function groupSessions(sessions: SessionSummary[]): SessionGroup[] {
  const day = 86_400_000
  const startOfToday = new Date().setHours(0, 0, 0, 0)
  const ranges: Array<[string, number, number]> = [
    ['Today', startOfToday, Number.POSITIVE_INFINITY],
    ['Yesterday', startOfToday - day, startOfToday],
    ['Previous 7 days', startOfToday - 7 * day, startOfToday - day],
    ['Older', Number.NEGATIVE_INFINITY, startOfToday - 7 * day],
  ]
  return ranges
    .map(([label, from, to]) => ({ label, sessions: sessions.filter((session) => session.updatedAt >= from && session.updatedAt < to) }))
    .filter((group) => group.sessions.length > 0)
}
