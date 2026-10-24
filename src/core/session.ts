import { errorMessage, isAbort } from '../util/errors.js'
import { closeParagraph } from '../util/format.js'
import { logDebug, logWarn } from '../util/log.js'
import type { SessionsConfig } from './config/schema.js'
import type { MediaModelsConfig } from './config/schema.js'
import type { BrowserFacts } from './browser/index.js'
import type { GoogleState } from './google/state.js'
import type { McpFacts } from './mcp/servers.js'
import type { HistoryEntry, HistoryWriter } from './history.js'
import { deriveFacts } from './memory/derive.js'
import { scopeKey, DEFAULT_RECALL_LIMIT, type Memory, type MemoryInput, type MemoryItem, type MemoryScope } from './memory/index.js'
import type { SkillSummary } from './skills/index.js'
import { ROUTINE_GATEWAY } from './routines.js'
import { describeOutgoing, type OutgoingFile } from './outgoing.js'
import { DEFAULT_REASONING_EFFORT, type Message, type Provider, type ReasoningEffort } from './providers/types.js'
import type { ModelProfile } from './providers/profile.js'
import type { PermissionAsker, PermissionPolicy, RoutineStore, SendFileFn, SessionAdmin, ToolEffect, ToolRegistry } from './tools/index.js'
import type { JobManager } from './jobs/index.js'
import { approvalKey, isPlanTool, withApprovals, withGrants, withPlan } from './tools/index.js'
import { taskDescription } from './tools/task.js'
import type { AgentEvent } from './agent/events.js'
import { runAgent, type RunTrace } from './agent/loop.js'
import type { TraceWriter } from './traces.js'
import { runSubagent } from './agent/subagent.js'
import { buildSystemPrompt, type PanelFacts, type SurfaceKind, type SystemPromptInput } from './agent/system.js'
import type { Project, ProjectPlacement } from './projects.js'
import { verificationText, type VerificationResult } from './verification.js'
import type { ProjectInstructions } from './agent/instructions.js'
import type { ClientKind } from './client.js'
import {
  contextBudget,
  countMessages,
  countTurns,
  digest,
  dropOldImages,
  dropOldAudio,
  dropOldSnapshots,
  dropOldFetchedPages,
  estimateText,
  estimateTokens,
  estimateTools,
  generateTitle,
  MemoryRecapStore,
  planCut,
  planCutUnderBudget,
  previewOf,
  rankSessions,
  summarize,
  withRecaps,
  type CompactResult,
  type RecapStore,
  type SessionLease,
  type SessionRecord,
  type SessionStats,
  type SessionStore,
  type SessionSummary,
} from './sessions/index.js'

const SURFACES: SurfaceKind[] = ['cli', 'telegram', 'discord', 'web', 'ios']

/**
 * What counts as "the turn wrote something" for the verification gate. A shell
 * command is here whether it wrote or not: the command is the act, and the tool
 * cannot say what it left behind.
 */
const VERIFICATION_WRITES = new Set([
  'write_file',
  'edit_file',
  'apply_patch',
  'format',
  'shell_command',
  'git_commit',
])

interface PreparedCompaction {
  provider: Provider
  model: string
  ceiling: number
  fixed: number
  previous?: string
  cut: number
  prefix: Message[]
  startedAt: number
  done: boolean
  finishedAt?: number
  summary: Promise<string | null>
}

function asSurface(gateway: string): SurfaceKind | undefined {
  return (SURFACES as string[]).includes(gateway) ? (gateway as SurfaceKind) : undefined
}

/**
 * Where this turn is being held. The gateway alone cannot say it: the phone reaches
 * the same web gateway the browser does, so a client that named itself in the
 * handshake is what tells the two apart — and its kind is the surface it is.
 */
function surfaceOf(gateway: string, client?: ClientKind): SurfaceKind | undefined {
  return client ?? asSurface(gateway)
}

/** Let a stopped turn leave a background compaction wait without cancelling its cached summary. */
function awaitPreparedSummary(summary: Promise<string | null>, signal?: AbortSignal): Promise<string | null> {
  if (!signal) return summary
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('the turn was stopped'))
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('the turn was stopped'))
    signal.addEventListener('abort', onAbort, { once: true })
    summary.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/** Whether a surface can draw a generated interface: the browser and the phone. */
function canDraw(surface: SurfaceKind | undefined): boolean {
  return surface === 'web' || surface === 'ios'
}

/**
 * Whether a surface can draw a panel beside its chat. The same two surfaces as
 * `canDraw` today, but a rule of its own: a panel is a place for tabs, and a
 * surface that can draw a widget is not thereby one that has somewhere to put
 * a file.
 */
function canPanel(surface: SurfaceKind | undefined): boolean {
  return surface === 'web' || surface === 'ios'
}

/**
 * Whether a surface can receive a file the turn sends. The terminal is the one
 * that cannot: it has nowhere to put a file, so `send_file` stays out of its
 * catalog rather than being offered to fail on.
 */
function receivesFiles(surface: SurfaceKind | undefined): boolean {
  return surface !== undefined && surface !== 'cli'
}

export interface SessionOptions {
  scope: MemoryScope
  provider: Provider
  providerFor?: (model: string) => Provider
  mediaModels?: MediaModelsConfig
  model: string
  system: string
  registry: ToolRegistry
  memory: Memory
  cwd: string
  /**
   * The project this session works in: where it is, or why the one on its record
   * cannot be found. Absent on a session with no project.
   */
  project?: ProjectPlacement
  /**
   * The rules of the session's project folder, read once per prompt like the skills:
   * its own `AGENTS.md`, or why there is none to carry. A getter rather than the
   * text, so an edit to that file lands on the next turn without a restart.
   */
  instructions?: () => ProjectInstructions
  /**
   * The rules of this install itself, read once per prompt like the skills. Above
   * the project's own and absent when `~/.milo/AGENTS.md` does not exist.
   */
  ownInstructions?: () => ProjectInstructions
  /**
   * How the shell is contained: `workspace` puts every command in `bwrap` with the
   * project's folder writable and the rest of the machine read only. Off unless
   * the config asks for it.
   */
  sandbox?: 'off' | 'workspace'
  /**
   * The project's own checks, run after a turn that wrote. Absent when the
   * verification gate is off, which is the default — a command run after every
   * writing turn is a change in how a conversation behaves.
   */
  verify?: (project: Project) => Promise<VerificationResult>
  /**
   * Reads the skills to index in the system prompt, once per prompt; the bodies
   * load on demand. A getter rather than a list, so a skill installed while Milo
   * is running is indexed on the next turn.
   */
  skills?: () => SkillSummary[]
  maxSteps?: number
  maxTokens?: number
  temperature?: number
  recallLimit?: number
  /**
   * Whether a finished turn is read for facts worth keeping. Off unless a caller
   * asks for it: it is a model call of its own on every turn, so a surface that
   * builds a session directly — a test, a script — is not charged for it.
   */
  derive?: boolean
  permissionPolicy?: PermissionPolicy
  /** The record this session reads from and writes back to. */
  record: SessionRecord
  store: SessionStore
  /** Where this session's recap is kept, out of its transcript. */
  recaps?: RecapStore
  sessions?: SessionsConfig
  /** Where a turn is written down for later recall. Absent: nothing is logged. */
  history?: HistoryWriter
  /** Where each request, tool and turn is timed and written down. Absent: nothing is logged. */
  traces?: TraceWriter
  /**
   * The install's routine list, for a turn that may read it and change it. Absent
   * on a caller that cannot touch routines — and a routine's own run never gets
   * one, so it cannot make, change or drop another.
   */
  routine?: RoutineStore
  /**
   * The install's session list, for a turn that may read it and prune it. Absent
   * on a bare test session; a routine's own run and a surface that pools several
   * people's sessions withhold it the same way the routine tool is withheld.
   */
  sessionAdmin?: { list(): Promise<SessionSummary[]>; remove(id: string): Promise<boolean> }
  /**
   * The chat this session's turns deliver files to, when it is not the chat they
   * are already in. Set on a routine's own run, whose target was named when it
   * was made and must not be rerouted to whichever surface is live. Absent
   * everywhere else, where the live surface the turn talks through is the
   * destination.
   */
  deliverTo?: { gateway: string; chatId: string }
  /**
   * Tools this run may use with nobody to ask — a routine's standing grants,
   * decided by the person when it was created. Layered on the policy for this
   * session only, and only where the rules do not bar the act anyway.
   */
  grantedTools?: string[]
  /**
   * What is known about a model: its window, output ceiling and whether it
   * reasons. Swapped in tests, so a test never has to reach the network to know
   * how big a model is.
   */
  modelProfile?: (model: string) => Promise<ModelProfile | undefined>
  /**
   * How hard the model should think, read per turn. A function rather than a
   * value so a surface can change it without the session being rebuilt.
   */
  reasoningEffort?: () => ReasoningEffort
  /**
   * How many page snapshots a request may carry once a turn is under way. The
   * browser's own setting, threaded here because the transcript is what pays.
   */
  keepSnapshots?: number
  /** What the browser is right now, read per turn. Absent when there is none. */
  browser?: () => BrowserFacts | null
  /** The external tool servers as they are, read per turn. Absent when there are none. */
  mcp?: () => McpFacts | null
  /** The Google grant as this run sees it. Absent when the runtime was built without it. */
  google?: GoogleState | null
  /**
   * The background jobs of this process. Read per turn for the prompt's live-state
   * line, and handed to `shell_command` so a turn may leave a command running.
   * Absent on a session with none behind it — a routine's own run shares the one.
   */
  jobs?: JobManager | null
  /**
   * Called when this copy's last piece of work in flight ends — a turn, or the
   * fact extraction after one. The runtime uses it to let go of a session that
   * no conversation is bound to any more.
   */
  onIdle?: (session: Session) => void
  /**
   * Called when this session begins a turn and again when it is over — the plain fact
   * "a turn ran here", whatever asked for it. It is how a surface that is not the one
   * talking is told the install's work moved: the runtime hands every session it makes
   * the same one, so a turn from a gateway or a routine is announced like any other.
   * The phase is the caller's own: a turn begins on the surface that asked for it, while
   * its end can arrive after that surface is gone.
   */
  onTurn?: (phase: 'start' | 'end') => void
  /**
   * Called when a step of a turn here may have changed something in the folder — a file
   * written, an edit, a command — and not for one that only read. The runtime hands every
   * session it makes the same one, which is how a screen showing a folder re-reads it
   * while the turn is still running rather than only once it is over.
   */
  onSideEffect?: () => void
}

