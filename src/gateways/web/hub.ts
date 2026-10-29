import { createHash, randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { deriveIdeas, type Idea } from '../../core/ideas.js'
import type { AgentRuntime } from '../../core/runtime.js'
import type { Session } from '../../core/session.js'
import type { SessionSurface } from '../../core/sessions/types.js'
import { INSTALL_SCOPE, type MemoryScope } from '../../core/memory/index.js'
import { isImage, mimeFor, type OutgoingFile, type OutgoingMessage } from '../../core/outgoing.js'
import type { PanelRequest } from '../../core/panel.js'
import { placedProject } from '../../core/projects.js'
import { readDisplay } from '../../core/config/load.js'
import { buildCommandContext, handleCommand, handleTurnControl, turnOf, type CommandContext } from '../commands.js'
import { PendingDecisions } from '../pending.js'
import { TurnQueue } from '../turns.js'
import { rawTurn } from '../raw.js'
import { COMMAND_CATALOG } from '../command-catalog.js'
import type { ClientFrame, FrameAttachment, JobView, PanelInput, PanelKind, PanelState, PanelTab, PanelView, PermissionRequest, SendTarget, ServerFrame, TranscriptMessage } from './protocol.js'
import { PERMISSION_TIMEOUT_MS, PLAN_APPROVAL, PROTOCOL_VERSION, transcriptChunks } from './protocol.js'
import { displayEvent, withWords } from './turn.js'
import { panelsOf, transcriptOf } from './transcript.js'
import type { PanelFacts } from '../../core/agent/system.js'
import type { ClientKind } from '../../core/client.js'
import { resolveToolPath } from '../../core/tools/walk.js'
import { errorMessage } from '../../util/errors.js'
import { logWarn } from '../../util/log.js'
import { prepareIncoming } from '../../core/media.js'
import type { IncomingFile } from '../../core/media.js'
import type { ImagePart } from '../../core/providers/types.js'

/**
 * How long the home's ideas are reused before they are asked for again. Short,
 * because they are drawn from what Milo knows, which a turn can change — but far
 * longer than it takes to open a few empty chats, which is what the cache is for.
 */
const IDEAS_TTL_MS = 10 * 60 * 1000

/**
 * The shortest gap between two generations, whatever has changed. The cache above
 * already spares a repeated call while nothing moved; this is the floor under the
 * one case it does not cover — a turn that taught Milo something new, which
 * changes the key and would otherwise spend a call the next time a home opens.
 */
const IDEAS_MIN_GAP_MS = 5 * 60 * 1000

/** How many notes ground one generation; the newest ones are the relevant ones. */
const IDEAS_NOTES_LIMIT = 200

/** How many recent sessions are named as grounding. */
const IDEAS_SESSIONS = 5

/**
 * How often the live browser's last frame is sent again while a surface watches.
 *
 * `Page.screencastFrame` is event-driven: Chrome sends a frame when the page's
 * surface changes, and nothing at all while it is still — which is the ordinary
 * case, a page nobody is touching. Both surfaces that draw the live view read that
 * silence as a dead stream, and they are right to: from outside, a still page and a
 * stalled browser look exactly alike. So the frame a watcher already has is sent
 * again on this beat, and a stream that really has stopped is the only quiet one
 * left. Half of the four seconds both surfaces wait, which leaves them a whole beat
 * of slack.
 */
const BROWSER_BEAT_MS = 2_000

/**
 * The least time between two `work-changed` frames, whatever the install is doing.
 *
 * Every one of them costs each screen drawing a folder a tree and a diff, and a turn makes
 * a step a second — a run of edits would spend the whole turn re-reading a tree that is
 * about to change again. A second is short enough to read as live and long enough that the
 * cost does not grow with the number of steps. It cannot hide the last one: the turn's own
 * end says `sessions-changed`, which those screens re-read on too.
 */
const WORK_CHANGED_FLOOR_MS = 1_000

export interface WebClient {
  send(frame: ServerFrame): void
}

/**
 * The turn running on a session right now, with every frame it has said.
 *
 * Keyed by the session, not the chat: two screens bound to one session —
 * the desktop tab left open and the phone that picked it up — are two chats
 * over one `Session`, and both are owed the same live answer. A client can arrive in
 * the middle of it — a phone that was locked, a page reloaded — long after its
 * `turn-start` went out, and the session on disk is written a step at a time, so the
 * answer as it stands exists nowhere else; it is kept here, whole, and replayed.
 *
 * `from` is where the turn began in the session — the index of its own user message.
 * The ready handed to a late client is cut there (drawing the history up to and
 * including those words), and the frames carry everything the turn has said since. So
 * the answer is drawn once, as the one row the client that watched it live drew — not
 * split in two, the written steps in the history and the rest beside them.
 */
interface LiveTurn {
  id: string
  at: number
  from: number
  frames: ServerFrame[]
  /** The chat whose queue runs this turn; a sibling's own message joins it. */
  owner: string
  /**
   * The permission the turn is waiting on, when it is waiting on one. It goes out as
   * its own frame, so a client that arrives after it did never saw it — and a
   * question nobody can see is a question that expires as a denial.
   */
  permission?: { id: string; request: PermissionRequest; expiresAt: number }
}

interface Chat {
  scope: MemoryScope
  session: Session
  clients: Set<WebClient>
  /**
   * Whether a client on this chat said it draws a generated interface.
   * Declared on connect and read on every turn, so drawing is taught only where
   * its tree can actually be drawn: a plain web chat sits beside one that can,
   * and is taught nothing.
   */
  genui?: boolean
  /**
   * The client app that last named itself on this chat, when one did. The
   * phone and the browser reach the same gateway, so this is what lets a turn be
   * held for the phone. Declared on connect and read on every turn, like `genui` —
   * a client that says nothing leaves it as it was.
   */
  client?: ClientKind
  /**
   * The panel's tabs, in the order they opened, and the one in front. The requests
   * that made them, not the resolved views: a tab is read from disk afresh each
   * time it is drawn, so an edit shows without reopening anything.
   */
  panel?: { requests: PanelRequest[]; active: number }
}

export class WebHub {
  private readonly chats = new Map<string, Chat>()
  /**
   * The turn running on each session, by session id. One session can be open in
   * several chats — the desktop and the phone — and this is what makes the
   * live answer theirs in common rather than each chat's own.
   */
  private readonly live = new Map<string, LiveTurn>()
  private readonly turns = new TurnQueue()
  private readonly pending = new PendingDecisions()
  /**
   * The files delivered into this process's chats, by id. Only what is
   * here is ever served, so the browser cannot ask for a path of its own naming.
   * Rebuilt from a transcript as chats are opened, which is why the id is
   * a hash of the path rather than a fresh token each time.
   */
  private readonly attachments = new Map<string, { path: string; name: string; mimeType: string }>()
  private readonly stagedUploads = new Map<string, { file: IncomingFile; expires: number; timer: NodeJS.Timeout }>()
  /**
   * The ideas the home currently gets, and what they were drawn from. One slot,
   * not one per chat: what grounds them — the notes and the recent
   * sessions — belongs to the install, so every empty chat gets the same ones.
   */
  private ideaCache: { key: string; at: number; items: Idea[] } | null = null
  /** The generation in flight, when there is one, so a turn can cut it off. */
  private ideaWork: { controller: AbortController } | null = null
  /** When the last call was made, for the floor in `runIdeas`; 0 before the first. */
  private ideaCalledAt = 0
  /** The generations still running; `flush()` waits for them, a shutdown does not. */
  private readonly pendingIdeas = new Set<Promise<void>>()
  /**
   * The pages watching the live browser. The screencast runs while this is not
   * empty and stops when the last watcher leaves, so a browser nobody is looking
   * at is not streaming.
   */
  private readonly browserWatchers = new Set<(frame: Buffer) => void>()

  /** The last frame the live browser sent, repeated on the beat below. */
  private lastBrowserFrame: Buffer | null = null

  /** The beat doing that repeating. One for every watcher together, not one each. */
  private browserBeat: NodeJS.Timeout | null = null

  /** Stops following the browser's URL once subscribed; see `watchBrowserUrl`. */
  private browserUrlWatch: (() => void) | null = null

  /** Stops the job subscription on the way out; see the constructor. */
  private detachJobs: (() => void) | null = null

  /** Stops the sessions subscription on the way out; see the constructor. */
  private detachSessions: (() => void) | null = null

  /** Stops the work subscription on the way out; see the constructor. */
  private detachWork: (() => void) | null = null

  /** When the last `work-changed` went out, for the floor above; 0 before the first. */
  private workChangedAt = 0

  /**
   * `cwd` is only ever needed to resolve a panel's file when a request is read
   * back from a transcript; the server passes its own, and the default matches
   * how a bare path is resolved everywhere else.
   */
  constructor(private readonly runtime: AgentRuntime, private readonly cwd: string = process.cwd()) {
    // A job belongs to the session that started it, so each open chat is told about
    // its own and its strip never draws another chat's work.
    this.detachJobs =
      this.runtime.jobs?.onChange(() => {
        this.broadcastJobs()
      }) ?? null
    // A session began or ended a turn anywhere in this install: every open page is told,
    // so the dot beside a session and a project's folder both follow the work. The runtime
    // says it rather than this hub — a turn a gateway or a routine ran is announced too,
    // and it is the one place every turn goes through.
    this.detachSessions = this.runtime.onSessionsChanged(() => this.sessionsChanged())
    // And a step that may have changed a folder: a screen drawing one re-reads it while the
    // turn is still running, which is the whole of what makes a long turn watchable.
    this.detachWork = this.runtime.onWorkChanged(() => this.workChanged())
  }

  async connect(client: WebClient, chatId: string, genui?: boolean, clientKind?: ClientKind, surface?: SessionSurface): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(chatId)) throw new Error('Invalid chat id.')
    let chat = this.chats.get(chatId)
    if (!chat) {
      const scope: MemoryScope = { gateway: 'web', chatId }
      // The scope stays the web's — same place, same memory — and the surface that
      // asked is recorded on the session, so a row can say where it came from.
      chat = {
        scope,
        session: await this.runtime.sessionFor(scope, surface ? { surface } : undefined),
        clients: new Set(),
      }
      this.chats.set(chatId, chat)
    } else if (!this.turns.busy(chatId)) {
      chat.session = await this.runtime.getSession(chat.scope)
    }
    // A client that says nothing leaves the capability as it was: the plain chat
    // and a reload that does not repeat it must not take it away mid-session.
    if (genui !== undefined) chat.genui = genui
    if (clientKind !== undefined) chat.client = clientKind
    chat.clients.add(client)
    // The turn running now, when there is one: this client missed its `turn-start`,
    // so the id it is drawn under rides with the ready and the events it has already
    // said are replayed under it, in order, before anything new arrives.
    const running = this.live.get(chat.session.id)
    // The folder this session works in, when it works in one: said here so a surface names it
    // without reading the project list itself — and said on a session with nothing in it yet,
    // which is the session that is about to work there.
    const placement = chat.session.project
    const project = placement ? placedProject(placement) : undefined
    // A late client is handed the history up to and including the running turn's own
    // user message. Everything after it is that turn's output, which the frames below
    // replay — so the answer is drawn once, as one row, and not as the steps already
    // written with the rest of it opening a second row beside them. A session long
    // enough to outgrow one message is handed over in pieces; see `transcriptChunks`.
    const [firstChunk = [], ...rest] = transcriptChunks(
      this.transcript(chat.session, running ? running.from + 1 : undefined),
    )
    client.send({
      type: 'ready',
      // The number the handshake was checked against, not a copy of it: a client that
      // trusts this field was being told `1` while the server spoke `10`.
      version: PROTOCOL_VERSION,
      sessionId: chat.session.id,
      ...(project ? { project } : {}),
      messages: firstChunk,
      ...(rest.length > 0 ? { continues: true } : {}),
      thinking: readDisplay().thinking,
      // Whether this session is proposing rather than working. A client that opens
      // mid-plan draws the switch on, and the catalog on the server already matches.
      plan: chat.session.planMode,
      // Read from the runtime, not a startup snapshot: a provider switch made at
      // runtime shows on the next connection without the page reconnecting.
      provider: this.runtime.provider.id,
      providerName: this.runtime.providerName,
      model: this.runtime.model,
      effort: this.runtime.reasoningEffort,
      panel: this.panelFor(chat),
      jobs: this.jobsView(chat.session.id),
      // What `/` offers. The browser imports the same list; the phone is handed it
      // here, because it cannot.
      commands: COMMAND_CATALOG,
      ...(running ? { activeTurn: { id: running.id, at: running.at } } : {}),
    })
    // The rest of a long transcript, in the order it happened: the `ready` above opened
    // the thread and these fill it, whole rows at a time. They go before the running
    // turn's own frames so a surface that appends has the history under the turn rather
    // than around it.
    for (const chunk of rest) client.send({ type: 'history', messages: chunk })
    if (running) for (const frame of running.frames) client.send(frame)
    // A question the turn is still waiting on, sent again under the id it already
    // had: the deadline is the daemon's, so the countdown this client draws is the
    // one that is actually running rather than a fresh five minutes.
    const asking = running?.permission
    if (asking) {
      client.send({ type: 'permission', id: asking.id, request: asking.request, expiresAt: asking.expiresAt })
    }
    this.sendState(chatId)
    // An empty home asks for ideas in the background: the page is already drawn
    // from the standing four, which the ideas arrive to take the place of.
    if (chat.session.messages.length === 0) this.ensureIdeas()
  }

  /**
   * Loses the client, never the turn. A page reloading, a tab left in the
   * background and a connection dropping all close this socket exactly the way a
   * closing tab does, and nothing on the wire tells them apart — stopping here
   * made looking away end the answer. What a turn says is written to the session
   * as it streams and the next `connect` hands the whole transcript back, so an
   * answer that arrived with nobody watching is read a moment later instead of
   * being lost. Only the stop control, and `/stop`, end a turn.
   */
  disconnect(client: WebClient): void {
    for (const chat of this.chats.values()) chat.clients.delete(client)
  }

  handle(client: WebClient, frame: ClientFrame, chatId: string): void {
    const chat = this.chats.get(chatId)
    if (!chat?.clients.has(client)) return

    if (frame.type === 'control') {
      if (frame.action === 'stop') {
        // The turn may be running in a sibling's queue: stopping is the session's own
        // act, not the asking chat's, so it lands on whoever owns it.
        const result = this.turns.stop(this.liveOwner(chat.session.id) ?? chatId)
        this.sendState(chatId)
        if (!result.stopped) client.send({ type: 'error', message: 'Nothing is running to stop.' })
      } else if (frame.action === 'plan') {
        // The switch is the session's, not the tab's: a sibling watching the same
        // session is proposing with it, and has to see the same state.
        chat.session.setPlan(frame.plan === true)
        this.emitTurn(chat.session.id, { type: 'plan', plan: chat.session.planMode })
      } else if (frame.action === 'approve-plan') {
        // Approval is one act: leave plan mode, say so, and let the execution turn
        // follow in the same queue rather than waiting for a second click.
        if (!chat.session.planMode) {
          client.send({ type: 'error', message: 'Plan mode is not on.' })
          return
        }
        chat.session.setPlan(false)
        this.emitTurn(chat.session.id, { type: 'plan', plan: false })
        this.startTurn(chatId, PLAN_APPROVAL)
      } else if (frame.id) {
        const allowed = frame.action !== 'deny'
        const remember = frame.action === 'always'
        // The permission belongs to the session it was raised in: a client of another
        // session cannot answer it, even holding the id — and a client of a sibling
        // chat can, because the question is the session's own.
        if (
          this.pending.resolve(
            frame.id,
            { allowed, ...(remember ? { remember: true } : {}) },
            chat.session.id,
          )
        ) {
          client.send({ type: 'permission-result', id: frame.id, allowed, ...(remember ? { remember: true } : {}) })
        } else {
          client.send({ type: 'error', message: 'That permission is no longer waiting.' })
        }
      }
      return
    }

    if (frame.type === 'job-kill') {
      // The person pressing stop is the confirmation; the manager kills the child
      // and its change broadcast redraws the strip without this job. Scoped to the
      // session this client is in: another chat's job is not theirs to stop.
      const killed = this.runtime.jobs?.kill(frame.id, chat.session.id) ?? false
      if (!killed) client.send({ type: 'error', message: `No running job "${frame.id}".` })
      return
    }

    if (frame.type === 'send') {
      let files: IncomingFile[] = []
      try {
        files = frame.uploadIds?.map((uploadId) => this.takeUpload(uploadId)) ?? []
      } catch (error) {
        client.send({ type: 'error', message: errorMessage(error) })
        return
      }
      if (!frame.text.trim() && !files.length) return
      // A message from a sibling goes into the queue the session's turn lives in, so
      // it runs after the one in flight and its frames reach both screens. With
      // nothing live, the queue is this chat's own — the cross-process case,
      // which the lease serialises into `waiting`/`waited` exactly as before.
      const sessionId = chat.session.id
      const key = this.liveOwner(sessionId) ?? chatId
      if (files.length) {
        this.startTurn(key, frame.text, frame.target, [], files)
        return
      }
      if (frame.intent === 'steer') {
        const steered = this.turns.steer(key, frame.text)
        if (steered) {
          const turnId = this.live.get(sessionId)?.id
          if (turnId) this.emitTurn(sessionId, { type: 'event', turnId, event: { type: 'steer', text: frame.text } })
          return
        }
      }
      this.startTurn(key, frame.text, frame.target)
      return
    }

    if (frame.type === 'panel-input') {
      void this.browserInput(frame.input).catch((error: unknown) => {
        client.send({ type: 'error', message: errorMessage(error) })
      })
      return
    }

    // The person's own move on the strip: their own action, so nothing is
    // confirmed, and everyone watching the chat sees the same tab come forward.
    if (frame.type === 'panel-activate') {
      this.activateTab(chatId, frame.key)
      return
    }

    if (frame.type === 'panel-close') {
      this.closeTab(chatId, frame.key)
      return
    }

    if (frame.type === 'command') void this.command(client, chat, frame.text).catch((error: unknown) => {
      client.send({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    })

    if (frame.type === 'action') {
      const actionId = frame.actionId
      const messageId = frame.messageId
      // Action buttons and cards (e.g. /sessions pagination) are ephemeral in-memory
      // UI controls that re-invoke the command when interacted with.
      if (actionId.startsWith('sessions:')) {
        const page = actionId.slice('sessions:'.length)
        void this.command(client, chat, `/sessions ${page}`, messageId).catch((error: unknown) => {
          client.send({ type: 'error', message: error instanceof Error ? error.message : String(error) })
        })
        return
      }
    }
  }

  close(): void {
    this.ideaWork?.controller.abort()
    for (const staged of this.stagedUploads.values()) clearTimeout(staged.timer)
    this.stagedUploads.clear()
    this.browserWatchers.clear()
    this.browserUrlWatch?.()
    this.browserUrlWatch = null
    this.runtime.browser?.stopScreencast()
    for (const id of this.chats.keys()) this.turns.stop(id)
    this.detachJobs?.()
    this.detachJobs = null
    this.detachSessions?.()
    this.detachSessions = null
    this.detachWork?.()
    this.detachWork = null
  }

  stageUpload(file: IncomingFile): string {
    this.pruneStagedUploads()
    const id = randomUUID()
    const expires = Date.now() + 10 * 60_000
    const timer = setTimeout(() => this.stagedUploads.delete(id), 10 * 60_000)
    timer.unref()
    this.stagedUploads.set(id, { file, expires, timer })
    return id
  }

  private takeUpload(id: string): IncomingFile {
    this.pruneStagedUploads()
    const staged = this.stagedUploads.get(id)
    if (!staged) throw new Error('An uploaded file expired. Attach it again and resend.')
    this.stagedUploads.delete(id)
    clearTimeout(staged.timer)
    return staged.file
  }

  private pruneStagedUploads(): void {
    const now = Date.now()
    for (const [id, staged] of this.stagedUploads) {
      if (staged.expires <= now) {
        clearTimeout(staged.timer)
        this.stagedUploads.delete(id)
      }
    }
  }

  /**
   * Waits for the ideas still being derived. A page never waits for them and a
   * shutdown need not either, so this is the seam for a caller that wants the
   * work finished before it looks — a test, or an orderly exit.
   */
  async flush(): Promise<void> {
    while (this.pendingIdeas.size > 0) {
      await Promise.allSettled([...this.pendingIdeas])
    }
  }

  /**
   * A routine ran. This is not about one chat, so it goes to every client
   * on the server: a Routines screen that is open anywhere is showing a history
   * that just changed.
   */
  routinesChanged(): void {
    const frame: ServerFrame = { type: 'routines-changed' }
    for (const chat of this.chats.values()) {
      for (const client of chat.clients) client.send(frame)
    }
  }

  /**
   * A session started or ended a turn: told by the runtime, which every turn goes
   * through, so a turn a gateway or a routine ran arrives here the same way as one a
   * socket asked for. Like `routinesChanged`, this is not about one chat — the
   * sessions list shows the same session running on every surface — so it goes to every
   * client, and each re-reads the list.
   */
  sessionsChanged(): void {
    const frame: ServerFrame = { type: 'sessions-changed' }
    for (const chat of this.chats.values()) {
      for (const client of chat.clients) client.send(frame)
    }
  }

  /**
   * A step finished that may have changed what is on disk. Told by the runtime, so the same
   * for a turn from a gateway or a routine, and held to the floor above: a turn makes many
   * steps and each frame costs a screen drawing a folder a tree and a diff.
   *
   * Sent to every client although only some are drawing a folder — the frame says nothing
   * about which, and the ones that are not are one no-op. Which folder it was is not carried
   * either: a screen re-reads the one it is showing, which is the only one it can compare a
   * step against, and the daemon would otherwise be matching paths on its behalf.
   */
  private workChanged(): void {
    const now = Date.now()
    if (now - this.workChangedAt < WORK_CHANGED_FLOOR_MS) return
    this.workChangedAt = now
    const frame: ServerFrame = { type: 'work-changed' }
    for (const chat of this.chats.values()) {
      for (const client of chat.clients) client.send(frame)
    }
  }

  /**
   * Posts a message into a chat with no turn behind it — how a routine
   * reaches a web chat, and how a live turn's own files reach it too: the answer
   * is already on screen, so the files arrive as their own message. It is written
   * into the chat's session first, so it is there when the tab is next
   * opened, and then broadcast to whoever is watching right now; the broadcast is
   * a no-op when nobody is. The frame is the one a command reply uses, so the
   * chat renders it and lists it like any other message without the protocol
   * knowing about routines.
   */
  async deliver(chatId: string, message: OutgoingMessage): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(chatId)) {
      throw new Error(`not a web chat id: ${chatId}`)
    }
    const files = message.files ?? []
    const text = message.text ?? ''
    const session = await this.runtime.getSession({ gateway: 'web', chatId })
    await session.appendNotice(text, files, message.routine)
    const attachments = files.map((file) => this.register(file))
    // Said to every screen on the session, not only the chat it was addressed
    // to: the file is the session's own message, and a sibling watching it is owed the
    // same. Kept on the live turn too, so a client that arrives mid-turn still gets it
    // — the ready it is handed is cut at the turn's start, before this landed.
    this.emitTurn(session.id, {
      type: 'command-result',
      reply: text,
      markdown: text,
      ...(attachments.length > 0 ? { attachments } : {}),
      // A routine's delivery signs itself on the surface that can draw a head; the
      // transcript kept the same mark, so a reload shows the same card.
      ...(message.routine ? { routine: message.routine } : {}),
    })
  }

  /** The file behind an id, for the HTTP layer to stream. Null when none was delivered under it. */
  attachment(id: string): { path: string; name: string; mimeType: string } | null {
    return this.attachments.get(id) ?? null
  }

  /**
   * Shows a message that is *already* in the chat's transcript — the
   * announcement of a finished background job, whose turn ran on the
   * chat's own session. Unlike `deliver` it does not write the transcript
   * again, so the message is not doubled; a reload reads it from the transcript.
   */
  async showNotice(chatId: string, message: OutgoingMessage): Promise<void> {
    const files = message.files ?? []
    const text = message.text ?? ''
    const attachments = files.map((file) => this.register(file))
    // The whole session, like `deliver`: a finished job's announcement belongs to the
    // session it ran on, and a sibling watching that session is owed it too.
    const session = await this.runtime.getSession({ gateway: 'web', chatId })
    this.emitTurn(session.id, {
      type: 'command-result',
      reply: text,
      markdown: text,
      ...(attachments.length > 0 ? { attachments } : {}),
    })
  }

  /**
   * Notes a delivered file under its id and describes it for the browser. The id
   * is the path's hash, so opening the same chat again — a reload, a tab
   * reopened later — registers the same id the page was already given.
   *
   * Public because it is this process, not the caller, that owns what may be
   * served: the read-only view of a past run draws its files through here too,
   * so they are fetchable by the same `/attachment/<id>` a chat message uses.
   */
  register(file: OutgoingFile): FrameAttachment {
    const id = createHash('sha1').update(file.path).digest('hex')
    const size = statSync(file.path, { throwIfNoEntry: false })?.size ?? 0
    this.attachments.set(id, { path: file.path, name: file.name, mimeType: file.mimeType })
    return { id, name: file.name, mimeType: file.mimeType, size, image: isImage(file.mimeType) }
  }

  /**
   * The panel a chat was left showing. Seeded once, when the chat
   * opens, by replaying the requests its history kept through the very rule a live
   * one goes through — so a reload and a fresh show cannot disagree — and resolved
   * afresh on every read, from each file's current contents rather than a snapshot.
   */
  private panelFor(chat: Chat): PanelView | null {
    if (!chat.panel) {
      chat.panel = { requests: [], active: 0 }
      for (const request of panelsOf(chat.session.messages)) this.showPanel(chat, request)
    }
    return this.panelView(chat)
  }

  /**
   * Puts a request on the panel: its own tab, in front — or, when a tab for it is
   * already open, that one brought forward. Re-showing the same file therefore
   * does not stack a second copy of it, which matters because the model re-shows a
   * report every time it revises it. `close` takes the whole panel down, which is
   * what the model means by it.
   */
  private showPanel(chat: Chat, request: PanelRequest): void {
    if (request.close) {
      chat.panel = { requests: [], active: 0 }
      return
    }
    const state = this.resolvePanel(request)
    if (!state) return
    const tabs = chat.panel?.requests ?? []
    const key = panelKeyOf(state)
    const existing = tabs.findIndex((one) => {
      const resolved = this.resolvePanel(one)
      return resolved ? panelKeyOf(resolved) === key : false
    })
    chat.panel = existing >= 0
      ? { requests: tabs, active: existing }
      : { requests: [...tabs, request], active: tabs.length }
  }

  /**
   * The panel as the page draws it: every stored request resolved afresh, with the
   * tabs that no longer resolve dropped — a file that has since gone takes its tab
   * with it, and the one in front shifts with the rest. Null when nothing is left,
   * which is the panel being down.
   */
  private panelView(chat: Chat): PanelView | null {
    const panel = chat.panel
    if (!panel || panel.requests.length === 0) return null
    const tabs: PanelTab[] = []
    const kept: PanelRequest[] = []
    let active = 0
    panel.requests.forEach((request, index) => {
      const state = this.resolvePanel(request)
      if (!state) return
      if (index === panel.active) active = tabs.length
      kept.push(request)
      tabs.push({ ...state, key: panelKeyOf(state) })
    })
    if (tabs.length === 0) {
      chat.panel = { requests: [], active: 0 }
      return null
    }
    active = Math.min(active, tabs.length - 1)
    chat.panel = { requests: kept, active }
    return { tabs, active }
  }

  /**
   * What is on the panel, for the model: which tabs are open and where each one's
   * contents are, so it can talk about them, or read one, rather than ask. The path
   * is the hub's own — the page is never given one — and the browser tab carries
   * the page it is on.
   */
  private panelFacts(chat: Chat): PanelFacts {
    const view = this.panelView(chat)
    if (!view) return { tabs: [], active: 0 }
    return {
      tabs: view.tabs.map((tab) => {
        const path = tab.artifact ? this.attachment(tab.artifact.id)?.path : undefined
        return {
          kind: tab.kind,
          ...(tab.title ? { title: tab.title } : {}),
          ...(path ? { path } : {}),
          ...(tab.kind === 'browser' ? { url: tab.url ?? null } : {}),
        }
      }),
      active: view.active,
    }
  }

  /** Brings a tab to the front, by key. A key that is not open is ignored. */
  private activateTab(chatId: string, key: string): void {
    const chat = this.chats.get(chatId)
    if (!chat) return
    const index = this.panelView(chat)?.tabs.findIndex((tab) => tab.key === key) ?? -1
    if (index < 0 || !chat.panel) return
    chat.panel = { requests: chat.panel.requests, active: index }
    this.broadcast(chatId, { type: 'panel', panel: this.panelView(chat) })
  }

  /** Closes a tab, by key. Closing the last one leaves the panel down. */
  private closeTab(chatId: string, key: string): void {
    const chat = this.chats.get(chatId)
    if (!chat) return
    const index = this.panelView(chat)?.tabs.findIndex((tab) => tab.key === key) ?? -1
    if (index < 0 || !chat.panel) return
    const requests = chat.panel.requests.filter((_, at) => at !== index)
    chat.panel = { requests, active: Math.min(index, Math.max(0, requests.length - 1)) }
    this.broadcast(chatId, { type: 'panel', panel: this.panelView(chat) })
  }

  /**
   * Follows the live browser's URL, so a panel drawing it is not left on the
   * snapshot it opened with. Subscribed once, the first time a browser panel is
   * resolved; every chat showing the browser tab is then told afresh.
   */
  private watchBrowserUrl(): void {
    const browser = this.runtime.browser
    if (!browser || this.browserUrlWatch) return
    this.browserUrlWatch = browser.onNavigate(() => {
      for (const [id, chat] of this.chats) {
        if (this.hasBrowserTab(chat)) this.broadcast(id, { type: 'panel', panel: this.panelView(chat) })
      }
    })
  }

  /** Whether the panel a chat holds has the browser tab on it. */
  private hasBrowserTab(chat: Chat): boolean {
    return (chat.panel?.requests ?? []).some((request) => request.browser)
  }

  /**
   * A panel request as a view the browser can draw. A browser request needs no
   * file; a path is registered so its bytes are served inline by id, and the kind
   * is decided by what the file is. A file that is gone resolves to no panel
   * rather than a broken one.
   */
  private resolvePanel(request: PanelRequest): PanelState | null {
    if (request.close) return null
    const title = request.title?.trim() || undefined
    if (request.browser) {
      this.watchBrowserUrl()
      return { kind: 'browser', ...(title ? { title } : {}), url: this.runtime.browser?.status.url ?? null }
    }
    if (!request.path) return null
    const path = resolveToolPath(this.cwd, request.path)
    const stats = statSync(path, { throwIfNoEntry: false })
    if (!stats?.isFile()) return null
    const name = basename(path)
    // The MIME the panel serves it as: HTML needs its own type or the browser
    // downloads the page instead of framing it.
    const ext = extname(name).toLowerCase()
    const mimeType = ext === '.html' || ext === '.htm' ? 'text/html; charset=utf-8' : mimeFor(path)
    const artifact = this.register({ path, name, mimeType })
    return { kind: panelKindOf(artifact.mimeType, name), title: title ?? name, artifact }
  }

  /**
   * Frames of the live browser, fanned out to every watcher. The screencast
   * starts with the first watcher and stops with the last, so a browser nobody is
   * looking at is not streaming. Returns the off switch, which the caller keeps
   * for as long as its own stream is open.
   */
  async watchBrowser(onFrame: (frame: Buffer) => void): Promise<() => void> {
    const browser = this.runtime.browser
    if (!browser) throw new Error('the browser is not enabled — turn it on in Settings → Tools')
    if (this.browserWatchers.size === 0) {
      await browser.startScreencast((frame) => this.fanBrowser(frame))
      this.startBrowserBeat()
    }
    this.browserWatchers.add(onFrame)
    let stopped = false
    return () => {
      if (stopped) return
      stopped = true
      this.browserWatchers.delete(onFrame)
      if (this.browserWatchers.size === 0) {
        browser.stopScreencast()
        this.stopBrowserBeat()
      }
    }
  }

  /**
   * The last frame, again and again: see `BROWSER_BEAT_MS` for why a screencast is
   * not a stream without this. Started with the first watcher and stopped with the
   * last, so nothing is sent — not even a repeat — to nobody.
   */
  private startBrowserBeat(): void {
    this.lastBrowserFrame = null
    this.browserBeat = setInterval(() => {
      // A watcher that left without the off switch being called — a socket cut
      // mid-frame — must not leave this running.
      if (this.browserWatchers.size === 0) {
        this.stopBrowserBeat()
        return
      }
      if (this.lastBrowserFrame) this.fanBrowser(this.lastBrowserFrame)
    }, BROWSER_BEAT_MS)
    // A live view is not a reason for the process to stay up.
    this.browserBeat.unref()
  }

  private stopBrowserBeat(): void {
    if (this.browserBeat) clearInterval(this.browserBeat)
    this.browserBeat = null
    this.lastBrowserFrame = null
  }

  private fanBrowser(frame: Buffer): void {
    this.lastBrowserFrame = frame
    for (const watcher of this.browserWatchers) {
      try {
        watcher(frame)
      } catch {
        // A watcher whose socket died must not stop the frames for the rest.
      }
    }
  }

  /**
   * A pointer or key the person sent into the live browser panel, run against the
   * page. It is their own action, so nothing is confirmed; a failure is reported
   * back where they acted rather than swallowed.
   */
  async browserInput(input: PanelInput): Promise<void> {
    const browser = this.runtime.browser
    if (!browser) throw new Error('the browser is not enabled — turn it on in Settings → Tools')
    const signal = new AbortController().signal
    if (input.kind === 'click' || input.kind === 'move') return browser.pointer(input.kind, input.x, input.y, signal)
    if (input.kind === 'scroll') return browser.wheel(input.x, input.y, input.deltaY, signal)
    if (input.kind === 'key') return browser.key(input.key, input.modifiers ?? 0, signal)
    return browser.typeText(input.text, signal)
  }

  /**
   * Starts deriving the home's ideas unless one is already under way. Called when
   * an empty session opens; it returns at once, and the work reaches the page as
   * a `suggestions` frame whenever it lands.
   */
  private ensureIdeas(): void {
    if (this.ideaWork) return
    const controller = new AbortController()
    const work = this.runIdeas(controller)
    // Set here, synchronously, before `runIdeas` reaches its first await: two
    // chats opened in the same tick must not start two calls.
    this.ideaWork = { controller }
    this.pendingIdeas.add(work)
    void work.finally(() => {
      this.pendingIdeas.delete(work)
      if (this.ideaWork?.controller === controller) this.ideaWork = null
    })
  }

  /**
   * The generation itself: ground it, reuse a fresh answer, otherwise ask and
   * deliver. Nothing here rejects — a failure is logged and leaves the standing
   * four on screen, which is what they are for.
   */
  private async runIdeas(controller: AbortController): Promise<void> {
    try {
      const grounding = await this.grounding()
      if (!grounding) return
      // Nothing moved and the answer is not old: hand back what we have.
      if (this.ideaCache && this.ideaCache.key === grounding.key && Date.now() - this.ideaCache.at < IDEAS_TTL_MS) {
        this.deliverIdeas()
        return
      }
      // Something moved, but a call was made too recently: serve the cached ideas
      // rather than spend another. This is the floor — one call per window at most.
      if (this.ideaCalledAt !== 0 && Date.now() - this.ideaCalledAt < IDEAS_MIN_GAP_MS) {
        this.deliverIdeas()
        return
      }
      if (controller.signal.aborted) return
      this.ideaCalledAt = Date.now()
      const items = await deriveIdeas({
        provider: this.runtime.provider,
        model: this.runtime.model,
        notes: grounding.notes,
        sessions: grounding.sessions,
        signal: controller.signal,
      })
      if (controller.signal.aborted || items.length === 0) return
      this.ideaCache = { key: grounding.key, at: Date.now(), items }
      this.deliverIdeas()
    } catch (error) {
      logWarn(`could not prepare home ideas: ${errorMessage(error)}`)
    }
  }

  /**
   * What the ideas are drawn from, and a key over it. Two reads and a hash, all
   * local: the key changes the moment a note or a session does, so a cached
   * answer is reused only while what grounds it is unchanged. Null when there is
   * nothing to go on — a new install — so no call is spent on ideas with no
   * footing.
   */
  private async grounding(): Promise<{
    key: string
    notes: string[]
    sessions: { title?: string; preview?: string; recap?: string }[]
  } | null> {
    const notes = (await this.runtime.memory.list(INSTALL_SCOPE, { limit: IDEAS_NOTES_LIMIT }))
      .map((note) => note.text)
    const sessions = (await this.runtime.listSessions())
      .filter((session) => session.messageCount > 0)
      .slice(0, IDEAS_SESSIONS)
      .map(({ title, preview, recap }) => ({ title, preview, recap }))
    if (notes.length === 0 && sessions.length === 0) return null
    const key = createHash('sha1').update(JSON.stringify({ notes, sessions })).digest('hex')
    return { key, notes, sessions }
  }

  /**
   * Sends the cached ideas to every chat still showing a home. A chat
   * that has spoken has no home to fill, so it is left alone.
   */
  private deliverIdeas(): void {
    const items = this.ideaCache?.items
    if (!items || items.length === 0) return
    const frame: ServerFrame = { type: 'suggestions', items }
    for (const [id, chat] of this.chats) {
      if (chat.session.messages.length === 0) this.broadcast(id, frame)
    }
  }

  private startTurn(chatId: string, text: string, target?: SendTarget, images: ImagePart[] = [], files?: IncomingFile[]): void {
    // A person who is already typing does not want ideas. The call they started
    // is about to be wasted work, so it is cut here rather than left to finish
    // behind the turn and replace cards nobody is looking at any more.
    this.ideaWork?.controller.abort()
    this.ideaWork = null
    // The state frame that *ends* a turn comes from the queue's settle handler
    // below, not from the turn's own `finally`. `busy` is the queue's answer to
    // "is a turn running", and the queue only lets the turn go after this work
    // returns — so a state read inside the body reports the turn still running.
    // Being the last one sent, that left the page's stop button where it was, and
    // pressing it answered "nothing is running to stop". The frame under it is the
    // other half: sent at once, so a message enqueued behind a running turn shows
    // up as queued now rather than when that turn ends.
    this.turns.run(chatId, async (inbox, signal) => {
      const id = randomUUID()
      const activeChat = this.chats.get(chatId)
      // Kept as it is said, frame by frame, for a client that arrives in the middle of
      // it: by then the `turn-start` below is long gone, and the session on disk grows
      // only a step at a time. Keyed by the session, so a sibling screen gets it too;
      // `owner` is the chat whose queue is running it.
      let sessionId = activeChat?.session.id
      let live: LiveTurn | undefined
      if (activeChat && sessionId) {
        live = { id, at: Date.now(), frames: [], from: activeChat.session.messages.length, owner: chatId }
        this.live.set(sessionId, live)
      }
      if (sessionId) this.emitTurn(sessionId, { type: 'turn-start', id, text: files?.length
        ? [text, files.map((file) => `Attached ${file.name}`).join(', ')].filter(Boolean).join('\n')
        : text })
      // Said again now the live turn is open: the state frame the caller sent when it
      // queued this turn read `busy` before the queue had registered it, so it still
      // said false. This is the one that turns the sibling's composer busy.
      this.sendState(chatId)
      let status: 'done' | 'stopped' | 'error' = 'done'
      /** The first refusal the turn itself reported, kept for the written record. */
      let failureReason: string | undefined
      /** The session the failure happened on, which is not always the one still bound. */
      let failedSession: Session | undefined
      const display = readDisplay()
      let currentImages = images
      let currentAudio: import('../../core/providers/types.js').AudioPart[] = []
      let currentFiles = files
      let currentModel: string | undefined
      /** Where this run's messages start, so its raw is the run and not the whole thread. */
      let runFrom: number | undefined
      try {
        let currentText = text || (currentFiles?.length ? 'Please inspect the attached media.' : '')
        while (currentText && !signal.aborted) {
          const chat = this.chats.get(chatId)
          if (!chat) return
          let session = await this.runtime.getSession(chat.scope)
          chat.session = session
          if (runFrom === undefined) runFrom = session.messages.length
          // A turn can outlive the session it opened on (`/new`, a resume): the live
          // turn moves to the session the chat is bound to now, so the screens
          // watching that session keep receiving it and the old key is left clean.
          if (live && session.id !== sessionId) {
            if (sessionId) this.live.delete(sessionId)
            sessionId = session.id
            this.live.set(sessionId, live)
          }
          // Grounded on the session actually in hand, not the cached copy the turn
          // opened with: this is the index the turn's own user message is written at,
          // and what a late client's ready is cut at.
          if (live) live.from = runFrom
          if (currentFiles?.length) {
            const prepared = await prepareIncoming(currentFiles, { model: session.model })
            currentText = [currentText, currentFiles.map((file) => `Attached ${file.name}`).join('\n'), ...prepared.text].filter(Boolean).join('\n\n') || 'Please inspect the attached media.'
            currentImages = [...currentImages, ...prepared.images]
            currentAudio = [...currentAudio, ...prepared.audio]
            currentModel = prepared.model
            currentFiles = undefined
          }
          const command = currentFiles?.length
            ? { handled: false as const }
            : await handleCommand(currentText, this.commandContext(chat, session, signal))
          if (command.handled) {
            session = await this.runtime.getSession(chat.scope)
            chat.session = session
            this.broadcast(chatId, { type: 'command-result', reply: command.reply ?? '', markdown: command.markdown, actions: command.actions, cards: command.cards, sessionId: session.id })
            const queuedText = inbox.shift()
            if (queuedText?.startsWith('/')) {
              const queuedCommand = await handleCommand(queuedText, this.commandContext(chat, session, signal))
              chat.session = await this.runtime.getSession(chat.scope)
              if (queuedCommand.handled) this.broadcast(chatId, { type: 'command-result', reply: queuedCommand.reply ?? '', markdown: queuedCommand.markdown, actions: queuedCommand.actions, cards: queuedCommand.cards, sessionId: chat.session.id })
              currentText = inbox.shift() ?? ''
            } else {
              currentText = queuedText ?? ''
            }
            continue
          }

          for await (const event of session.send(currentText, {
            signal,
            steering: inbox,
            // Whether this chat's clients draw a generated interface, so the
            // teaching reaches the model only where it can be shown: the surface says
            // it draws one, and the setting has been turned on (unset is off — the
            // feature is experimental, and the teaching rides every turn).
            genui: chat.genui === true && display.genui === true,
            // Who is holding the chat: the phone said it is the phone, which
            // the gateway alone cannot tell from a browser. Named per turn, like
            // `genui`, and absent until a client declares one.
            client: chat.client,
            ...(currentImages.length ? { images: currentImages } : {}),
            ...(currentAudio.length ? { audio: currentAudio } : {}),
            ...(currentModel ? { model: currentModel } : {}),
            // A screen may pin where this turn is addressing — the routines screen
            // names a routine's destination, and the tool takes it from here
            // rather than from the chat the turn happens to be running in.
            ...(target ? { origin: target } : {}),
            // What is on the panel, so the model knows what the person is looking
            // at, and where each tab's contents are, without having to ask.
            panel: this.panelFacts(chat),
            ask: async (request) => {
              const permissionId = randomUUID()
              const expiresAt = Date.now() + PERMISSION_TIMEOUT_MS
              // Held on the session's live turn while it waits: the frame below reaches
              // the clients that are here, and this is what a client arriving later is
              // told. The question is the session's own, so any screen bound to it can
              // answer — not only the chat whose queue raised it.
              if (live) live.permission = { id: permissionId, request, expiresAt }
              if (sessionId) this.emitTurn(sessionId, { type: 'permission', id: permissionId, request, expiresAt })
              const result = await this.pending.wait(permissionId, PERMISSION_TIMEOUT_MS, signal, sessionId ?? chatId)
              if (live?.permission?.id === permissionId) live.permission = undefined
              if (sessionId) {
                this.emitTurn(sessionId, {
                  type: 'permission-result',
                  id: permissionId,
                  allowed: result.allowed,
                  ...(result.remember ? { remember: true } : {}),
                })
              }
              return result
            },
          })) {
            if (event.type === 'error') {
              status = 'error'
              failureReason ??= event.message
              failedSession = session
            }
            if (event.type === 'aborted') status = 'stopped'
            // The panel is display state of the surface that draws one — the browser
            // and the phone — not something the other surfaces draw: it is resolved
            // to a view here and sent as its own frame, never as a raw `event`. A
            // `close` request leaves no tabs, which is the model taking the panel down.
            if (event.type === 'panel') {
              this.showPanel(chat, event.request)
              this.broadcast(chatId, { type: 'panel', panel: this.panelView(chat) })
              continue
            }
            displayEvent(event, id, display, (frame) => { if (sessionId) this.emitTurn(sessionId, frame) })
          }
          currentImages = []
          currentAudio = []
          currentModel = undefined
          // The files this turn asked to send, read once it is over. They go
          // through the delivery a routine's answer uses, so the transcript keeps
          // them and a reload serves them again.
          const files = session.takeOutgoing()
          if (files.length > 0) {
            try {
              await this.deliver(chatId, { files })
            } catch (error) {
              this.reportTurnFailure(chatId, id, errorMessage(error))
            }
          }
          currentText = inbox.shift() ?? ''
        }
      } catch (error) {
        // A stop is the person's own doing and needs no explaining; anything else
        // ended a turn that was working, and has to say so where the work was.
        if (signal.aborted) {
          status = 'stopped'
        } else {
          status = 'error'
          this.reportTurnFailure(chatId, id, errorMessage(error))
        }
      } finally {
        const endedChat = this.chats.get(chatId)
        // Cleared before the `turn-end` goes out: the step that just finished is in
        // the session by now, so a client connecting in this gap is handed the whole
        // turn as history instead of a live row nothing would ever close.
        if (live && sessionId && this.live.get(sessionId) === live) this.live.delete(sessionId)
        // The answer's raw copy rides with the turn, so the just-streamed answer has it
        // too — not only a reload, which reads the same rendering back from the transcript.
        // The copy without the output rides beside it, and only where it differs: the two
        // are choices under one control, not two copies of the same words.
        const messages = endedChat && runFrom !== undefined
          ? endedChat.session.messages.slice(runFrom)
          : null
        const raw = messages ? rawTurn(messages) : null
        const noOutput = messages ? rawTurn(messages, { output: false }) : null
        if (sessionId) this.emitTurn(sessionId, { type: 'turn-end', id, status, ...(raw ? { raw } : {}), ...(noOutput && noOutput !== raw ? { rawNoOutput: noOutput } : {}) })
        // The refusal the turn reported is taken down with the turn, so it is written
        // after the turn-end: the live screens have the message's own status, and this
        // is what the chat shows again when it is reopened.
        if (failureReason) {
          void failedSession?.appendNotice(`⚠ the turn failed: ${failureReason}`).catch((error: unknown) => {
            logWarn(`could not write down a failed turn: ${errorMessage(error)}`)
          })
        }
      }
    }, () => this.sendState(chatId))
    this.sendState(chatId)
  }

  /**
   * A turn that died says so where the turn is: on its own message, and written
   * into the session so a reload still shows why. It is not a transient notice —
   * that shape is for a frame the server refused, and work that stopped halfway
   * vanishing without a reason is what makes it look like nothing happened.
   */
  private reportTurnFailure(chatId: string, turnId: string, reason: string): void {
    const session = this.chats.get(chatId)?.session
    // A turn frame, so it reaches every screen on the session — not only the one whose
    // queue started it.
    if (session) this.emitTurn(session.id, { type: 'event', turnId, event: { type: 'error', message: reason } })
    logWarn(`turn failed on web:${chatId}: ${reason}`)
    void session?.appendNotice(`⚠ the turn failed: ${reason}`).catch((error: unknown) => {
      logWarn(`could not write down a failed turn: ${errorMessage(error)}`)
    })
  }

  private async command(client: WebClient, chat: Chat, text: string, messageId?: string): Promise<void> {
    const context = this.commandContext(chat, chat.session, new AbortController().signal)
    // The turn controls act on the session, not the asking chat: `/stop`,
    // `/steer` and `/queue` reach the queue the session's turn is running in.
    const key = this.liveOwner(chat.session.id) ?? chat.scope.chatId
    const result = handleTurnControl(text, {
      turn: turnOf(this.turns, key),
      start: (pending) => this.startTurn(key, pending),
    })
    if (result.handled) {
      client.send({ type: 'command-result', reply: result.reply ?? '', ...(messageId ? { messageId } : {}) })
      this.sendState(chat.scope.chatId)
      return
    }
    // The state frame goes on the queue's settle handler, not inside `work`: read
    // from there it would still say `busy: true` for this very command — a slash
    // command is instantaneous, and the page would be left holding the stop
    // button with nothing running to stop.
    this.turns.run(key, async () => {
      const response = await handleCommand(text, context)
      if (!response.handled) return
      const refreshed = await this.runtime.getSession(chat.scope)
      chat.session = refreshed
      client.send({
        type: 'command-result',
        reply: response.reply ?? '',
        markdown: response.markdown,
        actions: response.actions,
        cards: response.cards,
        sessionId: refreshed.id,
        ...(messageId ? { messageId } : {}),
      })
    }, () => this.sendState(chat.scope.chatId))
  }

  private commandContext(chat: Chat, session: Session, signal: AbortSignal): CommandContext {
    return buildCommandContext({
      runtime: this.runtime,
      scope: chat.scope,
      session,
      // No allowlist, deliberately: this surface is not a bot answering a room.
      // Whoever holds the token *is* the owner, so the single-person lock — which
      // exists to keep one member of a chat from changing what the others get —
      // has nothing to protect here and every setting command stays open.
      signal,
    })
  }

  /**
   * The busy/queued a session is in, sent to every screen bound to it. `busy` is
   * true while a turn runs anywhere the daemon can see it — the owner's queue, or a
   * live turn — so a sibling's composer shows the stop and steer controls rather than
   * a second, idle send. A turn in another process is not seen here; the sessions
   * list carries that one from the store's lease.
   */
  private sendState(chatId: string): void {
    const chat = this.chats.get(chatId)
    if (!chat) return
    const sessionId = chat.session.id
    const key = this.liveOwner(sessionId) ?? chatId
    const frame: ServerFrame = {
      type: 'state',
      busy: this.turns.busy(key) || this.live.has(sessionId),
      queued: this.turns.queued(key),
    }
    for (const bound of this.chatsOf(sessionId)) for (const client of bound.clients) client.send(frame)
  }

  /** Every chat bound to a session — the screens its live turn speaks to. */
  private chatsOf(sessionId: string): Chat[] {
    const found: Chat[] = []
    for (const chat of this.chats.values()) {
      if (chat.session.id === sessionId) found.push(chat)
    }
    return found
  }

  /** The chat whose queue runs this session's turn, when one is running. */
  private liveOwner(sessionId: string): string | undefined {
    return this.live.get(sessionId)?.owner
  }

  private broadcast(chatId: string, frame: ServerFrame): void {
    for (const client of this.chats.get(chatId)?.clients ?? []) client.send(frame)
  }

  /**
   * A frame belonging to the turn running on a session: sent to every screen watching
   * it, and kept whole for whoever arrives late. Only the turn's own frames go through
   * here — they are the ones a client that missed the `turn-start` has no other way to
   * see.
   *
   * Every frame is kept, the steps already written to the session among them: the
   * ready a late client is handed is cut at the turn's start, so those steps are drawn
   * from these frames and nowhere else. Replaying them alongside a ready that also
   * held them is what split one answer into two rows.
   */
  private emitTurn(sessionId: string, frame: ServerFrame): void {
    // The row's sentence rides here, where every turn frame passes: the daemon's own words,
    // so a surface that cannot import them — the phone — draws what the browser draws. It is
    // on the kept frame too, so a client that arrives late replays it with the step.
    const outgoing = withWords(frame)
    this.live.get(sessionId)?.frames.push(outgoing)
    for (const chat of this.chatsOf(sessionId)) {
      for (const client of chat.clients) client.send(outgoing)
    }
  }

  /**
   * Each open chat the jobs of the session it is bound to, and nothing else. Sent to
   * every chat, empty included, so a strip clears the moment its job ends.
   */
  private broadcastJobs(): void {
    for (const chat of this.chats.values()) {
      if (chat.clients.size === 0) continue
      const frame: ServerFrame = { type: 'jobs', jobs: this.jobsView(chat.session.id) }
      for (const client of chat.clients) client.send(frame)
    }
  }

  /**
   * The jobs still running in one session, as its strip draws them. Only the ones
   * still going: a job that ended is announced in the chat, and a strip that kept it
   * would be saying something the chat already said.
   */
  private jobsView(sessionId: string): JobView[] {
    return (this.runtime.jobs?.list(sessionId) ?? [])
      .filter((job) => job.state === 'running')
      .map((job) => ({
        id: job.id,
        command: job.command,
        startedAt: job.startedAt,
        lines: job.lines.slice(-12),
      }))
  }

  /** A session's history as the page renders it; see `transcriptOf`. The display
   *  setting is read now rather than remembered, so a level changed mid-session
   *  reaches the history the next time it is drawn. `through` cuts the history at a
   *  message index — how a late client is handed everything before the running turn. */
  private transcript(session: Session, through?: number): TranscriptMessage[] {
    const messages = through === undefined ? session.messages : session.messages.slice(0, through)
    return transcriptOf(messages, (file) => this.register(file), readDisplay().tools)
  }
}

