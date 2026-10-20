import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, uploadFile, withToken } from './lib/api.js'
import { copyText } from './lib/clipboard.js'
import { isPhone, usePhone } from './lib/phone.js'
import { randomUUID } from './lib/uuid.js'
import { trackVisualViewport } from './lib/viewport.js'
import { MiloSocket, type ConnectionStatus } from './lib/ws.js'
import { Composer, type ComposerHandle } from './chat/Composer.js'
import { MessageList, type ChatMessage } from './chat/MessageList.js'
import { appendDeltas, withDelta, withWidget, type PendingDelta } from './chat/parts.js'
import { buildSuggestions } from './chat/suggestions.js'
import { Permissions } from './chat/Permissions.js'
import { Routines } from './routines/Routines.js'
import { TaskLists } from './tasks/TaskLists.js'
import { Work } from './work/Work.js'
import { Email } from './email/Email.js'
import { Settings } from './settings/Settings.js'
import { settingsSectionFromPath } from './settings/sections.js'
import { Panel } from './panel/Panel.js'
import type { ServerFrame, PermissionRequest, PanelInput, PanelView, JobView, SendTarget, ThinkingDisplay, TranscriptPart } from '@protocol'
import { drawsToolFailure, toolText } from '../../src/gateways/tool-line.ts'
import { describeCompaction, describeRebase } from '../../src/core/sessions/format.ts'
import { SessionRow, sessionLabel, type SessionSummary } from './sessions/SessionRow.js'
import { Icon } from './ui/Icons.js'
import { Notice, useAutoDismiss, type Report } from './ui/Notice.js'
import { miloAvatar } from './ui/milo.js'
import { projectMark } from './work/marks.js'

type PendingPermission = { id: string; request: PermissionRequest; expiresAt: number }
type SessionGroup = { label: string; sessions: SessionSummary[] }
/** A project as the wire carries it: what it is called, where it is, and why it cannot be
 *  worked in when it cannot. */
type Project = { id: string; name: string; path: string; icon?: string; error?: string }
/** A past turn the search box found, with the session it belongs to. */
type HistoryHit = { session: string; at: string; kind: string; text: string }

type View = 'chat' | 'settings' | 'routines' | 'tasks' | 'work' | 'email'

/** The address each screen lives at, so a link can be shared and Back works. */
const VIEW_PATH: Record<View, string> = { chat: '/', routines: '/routines', tasks: '/tasks', work: '/work', email: '/email', settings: '/settings' }

/** Which screen a path names; anything that is not one of them is the chat. */
function viewFromPath(pathname: string): View {
  const path = pathname.replace(/\/+$/, '') || '/'
  if (path === VIEW_PATH.settings || settingsSectionFromPath(path)) return 'settings'
  if (path === VIEW_PATH.email || path.startsWith(`${VIEW_PATH.email}/`)) return 'email'
  for (const [view, at] of Object.entries(VIEW_PATH) as Array<[View, string]>) {
    if (at === path) return view
  }
  return 'chat'
}

/**
 * What the Email screen is showing, from its own path: null is the inbox, `new`
 * the composer, anything else a thread id. It lives in the address bar so the
 * browser's Back leaves a thread for the inbox instead of leaving the app.
 */
function emailRouteFromPath(pathname: string): string | null {
  const path = pathname.replace(/\/+$/, '') || '/'
  if (path === VIEW_PATH.email) return null
  const match = /^\/email\/(.+)$/.exec(path)
  return match ? decodeURIComponent(match[1]!) : null
}