export interface SendOptions {
  signal?: AbortSignal
  /** The surface's inline confirmation prompt for tools that need it. */
  ask?: PermissionAsker
  /**
   * The address this turn speaks to, when the surface pins one — a routine made
   * from a screen that named its destination. Absent, the session's own chat is
   * the address. Memory stays scoped by the session's scope either way.
   */
  origin?: MemoryScope
  /**
   * Where the surface hands in a message sent while this turn is already
   * running. The array belongs to the caller and is emptied as the messages are
   * taken up, so whatever is still in it when the turn ends was never seen — the
   * caller runs it as its own turn instead of losing it.
   */
  steering?: string[]
  /** Images attached to this message, persisted by path to keep the transcript light. */
  images?: import('./providers/types.js').ImagePart[]
  audio?: import('./providers/types.js').AudioPart[]
  model?: string
  /**
   * What the surface's panel is showing, when it has one — the web chat's tabs, so
   * the model knows what the person is looking at and can read a tab's file without
   * being told where it is. Absent on a surface with no panel.
   */
  panel?: PanelFacts | null
  /**
   * An instruction with no message behind it. The turn runs with this on the
   * system prompt and nothing added to the transcript as coming from the person —
   * what a finished background job uses to make Milo speak without putting words
   * in anyone's mouth. Absent on an ordinary turn.
   */
  notice?: string
  /**
   * Whether the surface this turn is talking through draws a generated interface.
   * A client declares it when it connects — the web app does — and the hub hands it
   * here on every turn. Absent, or any surface but the web, draws nothing.
   */
  genui?: boolean
  /**
   * The client app this turn is talking to, when it named itself — the phone says
   * it is the phone. It reaches the same web gateway the browser does, so this is
   * what makes the surface the phone rather than a browser. Absent, the gateway
   * names the surface on its own.
   */
  client?: ClientKind
  /**
   * Whether this surface may manage the install's sessions. False on a bot that
   * answers several people — one member listing or pruning them would expose the
   * others' — so the `sessions` tool is withheld from that turn's catalog, the
   * same rule the `/sessions` command is locked by. Defaults to true; the
   * terminal and the web are single-person and never pass it.
   */
  sessionsAllowed?: boolean
}

export class Session {
  /** The session's own name (`calm-otter-7`), not the transport address. */
  readonly id: string
  readonly messages: Message[]
  /** Where this session is currently talking to; memory is scoped by it. */
  scope: MemoryScope
  private readonly record: SessionRecord
  private readonly store: SessionStore
  private readonly recaps: RecapStore
  private readonly options: SessionOptions
  private summary: string | undefined
  /**
   * The "Always" answers given in this conversation, by approval key. Kept in
   * memory on purpose: a restart is a new conversation, and a standing yes from
   * an earlier run is not one the person can still see.
   */
  private readonly approved = new Set<string>()
  /** Whether the turn in flight has changed something; reset when it starts. */
  private wroteThisTurn = false
  /** The revision this session's copy of the transcript was built from. */
  private baseVersion: number
  /**
   * Size of everything the last request carried besides the transcript — the
   * system prompt and the tool schemas — which the transcript count omits.
   */
  private lastFixedTokens: number | undefined
  /** A summary prepared between turns, ready before a full context forces a wait. */
  private preparedCompaction: PreparedCompaction | undefined
  /** The ceiling the transcript is measured against, once the window is known. */
  private ceiling: number | undefined
  /** The lookup in flight: a turn waits on it only if it has not finished. */
  private readonly resolving: Promise<void>
  /**
   * Model calls this session started and nobody waits on: a finished turn being
   * read for facts, and the name drawn from the turn it opened with. One set, so
   * `busy` and `settle` cannot cover one of them and forget the other.
   */
  private readonly background = new Set<Promise<void>>()
  /**
   * Files the running turn asked to send to its chat, held until the turn ends.
   * Held rather than sent at once because a delivery takes the session's lease —
   * the same one the turn holds for as long as it runs.
   */
  private outgoing: OutgoingFile[] = []
  /**
   * Whether the turns that follow are planning turns: read the folder, propose,
   * change nothing. Kept on the session rather than on one turn, because a plan
   * may take more than one turn to settle; a surface turns it off when the plan
   * is approved, and `clear` turns it off with the conversation it belonged to.
   */
  private plan = false
  /** Turns of this copy in flight, the wait for the lease included. */
  private sending = 0

  constructor(options: SessionOptions) {
    this.options = options
    this.record = options.record
    this.store = options.store
    this.recaps = options.recaps ?? new MemoryRecapStore()
    this.id = options.record.id
    this.scope = options.scope
    this.messages = options.record.messages
    this.summary = options.record.summary
    this.baseVersion = options.record.version
    // Asked for now, while the user is still typing, so the first turn does not
    // wait on a lookup that is only about how big the model is.
    this.resolving = this.computeCeiling()
      .then((ceiling) => {
        this.ceiling = ceiling
      })
      .catch(() => {
        // No window, no ceiling: the configured one stands.
      })
  }

  /** The model the next turn runs on. Read per turn, so a switch needs no rebuild. */
  get model(): string {
    return this.options.model
  }

