import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './lib/api.js'
import { randomUUID } from './lib/uuid.js'
import { MiloSocket, type ConnectionState } from './lib/ws.js'
import { Composer, type ComposerHandle } from './chat/Composer.js'
import { MessageList, type ChatMessage } from './chat/MessageList.js'
import { Permissions } from './chat/Permissions.js'
import { Routines } from './routines/Routines.js'
import { Settings } from './settings/Settings.js'
import type { ServerFrame, PermissionRequest, SendTarget } from '@protocol'
import { toolText } from '../../src/gateways/tool-line.ts'
import { closeParagraph } from '../../src/util/format.ts'
import { Icon } from './ui/Icons.js'
import { miloAvatar } from './ui/milo.js'

type SessionSummary = { id: string; title?: string; preview: string; messageCount: number; updatedAt: number; recap?: string }
type PendingPermission = { id: string; request: PermissionRequest; expiresAt: number }
type SessionGroup = { label: string; sessions: SessionSummary[] }
type Notice = { text: string; error: boolean }

const settingsSections = [
  ['provider', 'cpu', 'Provider & model'], ['keys', 'key', 'API keys'], ['memory', 'database', 'Memory'],
  ['gateways', 'server', 'Gateways'], ['web', 'globe', 'Web'],
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
  /** Counts finished turns: the routines screen re-reads its list when one ends. */
  const [turnEnds, setTurnEnds] = useState(0)
  const [thinking, setThinking] = useState(true)
  const [effort, setEffort] = useState<'low' | 'medium' | 'high'>('medium')
  const [identity, setIdentity] = useState({ provider: 'milo', model: '' })
  const [connection, setConnection] = useState<ConnectionState>('connecting')
  const [view, setView] = useState<'chat' | 'settings' | 'routines'>('chat')
  const [settingsSection, setSettingsSection] = useState('provider')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [theme, setTheme] = useState(() => localStorage.getItem('milo-theme') ?? 'system')
  const [notice, setNotice] = useState<Notice | null>(null)
  /** Bumped to hand the cursor to the composer, e.g. once a new session opens. */
  const [composerFocus, setComposerFocus] = useState(0)
  const socket = useMemo(() => new MiloSocket(), [])
  const composerRef = useRef<ComposerHandle>(null)
  const messagesRef = useRef<HTMLDivElement>(null)
  const sessionListRef = useRef<HTMLElement | null>(null)
  /** The soft edge under the search box shows only once the list is scrolled. */
  const [listScrolled, setListScrolled] = useState(false)
  const updateListTop = useCallback((): void => {
    const list = sessionListRef.current
    if (!list) return
    setListScrolled(list.scrollTop > 2)
  }, [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: this recomputes when the rows or the view change, not for the values themselves — the list's height is what moved
  useEffect(() => { updateListTop() }, [updateListTop, sessions, search, view, sidebarOpen])
  useEffect(() => {
    window.addEventListener('resize', updateListTop)
    return () => window.removeEventListener('resize', updateListTop)
  }, [updateListTop])

  /** The soft edge under the session header shows only once messages are scrolled. */
  const [chatScrolled, setChatScrolled] = useState(false)
  const updateMessagesTop = useCallback((): void => {
    const el = messagesRef.current
    if (!el) return
    setChatScrolled(el.scrollTop > 2)
  }, [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: recomputes when messages or view change
  useEffect(() => { updateMessagesTop() }, [updateMessagesTop, messages, view])
  useEffect(() => {
    window.addEventListener('resize', updateMessagesTop)
    return () => window.removeEventListener('resize', updateMessagesTop)
  }, [updateMessagesTop])

  const fail = useCallback((error: unknown): void => {
    setNotice({ text: error instanceof Error ? error.message : String(error), error: true })
  }, [])

  useEffect(() => {
    localStorage.setItem('milo-conversation', conversationId)
    if (theme === 'system') localStorage.removeItem('milo-theme')
    else localStorage.setItem('milo-theme', theme)
    const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    // The status bar and the toolbar take the app's own background: launched full
    // screen, the page would otherwise sit under a band of another colour. Read
    // from the token rather than repeated here, so the two cannot drift.
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--bg').trim())
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
      if (frame.effort) setEffort(frame.effort)
      setIdentity({ provider: frame.provider, model: frame.model })
      setMessages(frame.messages.map((message, index) => ({ ...message, id: `loaded-${index}`, loaded: true })))
      return
    }
    if (frame.type === 'error') { setNotice({ text: frame.message, error: true }); return }
    if (frame.type === 'state') { setBusy(frame.busy); setQueued(frame.queued); return }
    if (frame.type === 'turn-start') {
      // The wait starts here and the turn says so on screen: the assistant
      // message carries it, so the line appears where the reply will.
      setMessages((current) => [...current, { id: `user-${frame.id}`, role: 'user', text: frame.text }, { id: frame.id, role: 'assistant', text: '', waitingSince: Date.now() }])
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
          const waited = message.waitingSince ? Date.now() - message.waitingSince : 0
          const baseText = message.waitingSince && message.text ? closeParagraph(message.text) : message.text
          return { ...message, text: baseText + event.delta, waitingSince: undefined, ...(thoughtMsFor(waited, message)) }
        }
        if (event.type === 'reasoning-delta') return { ...message, reasoning: (message.reasoning ?? '') + event.delta }
        if (event.type === 'tool-start') {
          // Reasoning deltas do not end a wait — they are what fills it. A tool
          // call is an output of its own, and the wait before it was thinking.
          const waited = message.waitingSince ? Date.now() - message.waitingSince : 0
          const text = closeParagraph(message.text)
          return { ...message, text, tools: [...(message.tools ?? []), { name: event.name, text: toolText(event.name, event.args) }], waitingSince: undefined, ...(thoughtMsFor(waited, message)) }
        }
        if (event.type === 'tool-end') {
          // The result is in: the model is thinking again about what to do with it.
          return event.isError
            ? { ...message, tools: [...(message.tools ?? []), { name: event.name, text: `${toolText(event.name)} failed` }], waitingSince: Date.now() }
            : { ...message, waitingSince: Date.now() }
        }
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
      setMessages((current) => current.map((message) => message.id === frame.id
        ? { ...message, waitingSince: undefined, ...(frame.status === 'stopped' ? { status: 'Stopped · the partial reply was kept.' } : {}) }
        : message))
      setPendingPermission(null)
      setTurnEnds((current) => current + 1)
      void refreshSessions()
      return
    }
    if (frame.type === 'command-result') {
      if (frame.sessionId) setSessionId(frame.sessionId)
      // Actions and rich cards (e.g. /sessions pagination) are ephemeral in-memory UI
      // controls received over websocket; they re-render or re-issue commands when clicked.
      if (frame.messageId) {
        setMessages((current) => {
          const exists = current.some((msg) => msg.id === frame.messageId)
          if (exists) {
            return current.map((msg) => msg.id === frame.messageId ? {
              ...msg,
              text: frame.markdown ?? frame.reply,
              ...(frame.attachments?.length ? { attachments: frame.attachments } : {}),
              actions: frame.actions?.length ? frame.actions : undefined,
              cards: frame.cards?.length ? frame.cards : undefined,
            } : msg)
          }
          return [...current, {
            id: randomUUID(),
            role: 'assistant',
            text: frame.markdown ?? frame.reply,
            ...(frame.attachments?.length ? { attachments: frame.attachments } : {}),
            ...(frame.actions?.length ? { actions: frame.actions } : {}),
            ...(frame.cards?.length ? { cards: frame.cards } : {}),
          }]
        })
      } else {
        setMessages((current) => [...current, {
          id: randomUUID(),
          role: 'assistant',
          text: frame.markdown ?? frame.reply,
          ...(frame.attachments?.length ? { attachments: frame.attachments } : {}),
          ...(frame.actions?.length ? { actions: frame.actions } : {}),
          ...(frame.cards?.length ? { cards: frame.cards } : {}),
        }])
      }
      void refreshSessions()
    }
  }, [refreshSessions])

  const newChat = useCallback(async (): Promise<void> => {
    const nextConversationId = randomUUID()
    // Inside the click that asked for it, before any state moves: a focus handed
    // over a tick later is a focus the browser is free to drop. The counter is
    // the other half — when this chat is not the view on screen, the composer
    // mounts only once it is, and takes the cursor then.
    composerRef.current?.focus()
    setComposerFocus((current) => current + 1)
    try {
      const session = await api<{ id: string }>('new-session', { conversationId: nextConversationId })
      socket.close()
      setMessages([])
      setSessionId(session.id)
      setView('chat')
      setSidebarOpen(false)
      setConversationId(nextConversationId)
    } catch (error) { fail(error) }
  }, [socket, fail])

  // biome-ignore lint/correctness/useExhaustiveDependencies: these are re-render triggers, not closure values — the list has already grown by the time this runs, and the scroll follows the rendered height
  useEffect(() => {
    const container = messagesRef.current
    if (!container) return
    // The empty state is a screen of its own: it stays at the top, so the hero
    // is never half-scrolled out of view when it is only slightly too tall.
    if (messages.length === 0) { container.scrollTop = 0; return }
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

  /**
   * The drawer's own gestures, one for each direction: a rightward swipe that
   * starts at the left edge opens it, and a leftward swipe across the chat closes
   * it again, the way every other panel on the phone works. The listeners stay
   * passive, so a swipe in the page still scrolls it.
   */
  useEffect(() => {
    const narrow = window.matchMedia('(max-width: 900px)')
    const EDGE = 24
    const OPEN_AT = 88
    const CLOSE_AT = 64
    let from: { x: number; y: number } | null = null

    const start = (event: TouchEvent) => {
      if (!narrow.matches || event.touches.length !== 1) return
      const touch = event.touches[0]
      // Opening begins at the edge; closing begins anywhere on the revealed chat.
      const wanted = sidebarOpen ? true : touch.clientX <= EDGE
      from = wanted ? { x: touch.clientX, y: touch.clientY } : null
    }
    const move = (event: TouchEvent) => {
      if (!from || event.touches.length !== 1) return
      const touch = event.touches[0]
      const dx = touch.clientX - from.x
      const dy = touch.clientY - from.y
      // A mostly vertical drag is a scroll, so this was never the gesture.
      if (Math.abs(dy) > Math.abs(dx)) { from = null; return }
      if (sidebarOpen ? dx <= -CLOSE_AT : dx >= OPEN_AT) {
        from = null
        setSidebarOpen(!sidebarOpen)
      }
    }
    const end = () => { from = null }

    window.addEventListener('touchstart', start, { passive: true })
    window.addEventListener('touchmove', move, { passive: true })
    window.addEventListener('touchend', end, { passive: true })
    window.addEventListener('touchcancel', end, { passive: true })
    return () => {
      window.removeEventListener('touchstart', start)
      window.removeEventListener('touchmove', move)
      window.removeEventListener('touchend', end)
      window.removeEventListener('touchcancel', end)
    }
  }, [sidebarOpen])

  /**
   * A turn in the conversation this browser is in. `target` is how the routines
   * screen pins the destination a routine it asks for is made for, when that is
   * not this chat — the sentence then does not have to say it.
   */
  function send(text: string, intent: 'queue' | 'steer' = 'queue', target?: SendTarget): void {
    try {
      if (text.startsWith('/')) {
        setMessages((current) => [...current, { id: `user-${randomUUID()}`, role: 'user', text }])
        socket.send({ type: 'command', text })
      }
      else socket.send({ type: 'send', text, intent, ...(target ? { target } : {}) })
      setNotice(null)
    } catch (error) { fail(error) }
  }

  /**
   * A routine asked for from the routines screen: always its own turn, and the
   * destination that screen named travels with it, so the sentence does not have
   * to spell it out.
   */
  function askRoutine(text: string, target?: SendTarget): void {
    send(text, 'queue', target)
  }

  /** The answer to a permission prompt, wherever on screen it is drawn. */
  function decide(allowed: boolean): void {
    if (!pendingPermission) return
    socket.send({ type: 'control', action: allowed ? 'allow' : 'deny', id: pendingPermission.id })
  }

  const openSession = useCallback(async (id: string): Promise<void> => {
    const nextConversationId = randomUUID()
    try {
      await api('resume-session', { conversationId: nextConversationId, id })
      socket.close()
      setMessages([])
      setSessionId(id)
      setConversationId(nextConversationId)
      setView('chat')
      setSidebarOpen(false)
    } catch (error) { fail(error) }
  }, [socket, fail])

  const forkSession = useCallback(async (upToTurn: number): Promise<void> => {
    if (!sessionId) return
    const nextConversationId = randomUUID()
    composerRef.current?.focus()
    setComposerFocus((current) => current + 1)
    try {
      const res = await api<{ id: string }>('fork-session', {
        conversationId: nextConversationId,
        sessionId,
        upToTurn,
      })
      socket.close()
      setMessages([])
      setSessionId(res.id)
      setConversationId(nextConversationId)
      setView('chat')
      setSidebarOpen(false)
      setNotice({ text: 'Branched into a new session.', error: false })
    } catch (error) { fail(error) }
  }, [sessionId, socket, fail])

  const handleAction = useCallback((actionId: string, messageId?: string) => {
    if (actionId.startsWith('resume:')) {
      void openSession(actionId.slice('resume:'.length))
      return
    }
    try {
      socket.send({ type: 'action', actionId, ...(messageId ? { messageId } : {}) })
    } catch (error) {
      fail(error)
    }
  }, [openSession, socket, fail])

  function handleSessionChange(id: string): void {
    setSessionId(id)
    socket.close()
    setMessages([])
    socket.connect(conversationId)
    setView('chat')
  }

  async function exportSession(id = sessionId): Promise<void> {
    if (!id) return
    try {
      const result = await api<{ path: string } | null>('export', { id, format: 'md' })
      setNotice(result
        ? { text: `Exported to ${result.path}`, error: false }
        : { text: 'Nothing to export yet — this session has no log.', error: true })
    } catch (error) { fail(error) }
  }

  async function deleteSession(id: string): Promise<void> {
    try {
      if (id === sessionId) {
        await newChat()
      }
      await api('session-delete', { id })
      setSessions((current) => current.filter((s) => s.id !== id))
      setNotice({ text: 'Session deleted.', error: false })
    } catch (error) { fail(error) }
  }

  async function renameSession(id: string, title: string): Promise<void> {
    try {
      await api('session-rename', { id, title })
      setSessions((current) => current.map((s) => s.id === id ? { ...s, title: title.trim() || undefined } : s))
      setNotice({ text: 'Session renamed.', error: false })
    } catch (error) { fail(error) }
  }

  const changeModel = useCallback(async (model: string): Promise<void> => {
    try {
      const result = await api<{ model: string }>('set-model', { model })
      setIdentity((current) => ({ ...current, model: result.model }))
      setNotice(null)
    } catch (error) { fail(error) }
  }, [fail])

  const changeEffort = useCallback(async (next: 'low' | 'medium' | 'high'): Promise<void> => {
    try {
      setEffort(next)
      await api('set-effort', { effort: next })
      setNotice(null)
    } catch (error) { fail(error) }
  }, [fail])

  const currentSession = sessions.find((session) => session.id === sessionId)
  const query = search.trim().toLowerCase()
  const visibleSessions = sessions
    .filter((session) => session.messageCount > 0)
    .filter((session) => `${session.title ?? ''} ${session.preview} ${session.id}`.toLowerCase().includes(query))
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const sessionGroups = groupSessions(visibleSessions)

  return <div className={`app-shell ${sidebarOpen ? 'drawer-open' : ''}`}>
    {/* The colour iOS 26 Safari reads for its own bars; see the `.chrome-tint`
        rules. They sit off screen and take no pointer. */}
    <div className="chrome-tint top" aria-hidden="true" />
    <div className="chrome-tint bottom" aria-hidden="true" />
    {sidebarOpen && <button className="sidebar-scrim" type="button" aria-label="Close menu" onClick={() => setSidebarOpen(false)} />}
    <aside className={`sidebar ${view === 'settings' ? 'settings-mode' : ''}`} aria-label="Main navigation">
      <div className="sidebar-chat-nav">
        <div className="brand-row"><img className="brand-mark" src={miloAvatar} alt="" /><span className="brand-name" translate="no">Milo</span></div>
        <div className="sidebar-pad">
          <button className={`sidebar-tab ${view === 'routines' ? 'active' : ''}`} type="button" onClick={() => { setView(view === 'routines' ? 'chat' : 'routines'); setSidebarOpen(false) }}><Icon name="repeat" size={16} /><span>Routines</span></button>
          <div className="sidebar-controls">
            <label className="sidebar-search"><Icon name="search" size={16} /><input aria-label="Search sessions" placeholder="Search sessions" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
            <button className="new-chat" type="button" title="New session (⌘K)" aria-label="New session" onClick={() => void newChat()}><Icon name="plus" size={18} /></button>
          </div>
        </div>
        <div className="session-region">
          <nav className="session-list" aria-label="Sessions" ref={sessionListRef} onScroll={updateListTop}>
            {sessionGroups.map((group) => <div className="session-group" key={group.label}><div className="section-label">{group.label}</div>{group.sessions.map((session) => <SessionRow key={session.id} session={session} active={session.id === sessionId} onClick={() => void openSession(session.id)} onRename={renameSession} onExport={exportSession} onDelete={deleteSession} />)}</div>)}
            {visibleSessions.length === 0 && <p className="list-empty">{search ? 'No sessions found.' : 'Your saved sessions show up here.'}</p>}
          </nav>
          <div className={`scroll-blur top ${listScrolled ? 'on' : ''}`} aria-hidden="true" />
        </div>
        <div className="sidebar-footer">
          <button className={`sidebar-action ${view === 'settings' ? 'active' : ''}`} type="button" onClick={() => { setView('settings'); setSidebarOpen(false) }}><Icon name="settings" /><span className="sidebar-action-text"><strong>Settings</strong><small>Models, keys and tools</small></span></button>
        </div>
      </div>
      <div className="sidebar-settings-nav">
        <div className="settings-nav-heading"><h2>Settings</h2><p>For this installation</p></div>
        <button className="settings-back" type="button" onClick={() => { setView('chat'); setSidebarOpen(false) }}><Icon name="arrow-left" /><span>Back to chat</span></button>
        <nav className="settings-nav" aria-label="Settings sections">
          {settingsSections.map(([id, icon, label]) => <button type="button" key={id} className={`settings-nav-item ${settingsSection === id ? 'active' : ''}`} onClick={() => { setSettingsSection(id); setSidebarOpen(false) }}><Icon name={icon} /><span>{label}</span></button>)}
        </nav>
      </div>
    </aside>

    <main className={`main ${view === 'settings' ? 'has-settings-strip' : ''}`}>
      <header className="topbar">
        <button className="mobile-menu" type="button" aria-label="Open menu" onClick={() => setSidebarOpen(true)}><Icon name="menu" /></button>
        {view === 'routines' && <button className="btn-secondary" type="button" onClick={() => setView('chat')}><span aria-hidden="true">←</span> Back to chat</button>}
        <div className="topbar-title"><h1>{view === 'settings' ? 'Settings' : view === 'routines' ? 'Routines' : currentSession ? sessionLabel(currentSession) : 'New session'}</h1></div>
        <div className="topbar-actions">
          {view === 'chat' && <button className="topbar-new" type="button" title="New session (⌘K)" aria-label="New session" onClick={() => void newChat()}><Icon name="plus" size={18} /></button>}
          {view === 'chat' && connection !== 'online' && <span className={`connection-status ${connection}`}><span />{connection === 'offline' ? 'Reconnecting…' : 'Connecting…'}</span>}
        </div>
      </header>
      {/* On a phone the sections ride in a strip under the topbar instead of the
          drawer, so switching costs one tap and the drawer keeps the sessions.
          The arrow leads back to the chat — where the sessions are — since the
          menu button stands down here. */}
      {view === 'settings' && <div className="settings-mobile-nav">
        <button className="settings-strip-back" type="button" aria-label="Back to chat" title="Back to chat" onClick={() => { setView('chat'); setSidebarOpen(false) }}><Icon name="arrow-left" size={17} /></button>
        <nav className="settings-section-strip" aria-label="Settings sections">
          {settingsSections.map(([id, icon, label]) => <button
            type="button"
            key={id}
            className={`settings-strip-item ${settingsSection === id ? 'active' : ''}`}
            aria-current={settingsSection === id ? 'true' : undefined}
            onClick={() => setSettingsSection(id)}
          ><Icon name={icon} size={15} /><span>{label}</span></button>)}
        </nav>
      </div>}
      {view === 'settings'
        ? <Settings section={settingsSection} conversationId={conversationId} sessionId={sessionId} onClose={() => setView('chat')} onSessionChange={handleSessionChange} theme={theme} onThemeChange={setTheme} />
        : view === 'routines'
        ? <Routines conversationId={conversationId} chat={{ messages, thinking, busy, connection, turnEnds, pendingPermission, send: askRoutine, decide }} />
        : <section className="chat-view">
          <div className="messages" id="messages" ref={messagesRef} onScroll={updateMessagesTop}>
            <MessageList messages={messages} thinking={thinking} busy={busy} onPrompt={send} onAction={handleAction} onFork={forkSession} />
            {pendingPermission && <article className="message assistant"><Permissions request={pendingPermission.request} expiresAt={pendingPermission.expiresAt} onDecision={(allowed) => socket.send({ type: 'control', action: allowed ? 'allow' : 'deny', id: pendingPermission.id })} /></article>}
          </div>
          <div className={`scroll-blur top ${chatScrolled ? 'on' : ''}`} aria-hidden="true" />
          {notice && <div className={`notice ${notice.error ? 'error' : 'success'}`} role="alert">{notice.text}<button className="icon-button" type="button" aria-label="Dismiss notice" onClick={() => setNotice(null)}><Icon name="x" size={15} /></button></div>}
          <Composer ref={composerRef} busy={busy} queued={queued} provider={identity.provider} model={identity.model} effort={effort} focusSignal={composerFocus} onSend={send} onStop={() => socket.send({ type: 'control', action: 'stop' })} onModelChange={(model) => void changeModel(model)} onEffortChange={(effort) => void changeEffort(effort)} />
        </section>}
    </main>
  </div>
}

function SessionRow({
  session,
  active,
  onClick,
  onRename,
  onExport,
  onDelete,
}: {
  session: SessionSummary
  active: boolean
  onClick(): void
  onRename(id: string, title: string): Promise<void>
  onExport(id: string): Promise<void>
  onDelete(id: string): Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [editTitle, setEditTitle] = useState(session.title ?? '')
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const onDocClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('click', onDocClick)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', onDocClick)
      window.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  const handleSaveRename = async () => {
    setEditing(false)
    if (editTitle.trim() !== (session.title ?? '')) {
      await onRename(session.id, editTitle.trim())
    }
  }

  return (
    <div className={`session-item ${active ? 'active' : ''} ${menuOpen ? 'menu-open' : ''}`}>
      {editing ? (
        <form
          className="session-rename-form"
          onSubmit={(e) => {
            e.preventDefault()
            void handleSaveRename()
          }}
        >
          <input
            className="session-rename-input"
            // biome-ignore lint/a11y/noAutofocus: intentional focus for inline rename
            autoFocus
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            onBlur={() => void handleSaveRename()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setEditing(false)
                setEditTitle(session.title ?? '')
              }
            }}
          />
        </form>
      ) : (
        <button className="session-row" type="button" onClick={onClick}>
          <span className="session-content">
            <span className="session-title">{sessionLabel(session)}</span>
            <span className="session-preview">{sessionMeta(session)}</span>
          </span>
        </button>
      )}

      <div className="session-row-actions" ref={menuRef}>
        <button
          className={`session-more-btn ${menuOpen ? 'open' : ''}`}
          type="button"
          title="Session actions"
          aria-label="Session actions"
          onClick={(e) => {
            e.stopPropagation()
            setMenuOpen((prev) => !prev)
          }}
        >
          <Icon name="dots" size={16} />
        </button>

        {menuOpen && (
          <div className="session-dropdown" role="menu">
            <button
              className="session-dropdown-item"
              type="button"
              role="menuitem"
              onClick={(e) => {
                e.stopPropagation()
                setMenuOpen(false)
                setEditTitle(session.title || session.preview || '')
                setEditing(true)
              }}
            >
              <Icon name="edit" size={16} />
              <span>Rename</span>
            </button>
            <button
              className="session-dropdown-item"
              type="button"
              role="menuitem"
              onClick={(e) => {
                e.stopPropagation()
                setMenuOpen(false)
                void onExport(session.id)
              }}
            >
              <Icon name="download" size={16} />
              <span>Export</span>
            </button>
            <button
              className="session-dropdown-item danger"
              type="button"
              role="menuitem"
              onClick={(e) => {
                e.stopPropagation()
                setMenuOpen(false)
                void onDelete(session.id)
              }}
            >
              <Icon name="trash" size={16} />
              <span>Delete</span>
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`
}

/**
 * The number a wait leaves behind on the message. The first one worth reporting
 * wins: it belongs to the tool call or the answer it led to, and it sits above
 * both, so a later wait replacing it would rewrite what the reader already read.
 * Under a second there is nothing to report — the terminal's own threshold.
 */
function thoughtMsFor(waited: number, message: ChatMessage): { thoughtMs?: number } {
  if (message.thoughtMs !== undefined || waited < 1000) return {}
  return { thoughtMs: waited }
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