export default function App() {
  const [chatId, setChatId] = useState(
    () => localStorage.getItem('milo-chat') || localStorage.getItem('milo-conversation') || randomUUID(),
  )
  const [sessionId, setSessionId] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  /** The project this session works in, as the server resolved it for this connection. */
  const [project, setProject] = useState<Project | null>(null)
  /** Ideas the model drew for the empty home; null until they arrive. */
  const [ideas, setIdeas] = useState<{ title: string; prompt: string }[] | null>(null)
  /** The budget the request is measured against, for the meter; null until read. */
  const [contextBudget, setContextBudget] = useState<number | null>(null)
  const [search, setSearch] = useState('')
  /** What the past turns said about the search, and null when nothing is searched. */
  const [historyHits, setHistoryHits] = useState<HistoryHit[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [queued, setQueued] = useState(0)
  /** Whether this session's turns are proposing rather than working. */
  const [plan, setPlan] = useState(false)
  /**
   * How many messages there were when plan mode went on. The approval belongs to the
   * turn that ran *under* the plan, not to whatever the thread said before it.
   */
  const [planSince, setPlanSince] = useState(0)
  const [pendingPermission, setPendingPermission] = useState<PendingPermission | null>(null)
  /** Counts finished turns: the routines screen re-reads its list when one ends. */
  const [turnEnds, setTurnEnds] = useState(0)
  /**
   * Counts the times the daemon said to re-read a folder: a session anywhere in the install
   * beginning or ending a turn, or a step in one that may have changed what is on disk. The
   * Work screen re-reads a folder's tree, changes and rules on it — the same signal that
   * moves the running dot beside a session, and the same news from the one place every turn
   * goes through.
   */
  const [workTick, setWorkTick] = useState(0)
  /** Bumped when the server says a routine ran, so the history on screen re-reads. */
  const [routinesTick, setRoutinesTick] = useState(0)
  const [thinking, setThinking] = useState<ThinkingDisplay>('expanded')
  const [effort, setEffort] = useState<'low' | 'medium' | 'high'>('medium')
  const [identity, setIdentity] = useState({ provider: 'milo', providerName: 'Milo', model: '' })
  const [connection, setConnection] = useState<ConnectionStatus>({ state: 'connecting' })
  const [view, setViewRaw] = useState<View>(() => viewFromPath(location.pathname))
  /** The Email screen's place within its own path: null inbox, `new` compose, else a thread. */
  const [emailRoute, setEmailRoute] = useState<string | null>(() => emailRouteFromPath(location.pathname))
  /** Mail that arrived since the person last looked at the inbox, for the Email tab's badge. */
  const [mailUnread, setMailUnread] = useState<{ count: number; more: boolean } | null>(null)
  /** The section open in Settings; null is the index of them, which a phone shows first. */
  const [settingsSection, setSettingsSection] = useState<string | null>(() => settingsSectionFromPath(location.pathname))
  /** Whether the settings hold edits that were never saved. */
  const [settingsDirty, setSettingsDirty] = useState(false)
  /** Changes screen, asking first when leaving Settings would throw away edits. */
  const setView = useCallback((next: View): void => {
    if (view === 'settings' && next !== 'settings' && settingsDirty && !window.confirm('Discard unsaved settings changes?')) return
    setViewRaw(next)
  }, [view, settingsDirty])
  const [sidebarOpen, setSidebarOpen] = useState(false)
  /** The phone's session search, folded behind its own icon until it is asked for. */
  const [searchOpen, setSearchOpen] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  /** The desktop sidebar, folded away; the phone keeps its drawer instead. */
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('milo-sidebar') === 'collapsed')
  /**
   * The panel beside the chat: the tabs Milo opened, and whether it is folded away.
   * The tabs are session state and always come back. Whether the column is out is
   * the person's own choice, so it starts folded — Milo showing something reveals
   * the panel for the sitting, it does not decide that it is open every time this
   * chat is opened.
   */
  const [panel, setPanel] = useState<PanelView | null>(null)
  /** The background jobs still running, for the strip above the composer. */
  const [jobs, setJobs] = useState<JobView[]>([])
  const [panelOpen, setPanelOpen] = useState(() => localStorage.getItem('milo-panel') === 'open')
  const [theme, setTheme] = useState(() => localStorage.getItem('milo-theme') ?? 'system')
  const [notice, setNotice] = useState<Notice | null>(null)
  useAutoDismiss(notice, setNotice)
  /** Bumped to hand the cursor to the composer, e.g. once a new session opens. */
  const [composerFocus, setComposerFocus] = useState(0)
  const socket = useMemo(() => new MiloSocket(), [])
  const composerRef = useRef<ComposerHandle>(null)
  const messagesRef = useRef<HTMLDivElement>(null)
  /** The dock the composer sits in, measured so the phone's thread can clear it. */
  const composerDockRef = useRef<HTMLDivElement>(null)
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
  const pendingDeltas = useRef(new Map<string, PendingDelta[]>())
  const drawFrame = useRef<number | null>(null)

  /** Whether what is showing is a phone's layout; the composer's dock reads it. */
  const phone = usePhone()
  /** Whether the thread is at its end; when it is not, the way back shows. */
  const [atEnd, setAtEnd] = useState(true)
  /** What scrolls the thread: its own box on a wide screen, the page on a phone. */
  const threadScroller = useCallback((): HTMLElement | null => (
    isPhone() ? document.scrollingElement as HTMLElement | null : messagesRef.current
  ), [])
  const updateMessagesTop = useCallback((): void => {
    const el = threadScroller()
    if (!el) return
    setAtEnd(el.scrollHeight - el.scrollTop - el.clientHeight < 120)
  }, [threadScroller])
  // biome-ignore lint/correctness/useExhaustiveDependencies: recomputes when messages or view change
  useEffect(() => { updateMessagesTop() }, [updateMessagesTop, messages, view])
  useEffect(() => {
    // The element's own `scroll` covers a wide screen; the window's covers a phone,
    // where the page is the scroller. Each is inert on the other.
    window.addEventListener('resize', updateMessagesTop)
    window.addEventListener('scroll', updateMessagesTop)
    return () => {
      window.removeEventListener('resize', updateMessagesTop)
      window.removeEventListener('scroll', updateMessagesTop)
    }
  }, [updateMessagesTop])

  /**
   * The sidebar's mail badge: unread that arrived since the inbox was last looked
   * at. Asked for on load and on a slow interval — so a mail that lands while the
   * app is open appears without a reload — and again when the tab regains focus.
   */
  const refreshMailUnread = useCallback((): void => {
    void api<{ count: number; more: boolean }>('email-unread')
      .then(setMailUnread)
      // A background count that fails leaves the last one standing rather than
      // raising a notice once a minute.
      .catch(() => {})
  }, [])

  useEffect(() => {
    refreshMailUnread()
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') refreshMailUnread()
    }, 60_000)
    window.addEventListener('focus', refreshMailUnread)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', refreshMailUnread)
    }
  }, [refreshMailUnread])

  /** Looking at the inbox is what clears the badge; the write itself is server-side. */
  const clearMailBadge = useCallback((): void => setMailUnread({ count: 0, more: false }), [])

  // The search the phone folded behind its icon takes the cursor the moment it opens.
  useEffect(() => {
    if (searchOpen) searchRef.current?.focus()
  }, [searchOpen])

  /** Puts that search away, and clears it so the list it narrowed is whole again. */
  function closeSearch(): void {
    setSearchOpen(false)
    setSearch('')
  }

  // The shell is the phone's visible area, so the keyboard never leaves the
  // composer stranded above a gap once it closes; see `trackVisualViewport`.
  useEffect(() => trackVisualViewport(), [])

  // A phone scrolls the page (see `styles.css`), so an open overlay has to lock it,
  // or the thread slides behind the drawer while it is showing.
  useEffect(() => {
    document.documentElement.classList.toggle('overlay-lock', isPhone() && (sidebarOpen || (view === 'chat' && panelOpen)))
  }, [sidebarOpen, view, panelOpen])

  /** The end of the thread, brought back into view rather than jumped to. */
  const jumpToEnd = useCallback((): void => {
    const el = threadScroller()
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [threadScroller])

  /** Hands the words picked out of a reply to the composer, quoted. */
  const quoteIntoComposer = useCallback((text: string): void => {
    composerRef.current?.insertQuote(text)
  }, [])

  const fail = useCallback((error: unknown, report: Report = setNotice): void => {
    report({ text: error instanceof Error ? error.message : String(error), error: true })
  }, [])

  useEffect(() => {
    localStorage.setItem('milo-chat', chatId)
    localStorage.removeItem('milo-conversation')
    localStorage.setItem('milo-sidebar', sidebarCollapsed ? 'collapsed' : 'open')
    if (theme === 'system') localStorage.removeItem('milo-theme')
    else localStorage.setItem('milo-theme', theme)
  }, [chatId, theme, sidebarCollapsed])

  // The theme goes on the document as the app paints, and the phone's own bars take
  // its colour: the explicit choice and a system flip both land here. The `theme-color`
  // metas are re-created rather than edited — Safari reads that tag as it appears, so
  // editing the one already in the head changes nothing until a reload.
  useEffect(() => {
    const root = document.documentElement
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (): void => {
      root.dataset.theme = theme === 'dark' || (theme === 'system' && media.matches) ? 'dark' : 'light'
      const chrome = getComputedStyle(root).getPropertyValue('--bg').trim()
      // A phone says nothing here on purpose: the tag is what fills Safari's own bar
      // with a solid colour, and what makes a Home Screen app's bar translucent over
      // the page is its own key in the markup (`black-translucent`). A colour declared
      // here could only ever answer one of the two themes. A wide screen's browser is
      // not what the bar question was ever about.
      const solid = !isPhone()
      document.querySelectorAll('meta[name=theme-color]').forEach((meta) => {
        meta.remove()
        if (!solid) return
        meta.setAttribute('content', chrome)
        document.head.append(meta)
      })
    }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme])

  /**
   * The screen is in the address bar: a session, the routines, and each settings
   * section are a place of their own (`/settings/display`), so a link can be
   * shared and the browser's own Back goes where it says. Changing screen or
   * section pushes a step; the Back button reads the path back.
   */
  useEffect(() => {
    const target = view === 'settings'
      ? settingsSection ? `/settings/${settingsSection}` : VIEW_PATH.settings
      : view === 'email' && emailRoute
        ? `${VIEW_PATH.email}/${encodeURIComponent(emailRoute)}`
        : VIEW_PATH[view]
    if (location.pathname === target) return
    // The token rides on every address the app writes, so moving between screens
    // never drops it: an icon added from any of them has to carry it home.
    const address = withToken(target)
    window.history.pushState(null, '', address)
  }, [view, settingsSection, emailRoute])

  useEffect(() => {
    const fromPath = (): void => {
      setViewRaw(viewFromPath(location.pathname))
      setSettingsSection(settingsSectionFromPath(location.pathname))
      setEmailRoute(emailRouteFromPath(location.pathname))
    }
    window.addEventListener('popstate', fromPath)
    return () => window.removeEventListener('popstate', fromPath)
  }, [])

  const refreshSessions = useCallback(async (): Promise<void> => {
    try { setSessions(await api<SessionSummary[]>('sessions')) }
    catch (error) { fail(error) }
  }, [fail])

  // The budget the request is measured against — the window times the share that
  // makes Milo fold — read once per model. Same rule the core folds by, so the
  // ring fills at the point the oldest turns actually go. A lookup that fails is
  // no meter, not a broken chat, so the failure is quiet.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the model is the trigger, not a value read here — a new model is a new budget
  useEffect(() => {
    let live = true
    void api<{ budget?: number }>('context-budget')
      .then((result) => { if (live) setContextBudget(result.budget ?? null) })
      .catch(() => { if (live) setContextBudget(null) })
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
    const nextChatId = randomUUID()
    pendingSend.current = text
    try {
      const res = await api<{ id: string }>('fork-session', { chatId: nextChatId, sessionId, upToTurn })
      socket.close()
      setMessages([])
      setPanel(null)
      setProject(null)
      setSessionId(res.id)
      setChatId(nextChatId)
      setView('chat')
    } catch (error) {
      pendingSend.current = null
      fail(error)
    }
  }, [sessionId, socket, fail, setView])

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
        // A batch is drawn in the order its tokens arrived: the thought that was
        // still arriving when the answer began stays above it rather than splitting
        // the paragraph it was written before.
        const wrote = add.some((token) => token.kind === 'text')
        const waited = wrote && message.waitingSince ? Date.now() - message.waitingSince : 0
        return {
          ...message,
          parts: appendDeltas(message.parts, add),
          ...(wrote ? { waitingSince: undefined, ...thoughtMsFor(waited, message) } : {}),
        }
      }))
    }
    // Anything that is not a token is drawn in order: the text that led to it
    // lands first, so a tool line never overtakes the words before it.
    if (!(frame.type === 'event' && (frame.event.type === 'text-delta' || frame.event.type === 'reasoning-delta'))) drawDeltas()

    if (frame.type === 'ready') {
      // A reconnect starts fresh from the server's transcript. Deltas buffered
      // from before the drop would interleave with the new turn, and a busy flag
      // left over from it would keep the controls locked; the server re-sends its
      // own `state` if it is in fact still working.
      if (drawFrame.current !== null) {
        cancelAnimationFrame(drawFrame.current)
        drawFrame.current = null
      }
      pendingDeltas.current = new Map()
      setBusy(false)
      setQueued(0)
      setConnection({ state: 'online' })
      setSessionId(frame.sessionId)
      setThinking(frame.thinking)
      if (frame.effort) setEffort(frame.effort)
      setIdentity({ provider: frame.provider, providerName: frame.providerName, model: frame.model })
      // What the panel was left showing, resolved by the server from the session's
      // own history, so a reload comes back to the same view.
      setPanel(frame.panel ?? null)
      setProject(frame.project ?? null)
      setPlan(frame.plan ?? false)
      // A reload joins the plan where it stands; a new proposal is what earns approval.
      setPlanSince(frame.messages.length)
      setJobs(frame.jobs ?? [])
      // A session opens at its end, where the conversation is — the whole thread
      // is here at once, so there is no "scrolled there" to respect.
      pinToEnd.current = true
      const opened: ChatMessage[] = frame.messages.map((message, index) => ({ ...message, id: `loaded-${index}`, loaded: true }))
      // A turn that is still running: this page was not here for its `turn-start`,
      // and the daemon writes a session a step at a time, so the answer being written
      // is in neither the transcript below nor a frame this page ever saw. The row is
      // opened under the id it is drawn with, and the events it has already said
      // arrive right behind this frame and land in it.
      if (frame.activeTurn) {
        opened.push({ id: frame.activeTurn.id, role: 'assistant', parts: [], at: frame.activeTurn.at, waitingSince: Date.now() })
      }
      setMessages(opened)
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
    // The switch belongs to the session, so a sibling tab moved it too. Turning it
    // off retires the proposal with it; turning it on waits for a turn to propose.
    if (frame.type === 'plan') {
      setPlan(frame.plan)
      if (!frame.plan) setPlanSince(0)
      return
    }
    if (frame.type === 'routines-changed') { setRoutinesTick((current) => current + 1); return }
    // A session started or stopped a turn anywhere in the install: the running dot is
    // re-read off the daemon rather than guessed at here.
    if (frame.type === 'sessions-changed') { setWorkTick((current) => current + 1); void refreshSessions(); return }
    // A step somewhere may have changed what is on disk. The Work screen re-reads the folder
    // it is showing — and only it: the rest of the app has nothing to re-read, and the tick
    // reaches nothing else.
    if (frame.type === 'work-changed') { setWorkTick((current) => current + 1); return }
    if (frame.type === 'panel') {
      // Milo shows something and the panel opens itself — that is the "here, look
      // at this". A resolved `null` is the model taking it down.
      setPanel(frame.panel)
      if (frame.panel) setPanelOpen(true)
      return
    }
    if (frame.type === 'suggestions') { setIdeas(frame.items); return }
    if (frame.type === 'state') { setBusy(frame.busy); setQueued(frame.queued); return }
    if (frame.type === 'jobs') { setJobs(frame.jobs); return }
    if (frame.type === 'turn-start') {
      // The wait starts here and the turn says so on screen: the assistant
      // message carries it, so the line appears where the reply will.
      const now = Date.now()
      setMessages((current) => [...current, { id: `user-${frame.id}`, role: 'user', parts: [{ kind: 'text', text: frame.text }], at: now }, { id: frame.id, role: 'assistant', parts: [], waitingSince: now, at: now }])
      setBusy(true)
      return
    }
    if (frame.type === 'event') {
      const event = frame.event
      if (event.type === 'text-delta' || event.type === 'reasoning-delta') {
        const buffered = pendingDeltas.current.get(frame.turnId) ?? []
        const kind = event.type === 'text-delta' ? 'text' : 'reasoning'
        pendingDeltas.current.set(frame.turnId, withDelta(buffered, kind, event.delta))
        if (drawFrame.current === null) drawFrame.current = requestAnimationFrame(drawDeltas)
        return
      }
      setMessages((current) => current.map((message) => {
        if (message.id !== frame.turnId) return message
        if (event.type === 'tool-start') {
          // Reasoning deltas do not end a wait — they are what fills it. A tool
          // call is an output of its own, and the wait before it was thinking.
          const waited = message.waitingSince ? Date.now() - message.waitingSince : 0
          return { ...message, parts: [...message.parts, { kind: 'tool', tool: { name: event.name, text: toolText(event.name, event.args), state: 'running' } }], waitingSince: undefined, ...(thoughtMsFor(waited, message)) }
        }
        if (event.type === 'tool-end') {
          // The result is in: the model is thinking again about what to do with it.
          // The call that just ended is the one still marked running, which is how the
          // line knows to stop saying it is underway — no second source of truth for
          // what is running, and no name matched against names that repeat.
          // The result rides the same part, for the detail under the line; the server
          // sends it empty below the `full` level, so an empty one draws nothing.
          const result = event.result ? { result: event.result } : {}
          let running = -1
          for (let index = message.parts.length - 1; index >= 0; index -= 1) {
            const part = message.parts[index]
            if (part?.kind === 'tool' && part.tool.state === 'running') { running = index; break }
          }
          const parts: TranscriptPart[] = running === -1
            // A call whose own line is not drawn — the plan, a widget — still has a
            // failure worth saying, unless it is a tool that is not one any more.
            // Nothing goes wrong in silence.
            ? event.isError && drawsToolFailure(event.name)
              ? [...message.parts, { kind: 'tool', tool: { name: event.name, text: toolText(event.name), state: 'failed', ...result } }]
              : message.parts
            : message.parts.map((part, index): TranscriptPart => index === running && part.kind === 'tool'
              ? { ...part, tool: { ...part.tool, state: event.isError ? 'failed' : 'done', ...result } }
              : part)
          return { ...message, parts, waitingSince: Date.now() }
        }
        if (event.type === 'todo') return event.items.length > 0
          ? { ...message, parts: [...message.parts, { kind: 'todo', items: event.items }] }
          : message
        if (event.type === 'verification') {
          return { ...message, parts: [...message.parts, { kind: 'verification', ok: event.ok, text: event.text }] }
        }
        if (event.type === 'ui') {
          // A widget arrives as the model writes it: each draft takes the place of the
          // one before it, and the closed block takes the place of the last draft.
          const part: TranscriptPart = { kind: 'ui', render: event.render, ...(event.draft ? { draft: true } : {}) }
          return { ...message, parts: withWidget(message.parts, part) }
        }
        if (event.type === 'waiting') return { ...message, status: 'Waiting for this session to free up…' }
        if (event.type === 'waited') return { ...message, status: `Session freed after ${formatMs(event.ms)}.` }
        if (event.type === 'compacting') return { ...message, status: 'Tidying the context…' }
        // What the fold came to, in the words every other surface uses for it: the
        // turns, the tokens they were worth, and whether a summary replaced them.
        if (event.type === 'compacted') return { ...message, status: describeCompaction(event) }
        if (event.type === 'rebased') return { ...message, status: `Session updated by another surface (${describeRebase(event)}).` }
        if (event.type === 'steer') return { ...message, status: 'Correction received by Milo.' }
        if (event.type === 'error') return { ...message, parts: settled(message.parts), status: `Error: ${event.message}` }
        if (event.type === 'aborted') return { ...message, parts: settled(message.parts), status: 'Stopped · the partial reply was kept.' }
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
        ? { ...message, parts: settled(message.parts), waitingSince: undefined, ...(frame.raw ? { raw: frame.raw } : {}), ...(frame.rawNoOutput ? { rawNoOutput: frame.rawNoOutput } : {}), ...(frame.status === 'stopped' ? { status: 'Stopped · the partial reply was kept.' } : {}) }
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
              parts: [{ kind: 'text', text: frame.markdown ?? frame.reply }],
              ...(frame.attachments?.length ? { attachments: frame.attachments } : {}),
              actions: frame.actions?.length ? frame.actions : undefined,
              cards: frame.cards?.length ? frame.cards : undefined,
            } : msg)
          }
          return [...current, {
            id: randomUUID(),
            role: 'assistant',
            parts: [{ kind: 'text', text: frame.markdown ?? frame.reply }],
            at: Date.now(),
            ...(frame.attachments?.length ? { attachments: frame.attachments } : {}),
            ...(frame.actions?.length ? { actions: frame.actions } : {}),
            ...(frame.cards?.length ? { cards: frame.cards } : {}),
          }]
        })
      } else {
        setMessages((current) => [...current, {
          id: randomUUID(),
          role: 'assistant',
          parts: [{ kind: 'text', text: frame.markdown ?? frame.reply }],
          at: Date.now(),
          ...(frame.attachments?.length ? { attachments: frame.attachments } : {}),
          ...(frame.actions?.length ? { actions: frame.actions } : {}),
          ...(frame.cards?.length ? { cards: frame.cards } : {}),
        }])
      }
      void refreshSessions()
    }
  }, [refreshSessions])

  const newChat = useCallback(async (): Promise<boolean> => {
    editingTurn.current = null
    const nextChatId = randomUUID()
    // Inside the click that asked for it, before any state moves: a focus handed
    // over a tick later is a focus the browser is free to drop. The counter is
    // the other half — when this chat is not the view on screen, the composer
    // mounts only once it is, and takes the cursor then.
    composerRef.current?.focus()
    setComposerFocus((current) => current + 1)
    try {
      const session = await api<{ id: string }>('new-session', { chatId: nextChatId })
      socket.close()
      setMessages([])
      setPanel(null)
      setProject(null)
      setPlan(false)
      setSessionId(session.id)
      setView('chat')
      setSidebarOpen(false)
      setChatId(nextChatId)
      return true
    } catch (error) {
      // Reported here, and said as a failure to the caller: a delete that moves
      // off the current session first must not go on when that move did not happen.
      fail(error)
      return false
    }
  }, [socket, fail, setView])

  /**
   * Start a work session in a project and open it — `newChat`'s move, with the
   * folder the session works in. The daemon binds the conversation to that
   * project, so the chat that opens is the ordinary one, working there.
   *
   * A `firstMessage` is said for the person: the words are owed exactly as a redo
   * owes them (`pendingSend`), and go out once the new session is the one the socket
   * speaks to. The Work screen uses it to ask for the project's rules to be written.
   */
  const startWorkSession = useCallback(async (project: string, firstMessage?: string): Promise<boolean> => {
    editingTurn.current = null
    const nextChatId = randomUUID()
    pendingSend.current = firstMessage ?? null
    composerRef.current?.focus()
    setComposerFocus((current) => current + 1)
    try {
      const session = await api<{ id: string }>('new-session', { chatId: nextChatId, project })
      socket.close()
      setMessages([])
      setPanel(null)
      setProject(null)
      setPlan(false)
      setSessionId(session.id)
      setView('chat')
      setSidebarOpen(false)
      setChatId(nextChatId)
      return true
    } catch (error) {
      pendingSend.current = null
      fail(error)
      return false
    }
  }, [socket, fail, setView])

  // biome-ignore lint/correctness/useExhaustiveDependencies: these are re-render triggers, not closure values — the list has already grown by the time this runs, and the scroll follows the rendered height
  useEffect(() => {
    const container = threadScroller()
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
  }, [messages, pendingPermission, threadScroller])

  /**
   * The thread stays pinned to its own end. The effect above only runs when the
   * messages change, and the height of the box changes after that — the keyboard
   * settling, the composer growing with what is typed — which is what left the
   * last message below the fold until the person scrolled it up themselves.
   */
  useEffect(() => {
    const container = threadScroller()
    if (!container) return
    const observer = new ResizeObserver(() => {
      const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 120
      if (nearBottom || followSend.current) container.scrollTop = container.scrollHeight
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [threadScroller])

  /**
   * How tall the composer is, for the thread to keep clear of it. A phone pins the
   * dock to the visible area (see `styles.css`), out of the page's flow, so the
   * room it used to hold by sitting in that flow is reserved here instead — and the
   * last message still reaches above the composer rather than behind it. It follows
   * the dock's own height, which grows with what is typed and with what the thread
   * is waiting on.
   */
  useEffect(() => {
    const el = composerDockRef.current
    if (!phone || view !== 'chat' || !el) return
    const root = document.documentElement
    const measure = (): void => { root.style.setProperty('--composer-height', `${el.offsetHeight}px`) }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => {
      observer.disconnect()
      root.style.removeProperty('--composer-height')
    }
  }, [phone, view])

  useEffect(() => () => {
    if (drawFrame.current !== null) cancelAnimationFrame(drawFrame.current)
  }, [])

  useEffect(() => {
    const unsubscribe = socket.subscribe(handleFrame)
    // A refusal never resolves on its own, so it is said once, in full, where the
    // person is looking — the chip that stays on screen keeps only the short form.
    const unsubscribeStatus = socket.subscribeStatus((status) => {
      setConnection(status)
      if (status.state === 'refused') setNotice({ text: status.reason ?? 'Milo refused this page.', error: true })
    })
    // This page can draw a generated interface; whether one is drawn at all is the
    // `display.genui` setting, which the turn reads — so the capability is said here
    // and the preference is Milo's.
    socket.connect(chatId, true)
    void refreshSessions()
    return () => { unsubscribe(); unsubscribeStatus(); socket.close() }
  }, [chatId, socket, handleFrame, refreshSessions])

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
   * starts on the left half opens it, and a leftward swipe across the chat closes
   * it again, the way every other panel on the phone works. The listeners stay
   * passive, so a swipe in the page still scrolls it.
   */
  useEffect(() => {
    const narrow = window.matchMedia('(max-width: 900px)')
    const OPEN_AT = 88
    const CLOSE_AT = 64
    let from: { x: number; y: number } | null = null

    const start = (event: TouchEvent) => {
      if (!narrow.matches || event.touches.length !== 1) return
      const touch = event.touches[0]
      // Opening begins anywhere on the left half; closing begins anywhere on the revealed chat.
      const wanted = sidebarOpen ? true : touch.clientX <= window.innerWidth / 2
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
  const send = useCallback((text: string, intent: 'queue' | 'steer' = 'queue', files?: File[], target?: SendTarget): void => {
    const sendingChat = chatId
    // An edit is a redo from the turn it was made on: the words go again with the
    // session forked to before them, rather than a second copy piling on top.
    if (editingTurn.current !== null && !files?.length) {
      const upToTurn = editingTurn.current
      editingTurn.current = null
      void redo(text, upToTurn)
      return
    }
    editingTurn.current = null
    void (async () => {
      const uploadIds = files?.length ? await Promise.all(files.map(uploadFile)) : []
      followSend.current = true
      if (text.startsWith('/') && !uploadIds.length) {
        setMessages((current) => [...current, { id: `user-${randomUUID()}`, role: 'user', parts: [{ kind: 'text', text }], at: Date.now() }])
        socket.send({ type: 'command', text })
      } else {
        socket.sendFor(sendingChat, { type: 'send', text, intent, ...(target ? { target } : {}), ...(uploadIds.length ? { uploadIds } : {}) })
      }
      setNotice(null)
    })().catch(fail)
  }, [socket, fail, redo, chatId])

  useEffect(() => { sendRef.current = send }, [send])

  /**
   * A routine asked for from the routines screen: always its own turn, and the
   * destination that screen named travels with it, so the sentence does not have
   * to spell it out.
   */
  function askRoutine(text: string, target?: SendTarget): void {
    send(text, 'queue', undefined, target)
  }

  /** The answer to a permission prompt, wherever on screen it is drawn. */
  function decide(action: 'allow' | 'always' | 'deny'): void {
    if (!pendingPermission) return
    socket.send({ type: 'control', action, id: pendingPermission.id })
  }

  const openSession = useCallback(async (id: string): Promise<void> => {
    editingTurn.current = null
    const nextChatId = randomUUID()
    try {
      await api('resume-session', { chatId: nextChatId, id })
      socket.close()
      setMessages([])
      setPanel(null)
      setProject(null)
      setSessionId(id)
      setChatId(nextChatId)
      setView('chat')
      setSidebarOpen(false)
    } catch (error) { fail(error) }
  }, [socket, fail, setView])

  const forkSession = useCallback(async (upToTurn: number): Promise<void> => {
    if (!sessionId) return
    editingTurn.current = null
    const nextChatId = randomUUID()
    composerRef.current?.focus()
    setComposerFocus((current) => current + 1)
    try {
      const res = await api<{ id: string }>('fork-session', {
        chatId: nextChatId,
        sessionId,
        upToTurn,
      })
      socket.close()
      setMessages([])
      setPanel(null)
      setProject(null)
      setSessionId(res.id)
      setChatId(nextChatId)
      setView('chat')
      setSidebarOpen(false)
      setNotice({ text: 'Branched into a new session.', error: false })
    } catch (error) { fail(error) }
  }, [sessionId, socket, fail, setView])

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

  /** Pointer and keys the person sends into the live browser panel. */
  const panelInput = useCallback((input: PanelInput): void => {
    try { socket.send({ type: 'panel-input', input }) } catch (error) { fail(error) }
  }, [socket, fail])

  /**
   * The strip is the person's own move. Bringing a tab forward shows at once and
   * tells the server, so the click is never waiting on the round trip; a tab
   * closed waits for the server's view, because guessing wrong would put a tab
   * back that is not there.
   */
  const activateTab = useCallback((key: string): void => {
    setPanel((current) => {
      if (!current) return current
      const index = current.tabs.findIndex((tab) => tab.key === key)
      return index < 0 ? current : { ...current, active: index }
    })
    try { socket.send({ type: 'panel-activate', key }) } catch (error) { fail(error) }
  }, [socket, fail])

  const closeTab = useCallback((key: string): void => {
    try { socket.send({ type: 'panel-close', key }) } catch (error) { fail(error) }
  }, [socket, fail])

  /**
   * Folding or unfolding the panel, and remembering it: the one thing about the
   * panel that outlives the page. Written here and nowhere else, so a `panel` call
   * revealing the panel never comes to read as the person's own preference.
   */
  const setPanelVisible = useCallback((open: boolean): void => {
    localStorage.setItem('milo-panel', open ? 'open' : 'closed')
    setPanelOpen(open)
  }, [])

  function handleSessionChange(id: string): void {
    editingTurn.current = null
    setSessionId(id)
    socket.close()
    setMessages([])
    // The tabs belong to the session that opened them, so the old strip is dropped
    // now rather than shown against the new session until its ready frame lands.
    setPanel(null)
    // This page can draw a generated interface; whether one is drawn at all is the
    // `display.genui` setting, which the turn reads — so the capability is said here
    // and the preference is Milo's.
    socket.connect(chatId, true)
    setView('chat')
  }

  /** Leaving the settings, which asks first when edits would be thrown away. */
  const leaveSettings = useCallback((): void => {
    if (settingsDirty && !window.confirm('Discard unsaved settings changes?')) return
    setViewRaw('chat')
    setSidebarOpen(false)
  }, [settingsDirty])

  const noteDirty = useCallback((dirty: boolean): void => { setSettingsDirty(dirty) }, [])

  async function exportSession(id = sessionId, report: Report = setNotice): Promise<void> {
    if (!id) return
    try {
      const result = await api<{ path: string } | null>('export', { id, format: 'md' })
      report(result
        ? { text: `Exported to ${result.path}`, error: false }
        : { text: 'Nothing to export yet — this session has no log.', error: true })
    } catch (error) { fail(error, report) }
  }

  async function deleteSession(id: string, report: Report = setNotice): Promise<void> {
    try {
      if (id === sessionId) {
        // Move off the session first — and only delete it if that worked. Ending
        // up on a session the delete removed is worse than not deleting at all.
        if (!(await newChat())) return
      }
      await api('session-delete', { id })
      setSessions((current) => current.filter((s) => s.id !== id))
      report({ text: 'Session deleted.', error: false })
    } catch (error) { fail(error, report) }
  }

  async function renameSession(id: string, title: string, report: Report = setNotice): Promise<void> {
    try {
      await api('session-rename', { id, title })
      setSessions((current) => current.map((s) => s.id === id ? { ...s, title: title.trim() || undefined } : s))
      report({ text: 'Session renamed.', error: false })
    } catch (error) { fail(error, report) }
  }

  /**
   * The id the session goes by on the machine hosting Milo — the handle to name it
   * from a shell or hand to another surface. The same notice the row's other actions
   * raise, so a copy the browser refused says so rather than leaving the reader
   * believing the id is on the clipboard when it never landed.
   */
  function copySessionId(id: string, report: Report = setNotice): void {
    void copyText(id).then((copied) => {
      report(copied
        ? { text: 'Session ID copied.', error: false }
        : { text: 'Could not copy the session ID.', error: true })
    })
  }

  /**
   * Setting the pair, the same act the settings screen calls `pickModel`: a model
   * taken from another provider's list moves the provider with it, because the
   * choice is the model and it fixes the pair at once. In that order, so the model
   * being set belongs to the provider being set. One write, one notice, one
   * failure — the two calls are one act, and firing them side by side would let
   * `set-provider` land last and overwrite the model with that provider's default.
   */
  const pickModel = useCallback(async (model: string, provider: string): Promise<void> => {
    try {
      let next = identity
      if (provider !== identity.provider) {
        const moved = await api<{ provider: string; providerName: string; model: string }>('set-provider', { provider })
        next = { provider: moved.provider, providerName: moved.providerName, model: moved.model }
      }
      const result = await api<{ model: string }>('set-model', { model })
      setIdentity({ ...next, model: result.model })
      setNotice(null)
    } catch (error) { fail(error) }
  }, [identity, fail])

  const changeProvider = useCallback(async (provider: string): Promise<void> => {
    try {
      const result = await api<{ provider: string; providerName: string; model: string }>('set-provider', { provider })
      setIdentity({ provider: result.provider, providerName: result.providerName, model: result.model })
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
    () => buildSuggestions({ sessions, ideas, currentId: sessionId }),
    [sessions, ideas, sessionId],
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

  /**
   * Whether there is a plan to approve: the plan turn has answered with prose and
   * is not still working. The button waits for that rather than sending an approval
   * into a turn that has not proposed anything yet.
   */
  const lastMessage = messages[messages.length - 1]
  const planReady =
    plan &&
    !busy &&
    messages.length > planSince &&
    lastMessage?.role === 'assistant' &&
    lastMessage.parts.some((part) => part.kind === 'text' && part.text.trim() !== '')

  /** The main chat's thread: prose, tools, the plan and anything the model drew. */
  const thread = <>
    <MessageList messages={messages} thinking={thinking} busy={busy} onPrompt={send} onAction={handleAction} onFork={forkSession} onQuote={quoteIntoComposer} onEdit={editMessage} onRegenerate={regenerate} suggestions={suggestions} hasIdeas={Boolean(ideas?.length)} />
    {pendingPermission && <article className="message assistant"><Permissions request={pendingPermission.request} expiresAt={pendingPermission.expiresAt} onDecision={(action) => socket.send({ type: 'control', action, id: pendingPermission.id })} /></article>}
  </>

  return <div className={`app-shell ${sidebarOpen ? 'drawer-open' : ''} ${sidebarCollapsed ? 'sidebar-collapsed' : ''} ${view === 'chat' && panelOpen && panel && panel.tabs.length > 0 ? 'panel-open' : ''}`}>
    {sidebarOpen && <button className="sidebar-scrim" type="button" aria-label="Close menu" onClick={() => setSidebarOpen(false)} />}
    <aside className="sidebar" aria-label="Main navigation">
      <div className="sidebar-chat-nav">
        <div className="brand-row"><img className="brand-mark" src={miloAvatar} alt="" /><span className="brand-name" translate="no">Milo</span><button className="sidebar-toggle" type="button" aria-label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'} title={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'} aria-pressed={sidebarCollapsed} onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}><Icon name="panel-left" size={17} /></button></div>
        <div className="sidebar-pad">
          <button className={`sidebar-tab ${view === 'routines' ? 'active' : ''}`} type="button" onClick={() => { setView(view === 'routines' ? 'chat' : 'routines'); setSidebarOpen(false) }}><Icon name="repeat" size={18} /><span>Routines</span></button>
          <button className={`sidebar-tab ${view === 'tasks' ? 'active' : ''}`} type="button" onClick={() => { setView(view === 'tasks' ? 'chat' : 'tasks'); setSidebarOpen(false) }}><Icon name="list-check" size={18} /><span>Task lists</span></button>
          <button className={`sidebar-tab ${view === 'work' ? 'active' : ''}`} type="button" onClick={() => { setView(view === 'work' ? 'chat' : 'work'); setSidebarOpen(false) }}><Icon name="folder" size={18} /><span>Work</span></button>
          <button className={`sidebar-tab ${view === 'email' ? 'active' : ''}`} type="button" onClick={() => { setEmailRoute(null); setView(view === 'email' ? 'chat' : 'email'); setSidebarOpen(false) }}><Icon name="mail" size={18} /><span>Email</span>{mailUnread !== null && mailUnread.count > 0 && <span className="sidebar-badge">{mailUnread.more ? `${mailUnread.count}+` : mailUnread.count}</span>}</button>
        </div>
        <div className="session-region">
          <nav className="session-list" aria-label="Sessions">
            <div className="section-label sidebar-sessions-label">Sessions</div>
            {historyHits && historyHits.length > 0 && <div className="history-hits">
              <div className="section-label">In past turns</div>
              {historyHits.map((hit) => <button className="history-hit" key={`${hit.session}-${hit.at}-${hit.text.slice(0, 32)}`} type="button" title={hit.session} onClick={() => void openSession(hit.session)}>
                <span className="history-hit-text">{hit.text || `${hit.kind} turn`}</span>
                <span className="history-hit-where">{hit.kind} · {hit.session}</span>
              </button>)}
            </div>}
            {sessionGroups.map((group) => <div className="session-group" key={group.label}><div className="section-label">{group.label}</div>{group.sessions.map((session) => <SessionRow key={session.id} session={session} active={session.id === sessionId} onClick={() => void openSession(session.id)} onRename={renameSession} onExport={exportSession} onCopy={copySessionId} onDelete={deleteSession} />)}</div>)}
            {visibleSessions.length === 0 && <p className="list-empty">{search ? 'No sessions found.' : 'Your saved sessions show up here.'}</p>}
          </nav>
        </div>
        {/* The sidebar's one action row, at its foot: start a session, find one, and
            the way to Settings. The list above it keeps every other line of height.
            The search folds behind its icon until asked for, taking the row whole. */}
        <div className="sidebar-actions">
          <div className={`sidebar-search ${searchOpen ? 'open' : ''}`}>
            <Icon name="search" size={16} />
            <input ref={searchRef} aria-label="Search sessions" placeholder="Search sessions" value={search} onChange={(event) => setSearch(event.target.value)} />
            <button className="sidebar-search-close" type="button" aria-label="Close search" onClick={closeSearch}><Icon name="x" size={15} /></button>
          </div>
          <button className={`new-chat ${searchOpen ? 'is-hidden' : ''}`} type="button" title="New session (⌘K)" aria-label="New session" onClick={() => void newChat()}><Icon name="plus" size={18} /><span className="new-chat-label">New session</span></button>
          <button className="sidebar-search-toggle" type="button" title="Search sessions" aria-label="Search sessions" aria-expanded={searchOpen} onClick={() => setSearchOpen((open) => !open)}><Icon name="search" size={18} /></button>
          <button className={`sidebar-settings-toggle ${view === 'settings' ? 'active' : ''}`} type="button" title="Settings" aria-label="Settings" onClick={() => { if (view === 'settings') { leaveSettings(); return } setSettingsSection(null); setView('settings'); setSidebarOpen(false) }}><Icon name="settings" size={18} /></button>
        </div>
      </div>
    </aside>

    <main className={`main ${view === 'settings' ? 'in-settings' : ''}`}>
      <header className="topbar">
        <button className="mobile-menu" type="button" aria-label="Open menu" onClick={() => setSidebarOpen(true)}><Icon name="menu" /></button>
        <button className="sidebar-expand" type="button" aria-label="Show sidebar" title="Show sidebar" onClick={() => setSidebarCollapsed(false)}><Icon name="panel-left" size={17} /></button>
        {/* The bar names the chat alone: every other screen wears its own heading below,
            and the bar saying it again was a second naming. The chat has no such heading,
            so the name of the session it is showing lives here — and, on a phone, this is
            the only place that names it. */}
        <div className="topbar-title">{view === 'chat' && <>
          {/* The project over the name: a session in one is work in a place, and which place
              is the first thing to know about it — said even before the first word, with the
              mark the project wears (a folder until another one is chosen). A project whose
              folder has gone says so rather than reading as workable. */}
          {project && <p className={project.error ? 'gone' : undefined} title={project.error}>
            <Icon name={projectMark(project.icon)} size={12} /> {project.name}
          </p>}
          <h1>{currentSession ? sessionLabel(currentSession) : 'New session'}</h1>
        </>}</div>
        <div className="topbar-actions">
          {view === 'chat' && panel && panel.tabs.length > 0 && <button className={`panel-toggle ${panelOpen ? 'active' : ''}`} type="button" title={panelOpen ? 'Hide panel' : 'Show panel'} aria-label={panelOpen ? 'Hide panel' : 'Show panel'} aria-pressed={panelOpen} onClick={() => setPanelVisible(!panelOpen)}><Icon name="panel-right" size={18} /></button>}
          {view === 'chat' && <button className="topbar-new" type="button" title="New session (⌘K)" aria-label="New session" onClick={() => void newChat()}><Icon name="plus" size={18} /></button>}
          {view === 'chat' && connection.state !== 'online' && <span className={`connection-status ${connection.state}`} title={connection.reason}><span />{connection.state === 'refused' ? 'Disconnected' : connection.state === 'offline' ? 'Reconnecting…' : 'Connecting…'}</span>}
        </div>
      </header>
      {view === 'settings'
        ? <Settings section={settingsSection} onSection={setSettingsSection} chatId={chatId} sessionId={sessionId} onClose={leaveSettings} onSessionChange={handleSessionChange} theme={theme} onThemeChange={setTheme} onDirtyChange={noteDirty} />
        : view === 'routines'
        ? <Routines chatId={chatId} tick={routinesTick} chat={{ messages, thinking, busy, connection: connection.state, turnEnds, pendingPermission, send: askRoutine, decide }} />
        : view === 'tasks'
        ? <TaskLists tick={turnEnds} />
        : view === 'work'
        ? <Work
          tick={workTick}
          sessions={sessions}
          sessionId={sessionId}
          onOpenSession={(id) => void openSession(id)}
          onStartSession={startWorkSession}
          onRenameSession={renameSession}
          onExportSession={exportSession}
          onCopySessionId={copySessionId}
          onDeleteSession={deleteSession}
        />
        : view === 'chat'
        ? <section className="chat-view">
          <div className="messages" id="messages" ref={messagesRef} onScroll={updateMessagesTop}>{thread}</div>
          <Notice notice={notice} onDismiss={() => setNotice(null)} />
          <div className="composer-dock" ref={composerDockRef}>
            {messages.length > 0 && <button className={`jump-latest ${atEnd ? '' : 'on'}`} type="button" title="Go to the latest" aria-label="Go to the latest" onClick={jumpToEnd}><Icon name="arrow-down" size={17} /></button>}
            <Composer ref={composerRef} busy={busy} queued={queued} jobs={jobs} onKillJob={(id) => socket.send({ type: 'job-kill', id })} provider={identity.provider} providerName={identity.providerName} draftKey={chatId} model={identity.model} context={contextBudget && contextUsed > 0 ? { used: contextUsed, budget: contextBudget } : undefined} effort={effort} focusSignal={composerFocus} plan={plan} planReady={planReady} canPlan={Boolean(project)} onPlanChange={(next) => { setPlan(next); setPlanSince(next ? messages.length : 0); socket.send({ type: 'control', action: 'plan', plan: next }) }} onApprovePlan={() => socket.send({ type: 'control', action: 'approve-plan' })} onSend={send} onStop={() => socket.send({ type: 'control', action: 'stop' })} onModelChange={pickModel} onEffortChange={(effort) => void changeEffort(effort)} onProviderChange={changeProvider} />
          </div>
        </section>
        : null}
      {/* The Email view is always mounted and hidden rather than torn down and rebuilt,
          so its inbox is read from the start and opening it draws mail instead of a
          loading line. It is told the view itself, not the path, so this is where it draws. */}
      <Email active={view === 'email'} route={emailRoute} onRoute={setEmailRoute} onSeen={clearMailBadge} />
    </main>
    {view === 'chat' && panelOpen && panel && panel.tabs.length > 0 && <Panel view={panel} onClose={() => setPanelVisible(false)} onInput={panelInput} onActivateTab={activateTab} onCloseTab={closeTab} />}
  </div>
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

/**
 * A call left marked running when the turn ended — a stop, an error, a dropped
 * connection — never heard back from. The line stops saying it is underway rather
 * than guessing how it went, which is the same thing a call read back from disk
 * with no result beside it says: nothing.
 */
function settled(parts: TranscriptPart[]): TranscriptPart[] {
  return parts.map((part) => part.kind === 'tool' && part.tool.state === 'running'
    ? { ...part, tool: { ...part.tool, state: undefined } }
    : part)
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