  /**
   * Switches the model for the turns that follow. The context window is a fact
   * about the model, so the ceiling derived from the old one is asked for again.
   */
  setModel(model: string): void {
    if (model === this.options.model) return
    this.options.model = model
    void this.computeCeiling()
      .then((ceiling) => {
        this.ceiling = ceiling
      })
      .catch(() => {
        // No window for the new model: the configured ceiling stands.
      })
  }

  /**
   * Switches the provider the turns that follow run through. A model can
   * resolve to another wire, so the runtime hands the new one to the sessions
   * it already opened rather than leaving them on the previous.
   */
  setProvider(provider: Provider): void {
    this.options.provider = provider
  }

  setMediaModels(mediaModels: MediaModelsConfig | undefined): void {
    this.options.mediaModels = mediaModels
  }

  /** Whether this session's turns are planning turns. Read by the surface that draws the switch. */
  get planMode(): boolean {
    return this.plan
  }

  /**
   * Turns planning on or off for the turns that follow. Not written to the record:
   * a restart is a safe place to leave it, and a session resumed from disk starts
   * ready to work rather than stuck proposing.
   */
  setPlan(plan: boolean): void {
    this.plan = plan
  }

  /**
   * What the execution log calls this session's work. The surface is the scope's
   * own gateway, so a routine's run reads as `routine` rather than as nothing.
   * Absent when logging is off, which is what keeps the loop from setting a tag.
   */
  private runTrace(purpose: string): RunTrace | undefined {
    const traces = this.options.traces
    return traces ? { traces, purpose, surface: this.scope.gateway, session: this.id } : undefined
  }

  /**
   * The ceiling a request is measured against. The rule lives in one place, so
   * the surface that draws a context meter fills the same bar the fold acts on.
   */
  private async computeCeiling(): Promise<number | undefined> {
    const config = this.options.sessions
    if (!config?.compaction) return undefined
    // Nothing is asked for unless a caller wired a lookup in: a session that
    // reached the network on its own would make every test a network test.
    const profile = config.contextWindow ? undefined : await this.options.modelProfile?.(this.options.model)
    const window = config.contextWindow ?? profile?.context
    // A model that folds at its own share overrides the install's one, without
    // losing the rest of the session rules.
    const rules = profile?.compactionAt ? { ...config, compactAt: profile.compactionAt } : config
    return contextBudget(rules, window)
  }

  /**
   * Read per prompt build, and by both callers that build one — the request, and
   * the budget that measures it. Two different answers there would mean a budget
   * saying a request fits while the request is bigger.
   */
  private browserFacts(): BrowserFacts | null {
    return this.options.browser?.() ?? null
  }

  /**
   * Unlike the browser, this is not derivable from the tool catalog: a server
   * that is off or failed registers no tools, so the manager's own report is the
   * only place its name and its reason survive. Read live, per prompt build.
   */
  private mcpFacts(): McpFacts | null {
    return this.options.mcp?.() ?? null
  }

  get title(): string | undefined {
    return this.record.title
  }

  /**
   * Whether this copy still has work in flight: a turn (or its wait for the
   * lease), or a background model call it started. A copy that is busy must stay
   * the one the runtime hands out, or a second copy would race it.
   */
  get busy(): boolean {
    return this.sending > 0 || this.background.size > 0
  }

  /**
   * The project this session works in, when it works in one: where it is, or why the folder
   * on its record cannot be used. The placement the turn was given, carried out to a surface
   * that names it — not a second look at the record, so a bar and the turn never disagree.
   */
  get project(): ProjectPlacement | undefined {
    return this.options.project
  }

  /**
   * Renames the session and writes it down. Under the lease, for the reason
   * `clear` gives: a rename sent from a copy the file has already moved past would
   * be refused at best, and would write back a transcript that dropped the turns
   * written since that copy was read at worst.
   */
  async rename(title: string): Promise<void> {
    const trimmed = title.trim()
    const lease = await this.store.acquire(this.id)
    try {
      if (lease.latest) this.adoptLatest(lease.latest)
      this.record.title = trimmed || undefined
      this.record.version = this.baseVersion + 1
      await this.store.save(this.record, this.baseVersion)
      this.baseVersion = this.record.version
    } finally {
      await lease.release()
    }
  }

  /**
   * Gives the session a name nobody asked for, unless it already has one. True
   * when it wrote.
   *
   * The check sits here, immediately before the write, rather than at the caller:
   * a name is drawn in the background, so the person can name the session — or
   * another process can — in the second the model takes, and a name they chose is
   * never the one to lose. Under the lease for the reason `rename` gives.
   */
  async nameIfUnnamed(title: string): Promise<boolean> {
    const trimmed = title.trim()
    if (!trimmed) return false
    const lease = await this.store.acquire(this.id)
    try {
      if (lease.latest) this.adoptLatest(lease.latest)
      if (this.record.title) return false
      this.record.title = trimmed
      this.record.version = this.baseVersion + 1
      await this.store.save(this.record, this.baseVersion)
      this.baseVersion = this.record.version
      return true
    } finally {
      await lease.release()
    }
  }

  /**
   * A conversation turn. The session is taken exclusively for as long as it runs
   * — two terminals both bind `cli:main`, and a daemon may hold a session a
   * terminal resumes — so this is what keeps one turn from being folded into the
   * middle of another.
   *
   * The lease is taken, and released in the one `finally` below, in this frame.
   * Nothing may take it on another frame's behalf: a reader that stops at any of
   * the yields in between closes this generator, and whatever frame holds the
   * lease then is the one that has to let it go.
   */
  async *send(input: string, opts?: SendOptions): AsyncGenerator<AgentEvent> {
    const signal = opts?.signal
    let lease: SessionLease | null = null
    /** Whether a turn actually ran, so the end is announced only where a begin was. */
    let ranTurn = false
    this.sending += 1
    try {
      const free = await this.store.tryAcquire(this.id)
      if (free) {
        lease = free
      } else {
        // Another Milo is mid-turn on this conversation. Said before waiting: a
        // silent wait is indistinguishable from a model that is thinking.
        yield { type: 'waiting' }
        const began = Date.now()
        try {
          lease = await this.store.acquire(this.id, { signal })
        } catch (error) {
          // A stop is not a failure here either: the wait for the session is as
          // interruptible as the turn itself.
          if (isAbort(error, signal)) yield { type: 'aborted' }
          else yield { type: 'error', message: errorMessage(error) }
          return
        }
        // Said to be over as soon as it is. The turn starts at this line, not at
        // the first token: everything after is the model, and a surface timing
        // the turn must not charge the model for the queue it waited in.
        yield { type: 'waited', ms: Date.now() - began }
      }

      // The record was deleted while this copy was open — by a `/rm` elsewhere,
      // or by hand. Saying so beats running a turn whose transcript can never be
      // written back, which would come out as a version conflict and read as if
      // somebody else had merely changed the session.
      if (!lease.latest) {
        yield { type: 'error', message: `session ${this.id} no longer exists` }
        return
      }
      const rebound = this.adoptLatest(lease.latest)
      if (rebound) yield { type: 'rebased', ...rebound }
      // The turn is about to run. Said with the lease already held, so a screen that
      // re-reads the install's sessions finds this one and draws it running.
      ranTurn = true
      this.options.onTurn?.('start')
      yield* this.turn(input, opts)
    } finally {
      try {
        await lease?.release()
      } finally {
        this.sending -= 1
        this.notifyIfIdle()
        // Said after the lease is let go, so the same re-read finds it over: the frame
        // and the store agree by the time a screen acts on it.
        if (ranTurn) this.options.onTurn?.('end')
      }
    }
  }

  /** Tells the owner this copy has nothing left in flight; see `busy`. */
  private notifyIfIdle(): void {
    if (!this.busy) this.options.onIdle?.(this)
  }

  /**
   * A turn with no message behind it: an instruction Milo acts on and answers in
   * the transcript, without the person having said anything — what a finished
   * background job uses to speak up. It takes the lease like any turn, so it lands
   * right after whatever the conversation is already doing.
   */
  notify(instruction: string, opts?: SendOptions): AsyncGenerator<AgentEvent> {
    return this.send('', { ...opts, notice: instruction })
  }

