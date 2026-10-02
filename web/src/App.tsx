import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './lib/api.js'
import { randomUUID } from './lib/uuid.js'
import { MiloSocket, type ConnectionState } from './lib/ws.js'
import { Composer, type ComposerHandle } from './chat/Composer.js'
import { MessageList, type ChatMessage } from './chat/MessageList.js'
import { buildSuggestions } from './chat/suggestions.js'
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
/** A past turn the search box found, with the session it belongs to. */
type HistoryHit = { session: string; at: string; kind: string; text: string }
type Notice = { text: string; error: boolean }

type View = 'chat' | 'settings' | 'routines'

/** The address each screen lives at, so a link can be shared and Back works. */
const VIEW_PATH: Record<View, string> = { chat: '/', routines: '/routines', settings: '/settings' }

/** Which screen a path names; anything that is not one of them is the chat. */
function viewFromPath(pathname: string): View {
  const path = pathname.replace(/\/+$/, '') || '/'
  for (const [view, at] of Object.entries(VIEW_PATH) as Array<[View, string]>) {
    if (at === path) return view
  }
  return 'chat'
}

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
  /** What Milo keeps, for the cards the welcome screen draws; null until read. */
  const [notes, setNotes] = useState<{ text: string }[] | null>(null)
  /** Ideas the model drew for the empty home; null until they arrive. */
  const [ideas, setIdeas] = useState<{ title: string; prompt: string }[] | null>(null)
  /** How much the running model holds, for the context meter; null until read. */
  const [contextWindow, setContextWindow] = useState<number | null>(null)
  const [search, setSearch] = useState('')
  /** What the past turns said about the search, and null when nothing is searched. */
  const [historyHits, setHistoryHits] = useState<HistoryHit[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [queued, setQueued] = useState(0)
  const [pendingPermission, setPendingPermission] = useState<PendingPermission | null>(null)
  /** Counts finished turns: the routines screen re-reads its list when one ends. */
  const [turnEnds, setTurnEnds] = useState(0)
  /** Bumped when the server says a routine ran, so the history on screen re-reads. */
  const [routinesTick, setRoutinesTick] = useState(0)
  const [thinking, setThinking] = useState(true)
  const [effort, setEffort] = useState<'low' | 'medium' | 'high'>('medium')
  const [identity, setIdentity] = useState({ provider: 'milo', providerName: 'Milo', model: '' })
  const [connection, setConnection] = useState<ConnectionState>('connecting')
  const [view, setView] = useState<View>(() => viewFromPath(location.pathname))
  const [settingsSection, setSettingsSection] = useState('provider')
  /** Whether the settings hold edits that were never saved. */
  const [settingsDirty, setSettingsDirty] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  /** The desktop sidebar, folded away; the phone keeps its drawer instead. */
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('milo-sidebar') === 'collapsed')
  const [theme, setTheme] = useState(() => localStorage.getItem('milo-theme') ?? 'system')
  const [notice, setNotice] = useState<Notice | null>(null)
  /** Bumped to hand the cursor to the composer, e.g. once a new session opens. */
  const [composerFocus, setComposerFocus] = useState(0)
  const socket = useMemo(() => new MiloSocket(), [])
  const composerRef = useRef<ComposerHandle>(null)
  const messagesRef = useRef<HTMLDivElement>(null)
  /** Set when the person sends: their own message comes into view even from up here. */
  const followSend = useRef(false)
  /** Set when a session arrives, so opening one lands at its end, not its top. */
  const pinToEnd = useRef(false)
  /** The words a fork-and-resend owes: sent once the new session is connected. */
  const pendingSend = useRef<string | null>(null)
  /** Set when an edit is being written: the next send redoes from that turn. */
  const editingTurn = useRef<number | null>(null)
  /** The live `send`, for the frame handler, which is defined before it. */
  const sendRef = useRef<(text: string) => void>(() => {})
  /**
   * The tokens that have arrived since the last frame, by turn, and the frame that
   * will draw them. Gathering them here and drawing once a frame — rather than
   * once a token — is what keeps a fast answer from re-parsing and re-rendering
   * the whole thread on every one of its chunks.
   */
  const pendingDeltas = useRef(new Map<string, { text: string; reasoning: string }>())
  const drawFrame = useRef<number | null>(null)
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
  /** Whether the thread is at its end; when it is not, the way back shows. */
  const [atEnd, setAtEnd] = useState(true)
  const updateMessagesTop = useCallback((): void => {
    const el = messagesRef.current
    if (!el) return
    setChatScrolled(el.scrollTop > 2)
    setAtEnd(el.scrollHeight - el.scrollTop - el.clientHeight < 120)
  }, [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: recomputes when messages or view change
  useEffect(() => { updateMessagesTop() }, [updateMessagesTop, messages, view])
  useEffect(() => {
    window.addEventListener('resize', updateMessagesTop)
    return () => window.removeEventListener('resize', updateMessagesTop)
  }, [updateMessagesTop])

  /** The end of the thread, brought back into view rather than jumped to. */
  const jumpToEnd = useCallback((): void => {
    const el = messagesRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [])

  /** Hands the words picked out of a reply to the composer, quoted. */
  const quoteIntoComposer = useCallback((text: string): void => {
    composerRef.current?.insertQuote(text)
  }, [])

  const fail = useCallback((error: unknown): void => {
    setNotice({ text: error instanceof Error ? error.message : String(error), error: true })
  }, [])

  useEffect(() => {
    localStorage.setItem('milo-conversation', conversationId)
    localStorage.setItem('milo-sidebar', sidebarCollapsed ? 'collapsed' : 'open')
    if (theme === 'system') localStorage.removeItem('milo-theme')
    else localStorage.setItem('milo-theme', theme)
    const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    // The status bar and the toolbar take the app's own background: launched full
    // screen, the page would otherwise sit under a band of another colour. Read
    // from the token rather than repeated here, so the two cannot drift.
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--bg').trim())
  }, [conversationId, theme, sidebarCollapsed])

  // A notice is not a thing to keep: it says what just happened and then gets out
  // of the way. An error holds longer, since it is the one worth reading.
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), notice.error ? 9000 : 5000)
    return () => window.clearTimeout(timer)
  }, [notice])

  /**
   * The screen is in the address bar: a session, the routines and the settings are
   * each a place, so a link can be shared and the browser's own Back goes where it
   * says. Changing screen pushes a step; the Back button reads the path back.
   */
  useEffect(() => {
    if (location.pathname !== VIEW_PATH[view]) window.history.pushState(null, '', VIEW_PATH[view])
  }, [view])

  useEffect(() => {
    const fromPath = (): void => setView(viewFromPath(location.pathname))
    window.addEventListener('popstate', fromPath)
    return () => window.removeEventListener('popstate', fromPath)
  }, [])

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

  // What Milo keeps, read while the welcome screen is what is showing — the only
  // place the cards draw on it. A failure is quiet: the standing four still stand.
  useEffect(() => {
    if (messages.length > 0 || notes !== null) return
    let live = true
    void api<{ notes: { text: string }[] }>('memory-notes')
      .then((result) => { if (live) setNotes(result.notes) })
      .catch(() => { if (live) setNotes([]) })
    return () => { live = false }
  }, [messages.length, notes])

  // How much the running model holds. Read once per model; a lookup that fails is
  // no meter, not a broken chat, so the failure is quiet.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the model is the trigger, not a value read here — a new model is a new window
  useEffect(() => {
    let live = true
    void api<{ window?: number }>('context-window')
      .then((result) => { if (live) setContextWindow(result.window ?? null) })
      .catch(() => { if (live) setContextWindow(null) })
    return () => { live = false }
  }, [identity.model])

  // The log itself, searched a beat after typing stops: a word a tidied title
  // dropped is still findable here. Two characters is the shortest worth asking for.
  useEffect(() => {
    const query = search.trim()
    if (query.length < 2) { setHistoryHits(null); return }
    let live = true
    const timer = window.setTimeout(() => {
      void api<{ hits: HistoryHit[] }>('history-search', { query })
        .then((result) => { if (live) setHistoryHits(result.hits) })
        .catch(() => { if (live) setHistoryHits([]) })
    }, 250)
    return () => { live = false; window.clearTimeout(timer) }
  }, [search])

  /** Puts a message's own words back in the composer, to be changed and resent. */
  const editMessage = useCallback((text: string, upToTurn: number): void => {
    editingTurn.current = upToTurn
    composerRef.current?.load(text)
  }, [])

  /**
   * Asks again from an earlier point: the session is forked up to the turn before
   * the prompt, and the prompt goes out once the new session is the one the socket
   * speaks to — so the answer is written afresh with the old one gone.
   */
  const redo = useCallback(async (text: string, upToTurn: number): Promise<void> => {
    if (!sessionId) return
    const nextConversationId = randomUUID()
    pendingSend.current = text
    try {
      const res = await api<{ id: string }>('fork-session', { conversationId: nextConversationId, sessionId, upToTurn })
      socket.close()
      setMessages([])
      setSessionId(res.id)
      setConversationId(nextConversationId)
      setView('chat')
    } catch (error) {
      pendingSend.current = null
      fail(error)
    }
  }, [sessionId, socket, fail])

  const regenerate = useCallback((text: string, upToTurn: number): void => { void redo(text, upToTurn) }, [redo])

  const handleFrame = useCallback((frame: ServerFrame): void => {
    /**
     * Draws the deltas gathered since the last frame. A token ends the wait the
     * first time it arrives and closes the paragraph the tool line left open, so
     * those two moves happen here, once, when the batch lands.
     */
    const drawDeltas = (): void => {
      drawFrame.current = null
      const buffer = pendingDeltas.current
      if (buffer.size === 0) return
      pendingDeltas.current = new Map()
      setMessages((current) => current.map((message) => {
        const add = buffer.get(message.id)
        if (!add) return message
        let next = message
        if (add.text) {
          const waited = message.waitingSince ? Date.now() - message.waitingSince : 0
          const baseText = message.waitingSince && message.text ? closeParagraph(message.text) : message.text
          next = { ...next, text: baseText + add.text, waitingSince: undefined, ...(thoughtMsFor(waited, message)) }
        }
        if (add.reasoning) next = { ...next, reasoning: (next.reasoning ?? '') + add.reasoning }
        return next
      }))
    }
    // Anything that is not a token is drawn in order: the text that led to it
    // lands first, so a tool line never overtakes the words before it.
    if (!(frame.type === 'event' && (frame.event.type === 'text-delta' || frame.event.type === 'reasoning-delta'))) drawDeltas()

    if (frame.type === 'ready') {
      setConnection('online')
      setSessionId(frame.sessionId)
      setThinking(frame.thinking === 'on')
      if (frame.effort) setEffort(frame.effort)
      setIdentity({ provider: frame.provider, providerName: frame.providerName, model: frame.model })
      // A session opens at its end, where the conversation is — the whole thread
      // is here at once, so there is no "scrolled there" to respect.
      pinToEnd.current = true
      setMessages(frame.messages.map((message, index) => ({ ...message, id: `loaded-${index}`, loaded: true })))
      // A redo forks the session and owes the words: they go out now that the new
      // session is the one this socket is speaking to.
      if (pendingSend.current !== null) {
        const owed = pendingSend.current
        pendingSend.current = null
        sendRef.current(owed)
      }
      return
    }
    if (frame.type === 'error') { setNotice({ text: frame.message, error: true }); return }
    if (frame.type === 'routines-changed') { setRoutinesTick((current) => current + 1); return }
    if (frame.type === 'suggestions') { setIdeas(frame.items); return }
    if (frame.type === 'state') { setBusy(frame.busy); setQueued(frame.queued); return }
    if (frame.type === 'turn-start') {
      // The wait starts here and the turn says so on screen: the assistant
      // message carries it, so the line appears where the reply will.
      setMessages((current) => [...current, { id: `user-${frame.id}`, role: 'user', text: frame.text }, { id: frame.id, role: 'assistant', text: '', waitingSince: Date.now() }])
      setBusy(true)
      return
    }
    if (frame.type === 'event') {
      const event = frame.event
      if (event.type === 'text-delta' || event.type === 'reasoning-delta') {
        const buffered = pendingDeltas.current.get(frame.turnId) ?? { text: '', reasoning: '' }
        if (event.type === 'text-delta') buffered.text += event.delta
        else buffered.reasoning += event.delta
        pendingDeltas.current.set(frame.turnId, buffered)
        if (drawFrame.current === null) drawFrame.current = requestAnimationFrame(drawDeltas)
        return
      }
      setMessages((current) => current.map((message) => {
        if (message.id !== frame.turnId) return message
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
        if (event.type === 'usage') return { ...message, tokens: { input: event.inputTokens, output: event.outputTokens } }
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
    editingTurn.current = null
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
    // A session that just opened has no scroll position to respect: it lands at
    // its end, in one go, rather than at the top of however long it has grown.
    if (pinToEnd.current) {
      pinToEnd.current = false
      container.scrollTop = container.scrollHeight
      return
    }
    // Reading back through the thread is respected: a turn that arrives while the
    // person is up there does not yank them down. Sending is the exception, since
    // the message they just wrote is the thing they are looking for.
    const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 120
    if (nearBottom || followSend.current) {
      followSend.current = false
      container.scrollTop = container.scrollHeight
    }
  }, [messages, pendingPermission])

  /**
   * The thread stays pinned to its own end. The effect above only runs when the
   * messages change, and the height of the box changes after that — the keyboard
   * settling, the composer growing with what is typed — which is what left the
   * last message below the fold until the person scrolled it up themselves.
   */
  useEffect(() => {
    const container = messagesRef.current
    if (!container) return
    const observer = new ResizeObserver(() => {
      const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 120
      if (nearBottom || followSend.current) container.scrollTop = container.scrollHeight
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  useEffect(() => () => {
    if (drawFrame.current !== null) cancelAnimationFrame(drawFrame.current)
  }, [])

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
  const send = useCallback((text: string, intent: 'queue' | 'steer' = 'queue', target?: SendTarget): void => {
    // An edit is a redo from the turn it was made on: the words go again with the
    // session forked to before them, rather than a second copy piling on top.
    if (editingTurn.current !== null) {
      const upToTurn = editingTurn.current
      editingTurn.current = null
      void redo(text, upToTurn)
      return
    }
    followSend.current = true
    try {
      if (text.startsWith('/')) {
        setMessages((current) => [...current, { id: `user-${randomUUID()}`, role: 'user', text }])
        socket.send({ type: 'command', text })
      }
      else socket.send({ type: 'send', text, intent, ...(target ? { target } : {}) })
      setNotice(null)
    } catch (error) { fail(error) }
  }, [socket, fail, redo])

  useEffect(() => { sendRef.current = send }, [send])

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
    editingTurn.current = null
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
    editingTurn.current = null
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
    editingTurn.current = null
    setSessionId(id)
    socket.close()
    setMessages([])
    socket.connect(conversationId)
    setView('chat')
  }

  /** Leaving the settings, which asks first when edits would be thrown away. */
  const leaveSettings = useCallback((): void => {
    if (settingsDirty && !window.confirm('Discard unsaved settings changes?')) return
    setView('chat')
    setSidebarOpen(false)
  }, [settingsDirty])

  const noteDirty = useCallback((dirty: boolean): void => { setSettingsDirty(dirty) }, [])

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
  const suggestions = useMemo(
    () => buildSuggestions({ sessions, notes, ideas, currentId: sessionId }),
    [sessions, notes, ideas, sessionId],
  )
  // The size of what the model last read is the size of the conversation, which is
  // what the meter measures against the window.
  const contextUsed = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const tokens = messages[index]!.tokens
      if (tokens) return tokens.input
    }
    return 0
  }, [messages])

  return <div className={`app-shell ${sidebarOpen ? 'drawer-open' : ''} ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
    {/* The colour iOS 26 Safari reads for its own bars; see the `.chrome-tint`
        rules. They sit off screen and take no pointer. */}
    <div className="chrome-tint top" aria-hidden="true" />
    <div className="chrome-tint bottom" aria-hidden="true" />
    {sidebarOpen && <button className="sidebar-scrim" type="button" aria-label="Close menu" onClick={() => setSidebarOpen(false)} />}
    <aside className={`sidebar ${view === 'settings' ? 'settings-mode' : ''}`} aria-label="Main navigation">
      <div className="sidebar-chat-nav">
        <div className="brand-row"><img className="brand-mark" src={miloAvatar} alt="" /><span className="brand-name" translate="no">Milo</span><button className="sidebar-toggle" type="button" aria-label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'} title={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'} aria-pressed={sidebarCollapsed} onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}><Icon name="panel-left" size={17} /></button></div>
        <div className="sidebar-pad">
          <button className={`sidebar-tab ${view === 'routines' ? 'active' : ''}`} type="button" onClick={() => { setView(view === 'routines' ? 'chat' : 'routines'); setSidebarOpen(false) }}><Icon name="repeat" size={16} /><span>Routines</span></button>
          <div className="sidebar-controls">
            <label className="sidebar-search"><Icon name="search" size={16} /><input aria-label="Search sessions" placeholder="Search sessions" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
            <button className="new-chat" type="button" title="New session (⌘K)" aria-label="New session" onClick={() => void newChat()}><Icon name="plus" size={18} /></button>
          </div>
        </div>
        <div className="session-region">
          <nav className="session-list" aria-label="Sessions" ref={sessionListRef} onScroll={updateListTop}>
            {historyHits && historyHits.length > 0 && <div className="history-hits">
              <div className="section-label">In past turns</div>
              {historyHits.map((hit) => <button className="history-hit" key={`${hit.session}-${hit.at}-${hit.text.slice(0, 32)}`} type="button" title={hit.session} onClick={() => void openSession(hit.session)}>
                <span className="history-hit-text">{hit.text || `${hit.kind} turn`}</span>
                <span className="history-hit-where">{hit.kind} · {hit.session}</span>
              </button>)}
            </div>}
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
        <button className="settings-back" type="button" onClick={leaveSettings}><Icon name="arrow-left" /><span>Back to chat</span></button>
        <nav className="settings-nav" aria-label="Settings sections">
          {settingsSections.map(([id, icon, label]) => <button type="button" key={id} className={`settings-nav-item ${settingsSection === id ? 'active' : ''}`} onClick={() => { setSettingsSection(id); setSidebarOpen(false) }}><Icon name={icon} /><span>{label}</span></button>)}
        </nav>
      </div>
    </aside>

    <main className={`main ${view === 'settings' ? 'has-settings-strip' : ''}`}>
      <header className="topbar">
        <button className="mobile-menu" type="button" aria-label="Open menu" onClick={() => setSidebarOpen(true)}><Icon name="menu" /></button>
        <button className="sidebar-expand" type="button" aria-label="Show sidebar" title="Show sidebar" onClick={() => setSidebarCollapsed(false)}><Icon name="panel-left" size={17} /></button>
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
        <button className="settings-strip-back" type="button" aria-label="Back to chat" title="Back to chat" onClick={leaveSettings}><Icon name="arrow-left" size={17} /></button>
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
        ? <Settings section={settingsSection} conversationId={conversationId} sessionId={sessionId} onClose={leaveSettings} onSessionChange={handleSessionChange} theme={theme} onThemeChange={setTheme} onDirtyChange={noteDirty} />
        : view === 'routines'
        ? <Routines conversationId={conversationId} tick={routinesTick} chat={{ messages, thinking, busy, connection, turnEnds, pendingPermission, send: askRoutine, decide }} />
        : <section className="chat-view">
          <div className="messages" id="messages" ref={messagesRef} onScroll={updateMessagesTop}>
            <MessageList messages={messages} thinking={thinking} busy={busy} onPrompt={send} onAction={handleAction} onFork={forkSession} onQuote={quoteIntoComposer} onEdit={editMessage} onRegenerate={regenerate} suggestions={suggestions} />
            {pendingPermission && <article className="message assistant"><Permissions request={pendingPermission.request} expiresAt={pendingPermission.expiresAt} onDecision={(allowed) => socket.send({ type: 'control', action: allowed ? 'allow' : 'deny', id: pendingPermission.id })} /></article>}
          </div>
          <div className={`scroll-blur top ${chatScrolled ? 'on' : ''}`} aria-hidden="true" />
          {notice && <div className={`notice ${notice.error ? 'error' : 'success'}`} role="alert">{notice.text}<button className="icon-button" type="button" aria-label="Dismiss notice" onClick={() => setNotice(null)}><Icon name="x" size={15} /></button></div>}
          <div className="composer-dock">
            {messages.length > 0 && <button className={`jump-latest ${atEnd ? '' : 'on'}`} type="button" title="Go to the latest" aria-label="Go to the latest" onClick={jumpToEnd}><Icon name="arrow-down" size={17} /></button>}
            <Composer ref={composerRef} busy={busy} queued={queued} provider={identity.provider} providerName={identity.providerName} draftKey={conversationId} model={identity.model} context={contextWindow && contextUsed > 0 ? { used: contextUsed, window: contextWindow } : undefined} effort={effort} focusSignal={composerFocus} onSend={send} onStop={() => socket.send({ type: 'control', action: 'stop' })} onModelChange={(model) => void changeModel(model)} onEffortChange={(effort) => void changeEffort(effort)} />
          </div>
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
