import { createHash, randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { deriveIdeas, type Idea } from '../../core/ideas.js'
import type { AgentRuntime } from '../../core/runtime.js'
import type { Session } from '../../core/session.js'
import { INSTALL_SCOPE, type MemoryScope } from '../../core/memory/index.js'
import { isImage, mimeFor, type OutgoingFile, type OutgoingMessage } from '../../core/outgoing.js'
import type { PanelRequest } from '../../core/panel.js'
import { readDisplay } from '../../core/config/load.js'
import { buildCommandContext, handleCommand, handleTurnControl, turnOf, type CommandContext } from '../commands.js'
import { PendingDecisions } from '../pending.js'
import { TurnQueue } from '../turns.js'
import type { ClientFrame, FrameAttachment, PanelInput, PanelKind, PanelState, PanelTab, PanelView, SendTarget, ServerFrame, TranscriptMessage } from './protocol.js'
import { PERMISSION_TIMEOUT_MS } from './protocol.js'
import { displayEvent } from './turn.js'
import { panelsOf, transcriptOf } from './transcript.js'
import type { PanelFacts } from '../../core/agent/system.js'
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
 * Whether an empty home asks for ideas. Off at the owner's request: a product
 * decision to keep the standing four and not spend the call — not the token/URL
 * fragility that was once credited here. Flip this to `true` and un-skip
 * `test/web-ideas.test.ts` to bring it back; nothing else changes.
 */
const IDEAS_ENABLED = false

export interface WebClient {
  send(frame: ServerFrame): void
}

interface Conversation {
  scope: MemoryScope
  session: Session
  clients: Set<WebClient>
  activeTurnId?: string
  /**
   * The panel's tabs, in the order they opened, and the one in front. The requests
   * that made them, not the resolved views: a tab is read from disk afresh each
   * time it is drawn, so an edit shows without reopening anything.
   */
  panel?: { requests: PanelRequest[]; active: number }
}

export class WebHub {
  private readonly conversations = new Map<string, Conversation>()
  private readonly turns = new TurnQueue()
  private readonly pending = new PendingDecisions()
  /**
   * The files delivered into this process's conversations, by id. Only what is
   * here is ever served, so the browser cannot ask for a path of its own naming.
   * Rebuilt from a transcript as conversations are opened, which is why the id is
   * a hash of the path rather than a fresh token each time.
   */
  private readonly attachments = new Map<string, { path: string; name: string; mimeType: string }>()
  private readonly stagedUploads = new Map<string, { file: IncomingFile; expires: number; timer: NodeJS.Timeout }>()
  /**
   * The ideas the home currently gets, and what they were drawn from. One slot,
   * not one per conversation: what grounds them — the notes and the recent
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

  /**
   * `cwd` is only ever needed to resolve a panel's file when a request is read
   * back from a transcript; the server passes its own, and the default matches
   * how a bare path is resolved everywhere else.
   */
  constructor(private readonly runtime: AgentRuntime, private readonly cwd: string = process.cwd()) {}

  async connect(client: WebClient, conversationId: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(conversationId)) throw new Error('Invalid conversation id.')
    let conversation = this.conversations.get(conversationId)
    if (!conversation) {
      const scope: MemoryScope = { gateway: 'web', conversationId }
      conversation = { scope, session: await this.runtime.sessionFor(scope), clients: new Set() }
      this.conversations.set(conversationId, conversation)
    } else if (!this.turns.busy(conversationId)) {
      conversation.session = await this.runtime.getSession(conversation.scope)
    }
    conversation.clients.add(client)
    client.send({
      type: 'ready',
      version: 1,
      sessionId: conversation.session.id,
      messages: this.transcript(conversation.session),
      thinking: readDisplay().thinking,
      // Read from the runtime, not a startup snapshot: a provider switch made at
      // runtime shows on the next connection without the page reconnecting.
      provider: this.runtime.provider.id,
      providerName: this.runtime.providerName,
      model: this.runtime.model,
      effort: this.runtime.reasoningEffort,
      panel: this.panelFor(conversation),
    })
    this.sendState(conversationId)
    // Parked (see `IDEAS_ENABLED`): the standing four stand, and no call is made.
    if (IDEAS_ENABLED && conversation.session.messages.length === 0) this.ensureIdeas()
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
    for (const conversation of this.conversations.values()) conversation.clients.delete(client)
  }

  handle(client: WebClient, frame: ClientFrame, conversationId: string): void {
    const conversation = this.conversations.get(conversationId)
    if (!conversation?.clients.has(client)) return

    if (frame.type === 'control') {
      if (frame.action === 'stop') {
        const result = this.turns.stop(conversationId)
        this.sendState(conversationId)
        if (!result.stopped) client.send({ type: 'error', message: 'Nothing is running to stop.' })
      } else if (frame.id) {
        const allowed = frame.action === 'allow'
        // The permission belongs to the session it was raised in: a client of another
        // session cannot answer it, even holding the id.
        if (this.pending.resolve(frame.id, allowed, conversationId)) {
          client.send({ type: 'permission-result', id: frame.id, allowed })
        } else {
          client.send({ type: 'error', message: 'That permission is no longer waiting.' })
        }
      }
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
      if (files.length) {
        this.startTurn(conversationId, frame.text, frame.target, [], files)
        return
      }
      if (frame.intent === 'steer') {
        const steered = this.turns.steer(conversationId, frame.text)
        if (steered) {
          const turnId = this.conversations.get(conversationId)?.activeTurnId
          if (turnId) this.broadcast(conversationId, { type: 'event', turnId, event: { type: 'steer', text: frame.text } })
          return
        }
      }
      this.startTurn(conversationId, frame.text, frame.target)
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
      this.activateTab(conversationId, frame.key)
      return
    }

    if (frame.type === 'panel-close') {
      this.closeTab(conversationId, frame.key)
      return
    }

    if (frame.type === 'command') void this.command(client, conversation, frame.text).catch((error: unknown) => {
      client.send({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    })

    if (frame.type === 'action') {
      const actionId = frame.actionId
      const messageId = frame.messageId
      // Action buttons and cards (e.g. /sessions pagination) are ephemeral in-memory
      // UI controls that re-invoke the command when interacted with.
      if (actionId.startsWith('sessions:')) {
        const page = actionId.slice('sessions:'.length)
        void this.command(client, conversation, `/sessions ${page}`, messageId).catch((error: unknown) => {
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
    this.runtime.browser?.stopScreencast()
    for (const id of this.conversations.keys()) this.turns.stop(id)
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
   * A routine ran. This is not about one conversation, so it goes to every client
   * on the server: a Routines screen that is open anywhere is showing a history
   * that just changed.
   */
  routinesChanged(): void {
    const frame: ServerFrame = { type: 'routines-changed' }
    for (const conversation of this.conversations.values()) {
      for (const client of conversation.clients) client.send(frame)
    }
  }

  /**
   * Posts a message into a conversation with no turn behind it — how a routine
   * reaches a web chat, and how a live turn's own files reach it too: the answer
   * is already on screen, so the files arrive as their own message. It is written
   * into the conversation's session first, so it is there when the tab is next
   * opened, and then broadcast to whoever is watching right now; the broadcast is
   * a no-op when nobody is. The frame is the one a command reply uses, so the
   * chat renders it and lists it like any other message without the protocol
   * knowing about routines.
   */
  async deliver(conversationId: string, message: OutgoingMessage): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(conversationId)) {
      throw new Error(`not a web conversation id: ${conversationId}`)
    }
    const files = message.files ?? []
    const text = message.text ?? ''
    const session = await this.runtime.getSession({ gateway: 'web', conversationId })
    await session.appendNotice(text, files)
    const attachments = files.map((file) => this.register(file))
    this.broadcast(conversationId, {
      type: 'command-result',
      reply: text,
      markdown: text,
      ...(attachments.length > 0 ? { attachments } : {}),
    })
  }

  /** The file behind an id, for the HTTP layer to stream. Null when none was delivered under it. */
  attachment(id: string): { path: string; name: string; mimeType: string } | null {
    return this.attachments.get(id) ?? null
  }

  /**
   * Notes a delivered file under its id and describes it for the browser. The id
   * is the path's hash, so opening the same conversation again — a reload, a tab
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
   * The panel a conversation was left showing. Seeded once, when the conversation
   * opens, by replaying the requests its history kept through the very rule a live
   * one goes through — so a reload and a fresh show cannot disagree — and resolved
   * afresh on every read, from each file's current contents rather than a snapshot.
   */
  private panelFor(conversation: Conversation): PanelView | null {
    if (!conversation.panel) {
      conversation.panel = { requests: [], active: 0 }
      for (const request of panelsOf(conversation.session.messages)) this.showPanel(conversation, request)
    }
    return this.panelView(conversation)
  }

  /**
   * Puts a request on the panel: its own tab, in front — or, when a tab for it is
   * already open, that one brought forward. Re-showing the same file therefore
   * does not stack a second copy of it, which matters because the model re-shows a
   * report every time it revises it. `close` takes the whole panel down, which is
   * what the model means by it.
   */
  private showPanel(conversation: Conversation, request: PanelRequest): void {
    if (request.close) {
      conversation.panel = { requests: [], active: 0 }
      return
    }
    const state = this.resolvePanel(request)
    if (!state) return
    const tabs = conversation.panel?.requests ?? []
    const key = panelKeyOf(state)
    const existing = tabs.findIndex((one) => {
      const resolved = this.resolvePanel(one)
      return resolved ? panelKeyOf(resolved) === key : false
    })
    conversation.panel = existing >= 0
      ? { requests: tabs, active: existing }
      : { requests: [...tabs, request], active: tabs.length }
  }

  /**
   * The panel as the page draws it: every stored request resolved afresh, with the
   * tabs that no longer resolve dropped — a file that has since gone takes its tab
   * with it, and the one in front shifts with the rest. Null when nothing is left,
   * which is the panel being down.
   */
  private panelView(conversation: Conversation): PanelView | null {
    const panel = conversation.panel
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
      conversation.panel = { requests: [], active: 0 }
      return null
    }
    active = Math.min(active, tabs.length - 1)
    conversation.panel = { requests: kept, active }
    return { tabs, active }
  }

  /**
   * What is on the panel, for the model: which tabs are open and where each one's
   * contents are, so it can talk about them, or read one, rather than ask. The path
   * is the hub's own — the page is never given one — and the browser tab carries
   * the page it is on.
   */
  private panelFacts(conversation: Conversation): PanelFacts {
    const view = this.panelView(conversation)
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
  private activateTab(conversationId: string, key: string): void {
    const conversation = this.conversations.get(conversationId)
    if (!conversation) return
    const index = this.panelView(conversation)?.tabs.findIndex((tab) => tab.key === key) ?? -1
    if (index < 0 || !conversation.panel) return
    conversation.panel = { requests: conversation.panel.requests, active: index }
    this.broadcast(conversationId, { type: 'panel', panel: this.panelView(conversation) })
  }

  /** Closes a tab, by key. Closing the last one leaves the panel down. */
  private closeTab(conversationId: string, key: string): void {
    const conversation = this.conversations.get(conversationId)
    if (!conversation) return
    const index = this.panelView(conversation)?.tabs.findIndex((tab) => tab.key === key) ?? -1
    if (index < 0 || !conversation.panel) return
    const requests = conversation.panel.requests.filter((_, at) => at !== index)
    conversation.panel = { requests, active: Math.min(index, Math.max(0, requests.length - 1)) }
    this.broadcast(conversationId, { type: 'panel', panel: this.panelView(conversation) })
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
    if (this.browserWatchers.size === 0) await browser.startScreencast((frame) => this.fanBrowser(frame))
    this.browserWatchers.add(onFrame)
    let stopped = false
    return () => {
      if (stopped) return
      stopped = true
      this.browserWatchers.delete(onFrame)
      if (this.browserWatchers.size === 0) browser.stopScreencast()
    }
  }

  private fanBrowser(frame: Buffer): void {
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
    if (input.kind === 'key') return browser.key(input.key, signal)
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
   * Sends the cached ideas to every conversation still showing a home. A chat
   * that has spoken has no home to fill, so it is left alone.
   */
  private deliverIdeas(): void {
    const items = this.ideaCache?.items
    if (!items || items.length === 0) return
    const frame: ServerFrame = { type: 'suggestions', items }
    for (const [id, conversation] of this.conversations) {
      if (conversation.session.messages.length === 0) this.broadcast(id, frame)
    }
  }

  private startTurn(conversationId: string, text: string, target?: SendTarget, images: ImagePart[] = [], files?: IncomingFile[]): void {
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
    this.turns.run(conversationId, async (inbox, signal) => {
      const id = randomUUID()
      const activeConversation = this.conversations.get(conversationId)
      if (activeConversation) activeConversation.activeTurnId = id
      this.broadcast(conversationId, { type: 'turn-start', id, text: files?.length
        ? [text, files.map((file) => `Attached ${file.name}`).join(', ')].filter(Boolean).join('\n')
        : text })
      let status: 'done' | 'stopped' | 'error' = 'done'
      const display = readDisplay()
      let currentImages = images
      let currentAudio: import('../../core/providers/types.js').AudioPart[] = []
      let currentFiles = files
      let currentModel: string | undefined
      try {
        let currentText = text || (currentFiles?.length ? 'Please inspect the attached media.' : '')
        while (currentText && !signal.aborted) {
          const conversation = this.conversations.get(conversationId)
          if (!conversation) return
          let session = await this.runtime.getSession(conversation.scope)
          conversation.session = session
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
            : await handleCommand(currentText, this.commandContext(conversation, session, signal))
          if (command.handled) {
            session = await this.runtime.getSession(conversation.scope)
            conversation.session = session
            this.broadcast(conversationId, { type: 'command-result', reply: command.reply ?? '', markdown: command.markdown, actions: command.actions, cards: command.cards, sessionId: session.id })
            const queuedText = inbox.shift()
            if (queuedText?.startsWith('/')) {
              const queuedCommand = await handleCommand(queuedText, this.commandContext(conversation, session, signal))
              conversation.session = await this.runtime.getSession(conversation.scope)
              if (queuedCommand.handled) this.broadcast(conversationId, { type: 'command-result', reply: queuedCommand.reply ?? '', markdown: queuedCommand.markdown, actions: queuedCommand.actions, cards: queuedCommand.cards, sessionId: conversation.session.id })
              currentText = inbox.shift() ?? ''
            } else {
              currentText = queuedText ?? ''
            }
            continue
          }

          for await (const event of session.send(currentText, {
            signal,
            steering: inbox,
            ...(currentImages.length ? { images: currentImages } : {}),
            ...(currentAudio.length ? { audio: currentAudio } : {}),
            ...(currentModel ? { model: currentModel } : {}),
            // A screen may pin where this turn is addressing — the routines screen
            // names a routine's destination, and the tool takes it from here
            // rather than from the chat the turn happens to be running in.
            ...(target ? { origin: target } : {}),
            // What is on the panel, so the model knows what the person is looking
            // at, and where each tab's contents are, without having to ask.
            panel: this.panelFacts(conversation),
            ask: async (request) => {
              const permissionId = randomUUID()
              this.broadcast(conversationId, {
                type: 'permission',
                id: permissionId,
                request,
                expiresAt: Date.now() + PERMISSION_TIMEOUT_MS,
              })
              const allowed = await this.pending.wait(permissionId, PERMISSION_TIMEOUT_MS, signal, conversationId)
              this.broadcast(conversationId, { type: 'permission-result', id: permissionId, allowed })
              return { allowed }
            },
          })) {
            if (event.type === 'error') status = 'error'
            if (event.type === 'aborted') status = 'stopped'
            // The panel is display state of the web surface, not something the
            // other surfaces draw: it is resolved to a view here and sent as its
            // own frame, never as a raw `event`. A `close` request leaves no tabs,
            // which is the model taking the panel down.
            if (event.type === 'panel') {
              this.showPanel(conversation, event.request)
              this.broadcast(conversationId, { type: 'panel', panel: this.panelView(conversation) })
              continue
            }
            displayEvent(event, id, display, (frame) => this.broadcast(conversationId, frame))
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
              await this.deliver(conversationId, { files })
            } catch (error) {
              this.reportTurnFailure(conversationId, id, errorMessage(error))
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
          this.reportTurnFailure(conversationId, id, errorMessage(error))
        }
      } finally {
        this.broadcast(conversationId, { type: 'turn-end', id, status })
        const endedConversation = this.conversations.get(conversationId)
        if (endedConversation?.activeTurnId === id) endedConversation.activeTurnId = undefined
      }
    }, () => this.sendState(conversationId))
    this.sendState(conversationId)
  }

  /**
   * A turn that died says so where the turn is: on its own message, and written
   * into the session so a reload still shows why. It is not a transient notice —
   * that shape is for a frame the server refused, and work that stopped halfway
   * vanishing without a reason is what makes it look like nothing happened.
   */
  private reportTurnFailure(conversationId: string, turnId: string, reason: string): void {
    this.broadcast(conversationId, { type: 'event', turnId, event: { type: 'error', message: reason } })
    logWarn(`turn failed on web:${conversationId}: ${reason}`)
    const session = this.conversations.get(conversationId)?.session
    void session?.appendNotice(`⚠ the turn failed: ${reason}`).catch((error: unknown) => {
      logWarn(`could not write down a failed turn: ${errorMessage(error)}`)
    })
  }

  private async command(client: WebClient, conversation: Conversation, text: string, messageId?: string): Promise<void> {
    const context = this.commandContext(conversation, conversation.session, new AbortController().signal)
    const result = handleTurnControl(text, {
      turn: turnOf(this.turns, conversation.scope.conversationId),
      start: (pending) => this.startTurn(conversation.scope.conversationId, pending),
    })
    if (result.handled) {
      client.send({ type: 'command-result', reply: result.reply ?? '', ...(messageId ? { messageId } : {}) })
      this.sendState(conversation.scope.conversationId)
      return
    }
    this.turns.run(conversation.scope.conversationId, async () => {
      const response = await handleCommand(text, context)
      if (response.handled) {
        const refreshed = await this.runtime.getSession(conversation.scope)
        conversation.session = refreshed
        client.send({
          type: 'command-result',
          reply: response.reply ?? '',
          markdown: response.markdown,
          actions: response.actions,
          cards: response.cards,
          sessionId: refreshed.id,
          ...(messageId ? { messageId } : {}),
        })
      }
      this.sendState(conversation.scope.conversationId)
    })
  }

  private commandContext(conversation: Conversation, session: Session, signal: AbortSignal): CommandContext {
    return buildCommandContext({
      runtime: this.runtime,
      scope: conversation.scope,
      session,
      // No allowlist, deliberately: this surface is not a bot answering a room.
      // Whoever holds the token *is* the owner, so the single-person lock — which
      // exists to keep one member of a chat from changing what the others get —
      // has nothing to protect here and every setting command stays open.
      signal,
    })
  }

  private sendState(conversationId: string): void {
    this.broadcast(conversationId, {
      type: 'state',
      busy: this.turns.busy(conversationId),
      queued: this.turns.queued(conversationId),
    })
  }

  private broadcast(conversationId: string, frame: ServerFrame): void {
    for (const client of this.conversations.get(conversationId)?.clients ?? []) client.send(frame)
  }

  /** A session's history as the page renders it; see `transcriptOf`. */
  private transcript(session: Session): TranscriptMessage[] {
    return transcriptOf(session.messages, (file) => this.register(file))
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