  private async *turn(input: string, opts?: SendOptions): AsyncGenerator<AgentEvent> {
    const {
      system,
      registry,
      memory,
      cwd,
      maxSteps,
      temperature,
      permissionPolicy,
    } = this.options
    const startedAt = Date.now()
    const model = opts?.model ?? (opts?.images?.length ? this.options.mediaModels?.vision : undefined) ?? this.options.model
    // What is known about the model this turn runs on: its own output ceiling and
    // whether it has a reasoning mode. Absent fields keep the config's rule.
    const profile = await this.options.modelProfile?.(model)
    const maxTokens = profile?.maxOutput ?? this.options.maxTokens
    const provider = opts?.model || (opts?.images?.length && this.options.mediaModels?.vision)
      ? this.options.providerFor?.(model) ?? this.options.provider
      : this.options.provider
    const signal = opts?.signal
    const steering = opts?.steering
    // Read once for the turn: a switch flipped mid-turn is the next turn's business,
    // not something that changes the catalog under the model's feet.
    const plan = this.plan

    // What this turn leaves in the log: the question, every tool it ran, and
    // what it answered — with the reasoning that got there.
    const entries: HistoryEntry[] = []
    const note = (entry: Omit<HistoryEntry, 'at' | 'session' | 'scope'>) => {
      entries.push({
        at: new Date().toISOString(),
        session: this.id,
        scope: scopeKey(this.scope),
        ...entry,
      })
    }
    let answer = ''
    let reasoning = ''
    let running: { name: string; args: unknown } | null = null

    // A tool with nothing to act on is absent from the catalog, and `send_file`
    // needs a chat that can receive a file: a routine's named target, or the live
    // surface the turn is talking through. The terminal is the one surface with
    // nowhere to put one, so the tool stays out of its list. `panel` needs a
    // surface that can draw one — the browser and the phone — so it is withheld
    // from every other catalog the same way. (A subagent filters `task` out of its
    // own list too.)
    const surface = surfaceOf(this.scope.gateway, opts?.client)
    const canSendFiles = this.options.deliverTo !== undefined || receivesFiles(surface)
    // A generated interface needs a surface that can draw one *and* a client that
    // said it would draw it: a surface that draws alone is not enough, or every web
    // chat would draw and a plain one could not exist beside it. There is no tool
    // to withhold — the teaching goes in the prompt — so this is the whole gate.
    // Nothing is taught to a surface that cannot draw it: a widget sent to a chat
    // with no way to show it is a thing that vanishes rather than fails.
    const draws = canDraw(surface) ? opts?.genui : undefined
    // What this turn may read and prune. A routine's own run gets none — like the
    // routine list, sessions are the install's, and a run that fired on a timer is
    // not the place to sweep them. A bot answering several people gets none either:
    // the list pools every member's sessions, which is why `/sessions` is locked
    // there, and the agent is held to the same rule.
    const adminSource = this.options.sessionAdmin
    const sessionAdmin: SessionAdmin | undefined =
      adminSource && this.scope.gateway !== ROUTINE_GATEWAY && (opts?.sessionsAllowed ?? true)
        ? {
            current: this.id,
            list: () => adminSource.list(),
            remove: (id) => adminSource.remove(id),
          }
        : undefined
    // The catalog is what the model reads, so the one rule that depends on where
    // the turn works is said there: in a project, delegation is the model's call.
    const inProject = this.options.project?.ok === true
    const tools = registry.specs().filter((tool) => tool.name !== 'send_file' || canSendFiles)
      .filter((tool) => tool.name !== 'panel' || canPanel(surface))
      .filter((tool) => tool.name !== 'sessions' || sessionAdmin !== undefined)
      // A planning turn may read, keep Milo's own state, or delegate; it may not
      // write, run a command, commit, send a file, or prune the install's sessions.
      .filter((tool) => !plan || isPlanTool(registry.get(tool.name)))
      .map((tool) => (tool.name === 'task' ? { ...tool, description: taskDescription(inProject) } : tool))
    // An instruction-only turn has nothing of the person's to recall against.
    const recalled = opts?.notice
      ? []
      : (
          await memory.recall(this.scope, input, {
            limit: this.options.recallLimit ?? DEFAULT_RECALL_LIMIT,
          })
        ).sort((a, b) => a.text.localeCompare(b.text))
    const prompt = {
      base: system,
      surface,
      routine: this.scope.gateway === ROUTINE_GATEWAY,
      cwd,
      // Which project this session is working in, when it has one: the turn is
      // told what it is working on, not only where the folder is.
      project: this.options.project,
      // The project's own rules, read per turn: the folder a session works in says
      // how it is to be worked in, and an edit to that file lands on the next turn.
      instructions: this.options.instructions?.(),
      // The install's own rules, above the folder's: read per turn for the same
      // reason, so a rule written into `~/.milo/AGENTS.md` lands on the next one.
      ownInstructions: this.options.ownInstructions?.(),
      provider: provider.id,
      model,
      // The shape of this turn, not a fact of the session: a planning turn is told
      // to propose, and the catalog it was handed has nothing to write with.
      plan,
      // The shell's box, so the turn knows a network command will fail and a
      // write outside the folder is refused before it tries one.
      sandbox: this.options.sandbox,
      // The session this turn is in, so a question about it is answerable without
      // going to read the sessions directory.
      sessionId: this.id,
      tools,
      skills: this.options.skills?.(),
      // How this turn draws, when it draws: `block` is taught the block here,
      // because a transport told only in prose has nowhere else to be taught.
      genui: draws,
      memories: recalled,
      // Per turn, from the surface: the prompt is frozen for the turn once built,
      // and what the model opens mid-turn is reported by its own tool result.
      panel: opts?.panel ?? null,
      // Read live, like the panel: a job started a step ago is in the line the
      // next turn sees, and one that ended is not. Only this session's: another
      // conversation's work is not this turn's to report.
      jobs: this.options.jobs?.facts(this.id) ?? null,
    }

    // Measured against the request that will actually be sent: the tool list, the
    // recalled memories and the running summary ride along with every turn, and
    // leaving them out of the count let the request go over budget. The fold
    // reports itself too — it says the wait is a fold before buying the summary,
    // and what it came to once it has one.
    const incoming: Message[] = opts?.notice
      ? []
      : [{ role: 'user', content: [{ type: 'text', text: input }, ...(opts?.images ?? []), ...(opts?.audio ?? [])] }]
    yield* this.compactIfNeeded(prompt, signal, provider, model, incoming)

    const systemPrompt = buildSystemPrompt({
      ...prompt,
      summary: this.summary,
      browser: this.browserFacts(),
      mcp: this.mcpFacts(),
      google: this.options.google ?? null,
    })
    // An instruction with no message behind it rides the system prompt, the way
    // the out-of-steps closing request does — the transcript is never left
    // carrying a sentence nobody said.
    const turnSystem = opts?.notice ? `${systemPrompt}\n\n${opts.notice}` : systemPrompt
    // What every request carries besides the transcript: the prompt, and the tool
    // schemas the wire sends beside it. The transcript count is measured against
    // this, so leaving the catalog out said a request fitted while it did not.
    this.lastFixedTokens = estimateText(turnSystem) + estimateTools(tools)

    // Nothing the person said means nothing added to the transcript as theirs; the
    // instruction above is the whole of this turn's prompt.
    if (!opts?.notice) {
      this.messages.push({ role: 'user', content: [{ type: 'text', text: input }, ...(opts?.images ?? []), ...(opts?.audio ?? [])], at: Date.now() })
      note({ kind: 'user', text: input })
    }

    // The turn's one signal, one permission decision and one effort, shared by
    // the turn and by any subagent it delegates to.
    const abort = signal ?? new AbortController().signal
    // A model that declared it has no reasoning mode is not sent an effort: the
    // field is a guess about a mode it does not have, and some wires refuse it.
    const effort = profile?.reasoning === false
      ? undefined
      : this.options.reasoningEffort?.() ?? DEFAULT_REASONING_EFFORT
    // A plan is a promise with a gate behind it: the catalog hides the writes, and
    // the policy refuses one that reaches the gate anyway — a subagent's own call,
    // a tool from a source that filtered nothing. The grant is layered first so a
    // standing grant cannot widen a planning turn.
    const granted = permissionPolicy
      ? withGrants(permissionPolicy, this.options.grantedTools ?? [], cwd)
      : undefined
    const shaped = granted ? (plan ? withPlan(granted) : granted) : undefined
    // What this conversation already said "Always" to, and what it says during
    // this turn: the answer is added after the surface replies, so the next call
    // with the same key does not ask again.
    const policy = shaped ? withApprovals(shaped, this.approved, cwd) : undefined
    const asker = opts?.ask
    const ask: PermissionAsker | undefined = asker
      ? async (request) => {
          const result = await asker(request)
          if (result.allowed && result.remember) {
            const key = approvalKey(request.tool, request.args, cwd)
            if (key) this.approved.add(key)
          }
          return result
        }
      : undefined
    const permission = policy ? { policy, ask, cwd } : undefined
    // One watcher for both jobs: the surface that re-reads the folder, and the
    // mark that says this turn wrote, which is what the gate acts on.
    const sideEffect = (effect: ToolEffect): void => {
      if (VERIFICATION_WRITES.has(effect.tool)) this.wroteThisTurn = true
      this.options.onSideEffect?.()
    }
    // Read through `this.scope` at call time: a gateway can rebind the session
    // to another conversation while it is running.
    const remember = (items: MemoryInput[]) => memory.remember(this.scope, items)
    const recall = (query: string, options?: { limit?: number }) =>
      this.recallSessions(query, options)
    // What the `memories` tool reads and drops: the list `/memory` shows, and the
    // mirror of `remember`. The ids are the fronts the prompt shows, and the ones
    // that matched nothing come back so the tool can say so rather than claim a
    // deletion that never happened.
    const memories = {
      list: (opts?: { limit?: number; offset?: number }) => memory.list(this.scope, opts),
      forget: async (ids: string[]) => {
        const forgotten: string[] = []
        const unknown: string[] = []
        for (const id of ids) {
          if (await memory.forget(this.scope, id)) forgotten.push(id)
          else unknown.push(id)
        }
        return { forgotten, unknown }
      },
    }
    // A routine's own run is the one conversation that must not touch routines:
    // without this, a routine could add, change or drop routines every time it
    // fires.
    const routine = this.scope.gateway === ROUTINE_GATEWAY ? undefined : this.options.routine
    // What this turn asks to send, and whether it has a chat to send it to: the
    // live surface it is talking through, or a routine's named target. A delivery
    // must not be rerouted, so the destination is fixed before the turn runs.
    this.outgoing = []
    // The gate is about this turn, not the last one.
    this.wroteThisTurn = false
    const sendFile: SendFileFn | undefined = canSendFiles
      ? async (input) => {
          const file = describeOutgoing(input.path, input.caption)
          this.outgoing.push(file)
          return file
        }
      : undefined
    // Where this turn is addressing. A surface that named the destination — the
    // routines screen — pins it, and a tool that defaults to "the chat this
    // request came from" then means that chat.
    const origin = opts?.origin ?? this.scope

    // Where this turn's own first message will land, and how long the turn took to
    // say anything: reasoning, prose and a call are all an output, and the first of
    // them is what the line over a thought counts the wait to.
    const firstNew = this.messages.length
    let firstOutputMs: number | undefined

    let errored = false

    try {
      // Persist the user's message now, so a crash mid-answer does not lose it.
      // Inside the try because a store that refuses the write — another process
      // having moved the session on — has to be reported, not thrown past the
      // caller's event loop.
      await this.persist()
      for await (const event of runAgent({
        provider,
        model,
        system: systemPrompt,
        tools,
        registry,
        messages: this.messages,
        context: {
          cwd,
          signal: abort,
          // A project's folder is the boundary for writes: the session was pointed
          // at it, so changing something outside it is not this turn's business.
          confineTo: this.options.project?.ok ? this.options.project.project.path : undefined,
          sandbox: this.options.sandbox,
          remember,
          memories,
          recall,
          origin,
          sessionId: this.id,
          routine,
          sessionAdmin,
          sendFile,
          jobs: this.options.jobs ?? undefined,
          // A subtask runs in its own context, but under this turn's model,
          // tools, permissions and stop: the same `ask` puts the subagent's
          // confirmations to the user, and the same signal stops both.
          task: (input) =>
            runSubagent({
              provider,
              model,
              registry,
              cwd,
              skills: this.options.skills?.(),
              // The same rules the parent's prompt carries: a delegated task works in
              // the same folder, and must follow the same conventions it keeps.
              instructions: this.options.instructions?.(),
              ownInstructions: this.options.ownInstructions?.(),
              // The same boundary and the same box: a delegated write lands in the
              // same folder, and its commands are contained the same way.
              confineTo: this.options.project?.ok ? this.options.project.project.path : undefined,
              sandbox: this.options.sandbox,
              // The same project, so a delegated task carries the same code brief.
              project: this.options.project,
              // The same live state the parent's prompt carries, so a delegated
              // task can answer about the browser, the servers and Google too.
              browser: this.browserFacts(),
              mcp: this.mcpFacts(),
              google: this.options.google ?? null,
              signal: abort,
              // The subtask is planning too: its catalog drops the writes, and the
              // permission it inherits refuses one that is still called.
              plan,
              permission,
              // A delegated write lands in the same folder this session works in, so it is
              // announced the same way: the subtask is not a second, silent writer.
              onSideEffect: sideEffect,
              maxSteps,
              maxTokens,
              temperature,
              reasoningEffort: effort,
              input,
              context: { remember, memories, recall, origin, routine, sendFile },
              trace: this.runTrace('task'),
            }),
        },
        maxSteps,
        maxTokens,
        temperature,
        signal,
        steering,
        // A step that may have written in the folder, said to the session's owner while
        // the turn is still running: this is what keeps a page drawing that folder from
        // showing what was there before the turn began.
        onSideEffect: sideEffect,
        // Read at call time, so `/effort` takes effect on the next turn instead
        // of needing the runtime rebuilt. Never absent: a session built without
        // one still asks for Milo's default.
        reasoningEffort: effort,
        permission,
        keepSnapshots: this.options.keepSnapshots,
        genui: draws,
        trace: this.runTrace('chat'),
      })) {
        // Measured once, on the turn's first output of any kind, so a session read
        // back reports the same wait the surface that watched it drew.
        if (
          firstOutputMs === undefined &&
          (event.type === 'text-delta' || event.type === 'reasoning-delta' || event.type === 'tool-start')
        ) {
          firstOutputMs = Date.now() - startedAt
        }
        if (event.type === 'error') errored = true
        else if (event.type === 'text-delta') answer += event.delta
        else if (event.type === 'reasoning-delta') reasoning += event.delta
        else if (event.type === 'tool-start') {
          // The step that called a tool is finished being written. Without the
          // break, the line before a tool call and the answer after it are one
          // sentence in the log — and in an export, one paragraph.
          answer = closeParagraph(answer)
          running = { name: event.name, args: event.args }
        }
        else if (event.type === 'steer') {
          note({ kind: 'user', text: event.text })
          // For the same reason the opening message is written down before the
          // answer comes: a crash mid-turn must not lose what the user said.
          await this.persist()
        } else if (event.type === 'tool-end') {
          note({
            kind: 'tool',
            tool: {
              name: event.name,
              args: running?.args ?? {},
              result: event.result,
              isError: event.isError,
            },
          })
          running = null
        }
        yield event
      }

      // The gate: a turn that changed files ends with what the project's own
      // checks answered, not only with what the model said it ran. It is off
      // unless the install turned it on, and it never feeds the failure back —
      // v1 reports, so the answer already on screen is not rewritten under it.
      if (
        !errored &&
        !abort.aborted &&
        this.wroteThisTurn &&
        this.options.project?.ok &&
        this.options.verify
      ) {
        const project = this.options.project.project
        const startedVerification = Date.now()
        let result: VerificationResult
        try {
          result = await this.options.verify(project)
        } catch (error) {
          result = { kind: 'unreadable', error: errorMessage(error) }
        }
        this.options.traces?.record({
          at: new Date().toISOString(),
          event: 'verification',
          ok: result.kind === 'checks' ? result.ok : result.kind === 'none',
          ms: Date.now() - startedVerification,
          purpose: 'verification',
          surface: this.scope.gateway,
          session: this.id,
          project: project.id,
          ...(result.kind === 'checks'
            ? {
                checks: result.checks.length,
                failed: result.checks.filter((check) => !check.ok).map((check) => check.name),
              }
            : { checks: 0 }),
        })
        const text = verificationText(result)
        const ok = result.kind === 'checks' ? result.ok : result.kind === 'none'
        // Kept on the message the answer landed on — the last one this turn left — so a
        // session read back draws the card the live turn drew. The event is not the only
        // carrier: without this, reopening a conversation loses what the checks said.
        const landed = this.messages.findLast((message, index) => index >= firstNew && message.role === 'assistant')
        if (landed) landed.verification = { ok, text }
        yield { type: 'verification', result, text, ok }
      }
    } catch (error) {
      // A stop is not a failure: reporting `AbortError` to the user turns their
      // own Ctrl+C into a red error line, and the abort is the expected end of
      // a stream the caller cancelled.
      if (isAbort(error, signal)) {
        errored = true
        yield { type: 'aborted' }
      } else {
        errored = true
        // One line at the boundary of a turn that did not answer, the daemon
        // operator's only record of it. A stop is not logged: it is the person's
        // own doing, and the surfaces already say so.
        logWarn(`turn failed on ${scopeKey(this.scope)}: ${errorMessage(error)}`)
        yield { type: 'error', message: errorMessage(error) }
      }
    } finally {
      // The wait belongs to the turn's first message, and it is set before the persist
      // below so a session read back carries the number the live turn drew. Only a wait
      // worth reporting is written — the same under-a-second rule the surfaces draw by —
      // so a reload says exactly what the live turn said and nothing more.
      const first = this.messages[firstNew]
      if (
        firstOutputMs !== undefined &&
        firstOutputMs >= 1000 &&
        first?.role === 'assistant' &&
        first.thoughtMs === undefined
      ) {
        first.thoughtMs = firstOutputMs
      }
      try {
        // Runs even when the consumer aborts, so the partial turn is on disk.
        await this.persist()
      } catch (error) {
        // Another process moved this session on and the transcript here cannot
        // be written without erasing its turns. The turn ends saying so rather
        // than being passed off as saved; an error already reported above is not
        // repeated.
        if (!errored) yield { type: 'error', message: errorMessage(error) }
        errored = true
      }
      // A turn that was stopped still said something worth finding later.
      if (answer || reasoning) note({ kind: 'assistant', text: answer, reasoning })
      this.options.history?.append(entries)
      this.options.traces?.record({
        at: new Date().toISOString(),
        event: 'turn',
        ok: !errored,
        ms: Date.now() - startedAt,
        purpose: 'chat',
        surface: this.scope.gateway,
        session: this.id,
        model,
      })
    }

    // Reading the turn for facts worth keeping is a model call of its own, so it
    // is started and left alone: the answer is already on screen. What the person
    // said is in the history log either way — this only adds the tidier version of
    // it, and nothing is lost if it never lands.
    if (!errored && this.options.derive && answer.trim()) {
      this.inBackground(this.extract(input, answer))
    }

    // Naming the session is the same kind of call: drawn from the turn it opened
    // with, and nobody waits for it. Only the first turn, only a session nobody
    // named, and never a routine's own run — those belong to the routine and are
    // kept out of `/sessions`, so a name for one is a name nobody reads.
    if (this.shouldBeNamed(errored)) {
      this.inBackground(this.nameFromOpeningTurn())
    }

    if (!errored && !abort.aborted) {
      // Summarizing after the answer avoids competing with its provider request.
      // If the person sends another turn immediately, that turn can wait on this
      // prepared result; otherwise the provider latency happens between turns.
      const alreadyRunning = [...this.background]
      this.inBackground((async () => {
        await Promise.all(alreadyRunning)
        await this.prepareCompaction(provider, model)
      })())
    }
  }

