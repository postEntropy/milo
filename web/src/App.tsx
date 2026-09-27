import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './lib/api.js'
import { randomUUID } from './lib/uuid.js'
import { MiloSocket, type ConnectionState } from './lib/ws.js'
import { Composer } from './chat/Composer.js'
import { MessageList, type ChatMessage } from './chat/MessageList.js'
import { Permissions } from './chat/Permissions.js'
import { Settings } from './settings/Settings.js'
import type { ServerFrame, PermissionRequest } from '@protocol'
import { toolDetail } from '../../src/gateways/tool-line.ts'
import { Icon } from './ui/Icons.js'
import { miloAvatar } from './ui/milo.js'

type SessionSummary = { id: string; title?: string; preview: string; messageCount: number; updatedAt: number; recap?: string }
type PendingPermission = { id: string; request: PermissionRequest; expiresAt: number }
type SessionGroup = { label: string; sessions: SessionSummary[] }
type Notice = { text: string; error: boolean }

const settingsSections = [
  ['provider', 'cpu', 'Provider & model'], ['keys', 'key', 'API keys'], ['memory', 'database', 'Memory'],
  ['routines', 'repeat', 'Routines'], ['gateways', 'server', 'Gateways'], ['web', 'globe', 'Web'],
  ['tools', 'settings', 'Tools'], ['permissions', 'shield', 'Permissions'], ['display', 'eye', 'Display'],
  ['skills', 'spark', 'Skills'], ['sessions', 'history', 'Sessions'],
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
  const [settings, setSettings] = useState(false)
  const [settingsSection, setSettingsSection] = useState('provider')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [theme, setTheme] = useState(() => localStorage.getItem('milo-theme') ?? 'system')
  const [notice, setNotice] = useState<Notice | null>(null)
  const socket = useMemo(() => new MiloSocket(), [])
  const messagesRef = useRef<HTMLDivElement>(null)
  /** When the current wait began: the turn's first output, and again after each tool. */
  const waitStartedAt = useRef(0)
  const sessionListRef = useRef<HTMLElement | null>(null)
  /** The soft edge under the search box shows only once the list is scrolled. */
  const [listScrolled, setListScrolled] = useState(false)
  const updateListTop = useCallback((): void => {
    const list = sessionListRef.current
    if (!list) return
    setListScrolled(list.scrollTop > 2)
  }, [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: this recomputes when the rows or the view change, not for the values themselves — the list's height is what moved
  useEffect(() => { updateListTop() }, [updateListTop, sessions, search, settings, sidebarOpen])
  useEffect(() => {
    window.addEventListener('resize', updateListTop)
    return () => window.removeEventListener('resize', updateListTop)
  }, [updateListTop])

  const fail = useCallback((error: unknown): void => {
    setNotice({ text: error instanceof Error ? error.message : String(error), error: true })
  }, [])

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
    catch (error) { fail(error) }
  }, [fail])

  const handleFrame = useCallback((frame: ServerFrame): void => {
    if (frame.type === 'ready') {
      setConnection('online')
      setSessionId(frame.sessionId)
      setThinking(frame.thinking === 'on')
      setIdentity({ provider: frame.provider, model: frame.model })
      setMessages(frame.messages.map((message, index) => ({ ...message, id: `loaded-${index}`, loaded: true })))
      return
    }
    if (frame.type === 'error') { setNotice({ text: frame.message, error: true }); return }
    if (frame.type === 'state') { setBusy(frame.busy); setQueued(frame.queued); return }
    if (frame.type === 'turn-start') {
      waitStartedAt.current = Date.now()
      setMessages((current) => [...current, { id: `user-${frame.id}`, role: 'user', text: frame.text }, { id: frame.id, role: 'assistant', text: '' }])
      setBusy(true)
      return
    }
    if (frame.type === 'event') {
      setMessages((current) => current.map((message) => {
        if (message.id !== frame.turnId) return message
        const event = frame.event
        if (event.type === 'text-delta') {
          // The first output ends the wait — tool lines arrive as text too, so
          // this is the model talking after its last thought or its last tool.
          const waited = waitStartedAt.current ? Date.now() - waitStartedAt.current : 0
          waitStartedAt.current = 0
          return { ...message, text: message.text + event.delta, ...(waited > 0 ? { thoughtMs: waited } : {}) }
        }
        if (event.type === 'reasoning-delta') return { ...message, reasoning: (message.reasoning ?? '') + event.delta }
        if (event.type === 'tool-start') return { ...message, tools: [...(message.tools ?? []), `⚙ ${event.name}${toolDetail(event.args)}`] }
        if (event.type === 'tool-end') { waitStartedAt.current = Date.now(); return message }
        if (event.type === 'waiting') return { ...message, status: 'Waiting for this session to free up…' }
        if (event.type === 'waited') return { ...message, status: `Session freed after ${formatMs(event.ms)}.` }
        if (event.type === 'compacted') return { ...message, status: `Tidying the context (${formatMs(event.ms)}).` }
        if (event.type === 'rebased') return { ...message, status: `Session updated by another surface (${event.added} new ${event.added === 1 ? 'message' : 'messages'}).` }
        if (event.type === 'steer') return { ...message, status: 'Correction received by Milo.' }
        if (event.type === 'error') return { ...message, status: `Error: ${event.message}` }
        if (event.type === 'aborted') return { ...message, status: 'Stopped · the partial reply was kept.' }
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
      setSettings(false)
      setSidebarOpen(false)
      setConversationId(nextConversationId)
    } catch (error) { fail(error) }
  }, [socket, fail])

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
      setNotice(null)
    } catch (error) { fail(error) }
  }

  async function openSession(id: string): Promise<void> {
    const nextConversationId = randomUUID()
    try {
      await api('resume-session', { conversationId: nextConversationId, id })
      socket.close()
      setMessages([])
      setSessionId(id)
      setConversationId(nextConversationId)
      setSettings(false)
      setSidebarOpen(false)
    } catch (error) { fail(error) }
  }

  function handleSessionChange(id: string): void {
    setSessionId(id)
    socket.close()
    setMessages([])
    socket.connect(conversationId)
    setSettings(false)
  }

  async function exportSession(): Promise<void> {
    if (!sessionId) return
    try {
      const result = await api<{ path: string } | null>('export', { id: sessionId, format: 'md' })
      setNotice(result
        ? { text: `Exported to ${result.path}`, error: false }
        : { text: 'Nothing to export yet — this session has no log.', error: true })
    } catch (error) { fail(error) }
  }

  async function clearSession(): Promise<void> {
    try {
      await api('clear-session', { conversationId })
      setMessages([])
      setNotice({ text: 'This conversation was cleared.', error: false })
      void refreshSessions()
    } catch (error) { fail(error) }
  }

  const changeModel = useCallback(async (model: string): Promise<void> => {
    try {
      const result = await api<{ model: string }>('set-model', { model })
      setIdentity((current) => ({ ...current, model: result.model }))
      setNotice(null)
    } catch (error) { fail(error) }
  }, [fail])

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
      {!settings ? <div className="sidebar-chat-nav">
        <div className="brand-row"><img className="brand-mark" src={miloAvatar} alt="" /><span className="brand-name" translate="no">Milo</span></div>
        <div className="sidebar-pad">
          <div className="sidebar-controls">
            <label className="sidebar-search"><Icon name="search" size={16} /><input aria-label="Search sessions" placeholder="Search sessions" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
            <button className="new-chat" type="button" title="New session (⌘K)" aria-label="New session" onClick={() => void newChat()}><Icon name="plus" size={18} /></button>
          </div>
        </div>
        <div className="session-region">
          <nav className="session-list" aria-label="Sessions" ref={sessionListRef} onScroll={updateListTop}>
            {sessionGroups.map((group) => <div className="session-group" key={group.label}><div className="section-label">{group.label}</div>{group.sessions.map((session) => <SessionRow key={session.id} session={session} active={session.id === sessionId} onClick={() => void openSession(session.id)} />)}</div>)}
            {visibleSessions.length === 0 && <p className="list-empty">{search ? 'No sessions found.' : 'Your saved sessions show up here.'}</p>}
          </nav>
          <div className={`scroll-blur top ${listScrolled ? 'on' : ''}`} aria-hidden="true" />
        </div>
        <div className="sidebar-footer">
          <button className="sidebar-action" type="button" onClick={() => { setSettings(true); setSidebarOpen(false) }}><Icon name="settings" /><span className="sidebar-action-text"><strong>Settings</strong><small>Models, keys and tools</small></span></button>
        </div>
      </div> : <div className="sidebar-settings-nav">
        <div className="settings-nav-heading"><h2>Settings</h2><p>For this installation</p></div>
        <nav className="settings-nav" aria-label="Settings sections">
          {settingsSections.map(([id, icon, label]) => <button type="button" key={id} className={`settings-nav-item ${settingsSection === id ? 'active' : ''}`} onClick={() => setSettingsSection(id)}><Icon name={icon} /><span>{label}</span></button>)}
        </nav>
      </div>}
    </aside>

    <main className="main">
      <header className="topbar">
        <button className="mobile-menu" type="button" aria-label="Open menu" onClick={() => setSidebarOpen(true)}><Icon name="menu" /></button>
        {settings && <button className="btn-secondary" type="button" onClick={() => setSettings(false)}><span aria-hidden="true">←</span> Back to chat</button>}
        <div className="topbar-title"><h1>{settings ? 'Settings' : currentSession ? sessionLabel(currentSession) : 'New session'}</h1></div>
        <div className="topbar-actions">
          {!settings && sessionId && <button className="icon-button" type="button" title="Export this conversation" aria-label="Export this conversation" onClick={() => void exportSession()}><Icon name="download" size={16} /></button>}
          {!settings && sessionId && <button className="icon-button" type="button" title="Clear this conversation" aria-label="Clear this conversation" onClick={() => void clearSession()}><Icon name="trash" size={16} /></button>}
          {!settings && connection !== 'online' && <span className={`connection-status ${connection}`}><span />{connection === 'offline' ? 'Reconnecting…' : 'Connecting…'}</span>}
        </div>
      </header>
      {settings
        ? <Settings section={settingsSection} conversationId={conversationId} sessionId={sessionId} onClose={() => setSettings(false)} onSessionChange={handleSessionChange} theme={theme} onThemeChange={setTheme} />
        : <section className="chat-view">
          <div className="messages" id="messages" ref={messagesRef}>
            <MessageList messages={messages} thinking={thinking} onPrompt={send} />
            {pendingPermission && <article className="message assistant"><Permissions request={pendingPermission.request} expiresAt={pendingPermission.expiresAt} onDecision={(allowed) => socket.send({ type: 'control', action: allowed ? 'allow' : 'deny', id: pendingPermission.id })} /></article>}
          </div>
          {notice && <div className={`notice ${notice.error ? 'error' : 'success'}`} role="alert">{notice.text}<button className="icon-button" type="button" aria-label="Dismiss notice" onClick={() => setNotice(null)}><Icon name="x" size={15} /></button></div>}
          <Composer busy={busy} queued={queued} provider={identity.provider} model={identity.model} onSend={send} onStop={() => socket.send({ type: 'control', action: 'stop' })} onModelChange={(model) => void changeModel(model)} />
        </section>}
    </main>
  </div>
}

function SessionRow({ session, active, onClick }: { session: SessionSummary; active: boolean; onClick(): void }) {
  return <button className={`session-row ${active ? 'active' : ''}`} type="button" onClick={onClick}><span className="session-content"><span className="session-title">{sessionLabel(session)}</span><span className="session-preview">{sessionMeta(session)}</span></span></button>
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