/** The text and code extensions the panel renders as prose, beyond what MIME knows. */
const TEXT_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.text', '.log', '.csv', '.tsv', '.yml', '.yaml', '.toml',
  '.ini', '.cfg', '.conf', '.env', '.xml', '.css', '.js', '.mjs', '.cjs', '.jsx', '.ts',
  '.tsx', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.c', '.h', '.cpp', '.hpp', '.cs',
  '.php', '.sh', '.bash', '.zsh', '.fish', '.sql', '.lua', '.swift',
])

/**
 * What kind of thing the panel is showing, from what the file is. A page is HTML,
 * rendered live; a document is text or code, drawn as prose; an image and a PDF
 * draw themselves; anything else is a file the panel can only offer to open or
 * download.
 */
function panelKindOf(mimeType: string, name: string): PanelKind {
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType === 'application/pdf') return 'pdf'
  const ext = extname(name).toLowerCase()
  if (ext === '.html' || ext === '.htm' || mimeType === 'text/html') return 'page'
  if (mimeType.startsWith('text/') || mimeType === 'application/json' || TEXT_EXTENSIONS.has(ext)) return 'document'
  return 'file'
}

/**
 * A tab's stable name: the browser's own, or the artifact id — a hash of the path,
 * so it is the same before and after a reload. A click names this rather than a
 * position, which would race the list shifting under it.
 */
function panelKeyOf(state: PanelState): string {
  if (state.kind === 'browser') return 'browser'
  return state.artifact?.id ?? state.kind
}