  /** Whether this finished turn is the one that names the session. */
  private shouldBeNamed(errored: boolean): boolean {
    if (errored) return false
    if (this.options.sessions?.generateTitles !== true) return false
    if (this.record.title) return false
    if (this.scope.gateway === ROUTINE_GATEWAY) return false
    // One turn, and it was a question — not an instruction the gateway handled.
    if (countTurns(this.messages) !== 1) return false
    return !previewOf(this.messages).startsWith('/')
  }

  /**
   * Asks the model for a name, out of the turn the session opened with, and writes
   * it only into a session that still has none. Nothing here is the turn's problem:
   * a call that fails or answers with something that is not a name leaves the
   * session unnamed, and every surface falls back to the first message.
   */
  private async nameFromOpeningTurn(): Promise<void> {
    try {
      const model = this.options.sessions?.titleModel ?? this.options.model
      const title = await generateTitle({
        provider: this.options.providerFor?.(model) ?? this.options.provider,
        model,
        messages: this.messages,
      })
      if (title) await this.nameIfUnnamed(title)
    } catch (error) {
      logWarn(`could not name session ${this.id}: ${errorMessage(error)}`)
    }
  }

  /** Starts background work, and stops counting it as in flight when it ends. */
  private inBackground(work: Promise<void>): void {
    this.background.add(work)
    void work.finally(() => {
      this.background.delete(work)
      this.notifyIfIdle()
    })
  }

  /**
   * Reads a finished turn for durable facts and files them, as `fact`s — the
   * layer nothing evicts. The store folds a reworded fact into the one it already
   * has, so a note that comes back in other words does not multiply.
   */
  private async extract(input: string, answer: string): Promise<void> {
    try {
      const facts = await deriveFacts({
        provider: this.options.provider,
        model: this.options.model,
        // The fact has to stand on what the person said; the answer is only
        // context for reading it.
        person: input,
        messages: [
          { role: 'user', content: [{ type: 'text', text: input }] },
          { role: 'assistant', content: [{ type: 'text', text: answer }] },
        ],
      })
      if (facts.length === 0) return
      await this.options.memory.remember(
        this.scope,
        facts.map((text) => ({ text, tags: ['derived'], kind: 'fact' as const })),
      )
    } catch (error) {
      // Never the turn's problem: it answered already, and what it said is kept.
      logWarn(`could not keep the facts of a turn: ${errorMessage(error)}`)
    }
  }

  /** Waits for the background model calls still in flight. No turn ever waits on one. */
  async settle(): Promise<void> {
    while (this.background.size > 0) await Promise.all([...this.background])
  }

  /**
   * Takes the record read under the lease as the transcript to build on, and
   * reports how the screen's copy differs: messages it has not shown, messages it
   * showed and that are gone, and whether the turns that went were summarized
   * away rather than only added to. Null when this copy is the one on disk — the
   * ordinary case of one process on one session, and the reason a turn does not
   * work to reload against itself.
   *
   * A transcript that *shrank* is reported as loudly as one that grew. It is the
   * answer being drawn from less than the screen shows — another terminal's
   * `/clear`, a fold — and saying nothing there leaves a person reading a
   * conversation the model can no longer see.
   */
  private adoptLatest(latest: SessionRecord): { added: number; removed: number; compacted: boolean } | null {
    if (latest.version === this.baseVersion) return null
    this.preparedCompaction = undefined
    const before = this.messages.length
    // Compared before `summary` is replaced: a summary that was not there, or
    // reads differently, is the other Milo having summarized the older turns.
    const compacted = latest.summary !== this.summary
    // In place, not reassigned: this is the same array a running turn reads from
    // and the record writes back.
    this.messages.splice(0, this.messages.length, ...latest.messages)
    this.summary = latest.summary
    this.record.title = latest.title ?? this.record.title
    this.record.droppedTokens = latest.droppedTokens
    this.record.updatedAt = Math.max(this.record.updatedAt, latest.updatedAt)
    this.baseVersion = latest.version
    this.record.version = latest.version
    const after = this.messages.length
    const added = Math.max(0, after - before)
    const removed = Math.max(0, before - after)
    return added > 0 || removed > 0 || compacted ? { added, removed, compacted } : null
  }

  /** Forgets the transcript (and any summary) but keeps the session's identity. */
  async clear(): Promise<void> {
    // Under the lease for the same reason a turn is: clearing from a stale copy
    // would either be refused or would drop turns written since. Adopting first
    // is what makes this the session as it actually stands.
    const lease = await this.store.acquire(this.id)
    try {
      this.preparedCompaction = undefined
      if (lease.latest) this.adoptLatest(lease.latest)
      this.messages.length = 0
      this.summary = undefined
      this.record.droppedTokens = undefined
      // The plan belonged to the conversation that just went away.
      this.plan = false
      await this.recaps.remove(this.id) // the recap describes what just went away
      await this.persist()
    } finally {
      await lease.release()
    }
  }

  /**
   * What the turn just finished asked to send, and clears it. Read once the turn
   * ends, by whoever delivers on its behalf — the scheduler, for a routine.
   */
  takeOutgoing(): OutgoingFile[] {
    const files = this.outgoing
    this.outgoing = []
    return files
  }

  /**
   * Adds a message with no turn behind it, so something said out of band — a
   * routine's answer, with any files it delivered, reaching this chat — is in the
   * transcript when it is next opened rather than existing only for whoever was
   * watching. Under the lease for the same reason every other write is: appending
   * from a stale copy would be refused, or would erase the turns written since.
   */
  async appendNotice(text: string, files: OutgoingFile[] = []): Promise<void> {
    const lease = await this.store.acquire(this.id)
    try {
      if (lease.latest) this.adoptLatest(lease.latest)
      this.messages.push({
        role: 'assistant',
        at: Date.now(),
        content: [
          { type: 'text', text },
          ...files.map((file) => ({
            type: 'file' as const,
            path: file.path,
            name: file.name,
            mimeType: file.mimeType,
          })),
        ],
      })
      await this.persist()
    } finally {
      await lease.release()
    }
  }

  /**
   * A short recap of the whole session, written when it is switched away from,
   * and kept out of the transcript so it cannot be overwritten by a turn — nor
   * overwrite one. It records which version of the transcript it describes, so a
   * turn landing while it is being written needs no reconciliation: the recap is
   * simply no longer a match, and the next one will be.
   */
  async recap(): Promise<void> {
    if (this.messages.length === 0) return
    const seenAt = this.record.updatedAt
    const existing = await this.recaps.read(this.id)
    // Current, or written from a transcript newer than this copy knows about:
    // nothing to write. This check is here only to skip the model call — the
    // digest below takes seconds, which is exactly the window in which another
    // process can leave a fresher recap, so the store checks again immediately
    // before it writes.
    if (existing && existing.sourceUpdatedAt >= seenAt) return

    const text = await digest({
      provider: this.options.provider,
      model: this.options.model,
      messages: this.messages,
      summary: this.summary,
    })
    if (!text) return

    await this.recaps.write({ session: this.id, text, sourceUpdatedAt: seenAt, at: Date.now() })
  }

  /**
   * Rewrites the timestamp and writes the record back to the store, naming the
   * revision it is based on. A store that has moved past it rejects the write
   * with `SessionConflictError` — the transcript here is stale and writing it
   * would erase the turns the other writer added.
   */
  async persist(): Promise<void> {
    this.record.messages = this.messages
    this.record.summary = this.summary
    // Strictly increasing: a recap names the transcript version it was written
    // from, and two writes inside the same millisecond would otherwise look
    // like one — leaving a recap that misses a turn forever marked current.
    this.record.updatedAt = Math.max(Date.now(), this.record.updatedAt + 1)
    this.record.version = this.baseVersion + 1
    await this.store.save(this.record, this.baseVersion)
    this.baseVersion = this.record.version
  }

  stats(): SessionStats {
    return {
      id: this.id,
      title: this.record.title,
      createdAt: this.record.createdAt,
      updatedAt: this.record.updatedAt,
      messages: countMessages(this.messages),
      turns: countTurns(this.messages),
      tokens: estimateTokens(this.messages),
      fixedTokens: this.lastFixedTokens,
      // Absent when compaction is off, in which case there is no budget to
      // report rather than an infinite one. The resolved ceiling, not the
      // fallback: `/stats` showing 12k for a model that holds a million would be
      // the number that started all this.
      maxInputTokens: this.options.sessions?.compaction
        ? (this.ceiling ?? this.options.sessions.maxInputTokens)
        : undefined,
      compacted: this.summary !== undefined,
      droppedTokens: this.record.droppedTokens,
    }
  }

  /**
   * The sessions a question is about, best first. This is the map — which
   * conversation — while `search_history` is the territory: the exact turns.
   */
  async recallSessions(query: string, opts?: { limit?: number }): Promise<SessionSummary[]> {
    const sessions = await withRecaps(await this.store.list(), this.recaps)
    return rankSessions(sessions, query, opts?.limit ?? 5)
  }

  /** What this install keeps, newest first with facts ahead of turns. */
  async memories(limit?: number): Promise<MemoryItem[]> {
    return this.options.memory.list(this.scope, { limit })
  }

  /** Drops one note by id, or by the front of one. False when nothing matched. */
  async forget(id: string): Promise<boolean> {
    return this.options.memory.forget(this.scope, id)
  }

  /**
   * Folds the oldest turns into the summary now, whether or not the budget was
   * reached — what `/compact` is for. The automatic pass does the same work on
   * its own when the next request would not fit; this is that work asked for by
   * hand, so it keeps the same rule about how much stays (the last `keepTurns`).
   */
  async compact(signal?: AbortSignal): Promise<CompactResult> {
    const config = this.options.sessions
    const nothing = (reason: string): CompactResult => ({
      folded: 0,
      tokens: 0,
      ms: 0,
      summarized: false,
      reason,
    })
    if (!config?.compaction) return nothing('compaction is off in this install')
    this.preparedCompaction = undefined

    // The window is a fact about the model, not about this session: wait for the
    // lookup only if it has not finished already.
    await this.resolving

    // Pictures, page snapshots and fetched pages first: they are the parts of a
    // transcript that a handful of turns can push over the ceiling on their own,
    // and the oldest of each is no longer what the next action is chosen from.
    dropOldImages(this.messages)
    dropOldAudio(this.messages)
    dropOldSnapshots(this.messages, this.options.keepSnapshots)
    dropOldFetchedPages(this.messages)

    const cut = planCut(this.messages, config.keepTurns)
    if (cut <= 0) {
      return nothing(`nothing is old enough to fold — the last ${config.keepTurns} turns stay`)
    }

    const dropped = this.messages.slice(0, cut)
    const startedAt = Date.now()
    let summary: string | null = null
    try {
      summary = await summarize({
        provider: this.options.provider,
        model: this.options.model,
        previous: this.summary,
        dropped,
        signal,
      })
    } catch {
      summary = null
    }

    if (summary) this.summary = summary
    this.record.droppedTokens = (this.record.droppedTokens ?? 0) + estimateTokens(dropped)
    this.messages.splice(0, cut)
    // Written now rather than on the next turn: a fold that only exists in memory
    // is a `/compact` that a restart takes back.
    await this.persist()

    // The last system prompt this session sent is the best cheap reading of what
    // is not the transcript. When the fold still leaves the request over the
    // ceiling — the turns it kept were too big to get under — the caller is told
    // instead of reading a `/compact` that quietly did not do what it promised.
    const ceiling = this.ceiling ?? config.maxInputTokens
    const remaining = estimateTokens(this.messages) + (this.lastFixedTokens ?? 0)

    return {
      folded: countTurns(dropped),
      tokens: estimateTokens(dropped),
      ms: Date.now() - startedAt,
      // False when the model gave nothing: the turns went anyway, because a
      // request that fits beats one the provider rejects — and the caller is
      // told, rather than reading a summary that is not there.
      summarized: summary !== null,
      ...(remaining > ceiling
        ? { reason: `still over the ceiling — ${remaining} of ${ceiling} tokens` }
        : {}),
    }
  }

  /**
   * Over the budget: summarize the oldest turns into `summary` and drop them.
   * If the summary call fails, the turns are dropped anyway — a request that
   * fits beats one that is rejected by the provider.
   *
   * The cut may recuse past `keepTurns` to fit, and no summary is bought at all
   * when even the last turn plus the prompt is over the ceiling: folding cannot
   * make the request smaller than the turn it keeps, and paying for a summary
   * that cannot help is the model call every turn the old rule made.
   *
   * Reports the fold as it happens — that it is running, and then what it cost and
   * saved — because it is a model call of its own standing between the question and
   * the answer: without that, the time it adds is attributed to the model thinking
   * and the turns it took away are not accounted for at all.
   */
  private async *compactIfNeeded(
    prompt: Omit<SystemPromptInput, 'summary'>,
    signal?: AbortSignal,
    provider: Provider = this.options.provider,
    model: string = this.options.model,
    incoming: Message[] = [],
  ): AsyncGenerator<Extract<AgentEvent, { type: 'compacting' | 'compacted' }>, void> {
    const config = this.options.sessions
    if (!config?.compaction) return

    // The window is a fact about the model, not about this turn: wait for the
    // lookup only if it has not finished already.
    await this.resolving
    const ceiling = this.ceiling ?? config.maxInputTokens

    // Before the budget is counted: pictures, page snapshots and fetched pages
    // are the parts of a transcript that a handful of turns can push over the
    // ceiling on their own, and the oldest of each is no longer what the next
    // action is chosen from.
    dropOldImages(this.messages)
    dropOldAudio(this.messages)
    dropOldSnapshots(this.messages, this.options.keepSnapshots)
    dropOldFetchedPages(this.messages)

    // Everything a request carries that is not the transcript: the system
    // prompt, the tool schemas, the memories and the running summary. Read once
    // and reused, because folding changes only the transcript and the summary's
    // own length — and this reading already has the summary in it.
    const fixed =
      estimateText(buildSystemPrompt({ ...prompt, summary: this.summary, browser: this.browserFacts(), mcp: this.mcpFacts(), google: this.options.google ?? null })) +
      estimateTools(prompt.tools)
    const incomingTokens = estimateTokens(incoming)
    if (estimateTokens(this.messages) + fixed + incomingTokens <= ceiling) return

    const prepared = this.preparedCompaction
    if (
      prepared &&
      this.canUsePreparedCompaction(prepared, provider, model, ceiling, fixed) &&
      estimateTokens(this.messages.slice(prepared.cut)) + fixed + incomingTokens <= ceiling
    ) {
      this.preparedCompaction = undefined
      if (!prepared.done) yield { type: 'compacting' }
      const summary = await awaitPreparedSummary(prepared.summary, signal)
      const dropped = this.messages.slice(0, prepared.cut)
      if (summary) this.summary = summary
      const tokens = estimateTokens(dropped)
      this.record.droppedTokens = (this.record.droppedTokens ?? 0) + tokens
      this.messages.splice(0, prepared.cut)
      yield {
        type: 'compacted',
        ms: Math.max(0, (prepared.finishedAt ?? Date.now()) - prepared.startedAt),
        folded: countTurns(dropped),
        tokens,
        summarized: summary !== null,
      }
      return
    }
    if (prepared) this.preparedCompaction = undefined

    // The floor is a preference, not a promise: when the turns it protects are
    // themselves bigger than the ceiling, the cut recuses past them, and 0 comes
    // back only when even the last turn plus the prompt is over — a summary
    // cannot help there, so none is bought.
    const cut = planCutUnderBudget(this.messages, {
      keepTurns: config.keepTurns,
      budget: ceiling - incomingTokens,
      fixed,
    })
    if (cut <= 0) {
      logDebug('compaction skipped: nothing to fold that would fit')
      return
    }

    // Said before the call, not after: this is the moment the person stops hearing
    // from Milo, and the wait here is the summary — not the model reading the
    // question.
    yield { type: 'compacting' }

    const dropped = this.messages.slice(0, cut)
    const startedAt = Date.now()
    let summary: string | null = null
    try {
      summary = await summarize({
        provider,
        model,
        previous: this.summary,
        dropped,
        signal,
      })
    } catch {
      summary = null
    }

    if (summary) this.summary = summary
    const tokens = estimateTokens(dropped)
    this.record.droppedTokens = (this.record.droppedTokens ?? 0) + tokens
    this.messages.splice(0, cut)

    // Measured again, because the summary replaced part of the transcript: if
    // the request is still over the ceiling the honest thing is to write it down.
    // No second call — this is a report, not a retry.
    const after =
      estimateTokens(this.messages) +
      estimateText(buildSystemPrompt({ ...prompt, summary: this.summary, browser: this.browserFacts(), mcp: this.mcpFacts(), google: this.options.google ?? null })) +
      estimateTools(prompt.tools)
    if (after > ceiling) logDebug(`compaction left the request over its ceiling (${after} > ${ceiling})`)

    yield {
      type: 'compacted',
      ms: Date.now() - startedAt,
      folded: countTurns(dropped),
      tokens,
      summarized: summary !== null,
    }
  }

  /** Start the next summary during the gap after an answer, before it is needed. */
  private async prepareCompaction(provider: Provider, model: string): Promise<void> {
    const config = this.options.sessions
    const ceiling = this.ceiling ?? config?.maxInputTokens
    const fixed = this.lastFixedTokens
    if (!config?.compaction || ceiling === undefined || fixed === undefined || this.preparedCompaction) return
    if (estimateTokens(this.messages) + fixed < ceiling * 0.6) return

    const cut = planCutUnderBudget(this.messages, {
      // Reserve room for the next user turn so the prepared fold can be applied
      // before that turn is appended to the transcript.
      keepTurns: Math.max(1, config.keepTurns - 1),
      budget: ceiling,
      fixed,
    })
    if (cut <= 0) return

    const prepared: PreparedCompaction = {
      provider,
      model,
      ceiling,
      fixed,
      previous: this.summary,
      cut,
      prefix: this.messages.slice(0, cut),
      startedAt: Date.now(),
      done: false,
      summary: Promise.resolve(null),
    }
    this.preparedCompaction = prepared
    prepared.summary = summarize({
      provider,
      model,
      previous: prepared.previous,
      dropped: prepared.prefix,
    }).catch((error) => {
      logWarn(`could not prepare compaction for session ${this.id}: ${errorMessage(error)}`)
      return null
    }).then((summary) => {
      prepared.done = true
      prepared.finishedAt = Date.now()
      return summary
    })
    await prepared.summary
  }

  private canUsePreparedCompaction(
    prepared: PreparedCompaction,
    provider: Provider,
    model: string,
    ceiling: number,
    fixed: number,
  ): boolean {
    if (
      prepared.provider !== provider ||
      prepared.model !== model ||
      prepared.ceiling !== ceiling ||
      prepared.fixed !== fixed ||
      prepared.previous !== this.summary ||
      prepared.cut > this.messages.length
    ) return false
    return prepared.prefix.every((message, index) => this.messages[index] === message)
  }
}
