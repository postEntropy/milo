import { errorMessage } from '../util/errors.js'
import type { SessionsConfig } from './config/schema.js'
import type { BrowserFacts } from './browser/index.js'
import type { HistoryEntry, HistoryWriter } from './history.js'
import { scopeKey, type Memory, type MemoryInput, type MemoryScope } from './memory/index.js'
import type { SkillSummary } from './skills/index.js'
import { DEFAULT_REASONING_EFFORT, type Message, type Provider, type ReasoningEffort } from './providers/types.js'
import type { PermissionAsker, PermissionPolicy, ToolRegistry } from './tools/index.js'
import type { AgentEvent } from './agent/events.js'
import { runAgent } from './agent/loop.js'
import { runSubagent } from './agent/subagent.js'
import { buildSystemPrompt, type SurfaceKind, type SystemPromptInput } from './agent/system.js'
import {
  countTurns,
  digest,
  dropOldImages,
  dropOldSnapshots,
  estimateText,
  estimateTokens,
  MemoryRecapStore,
  planCut,
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

const SURFACES: SurfaceKind[] = ['cli', 'telegram', 'discord']

function asSurface(gateway: string): SurfaceKind | undefined {
  return (SURFACES as string[]).includes(gateway) ? (gateway as SurfaceKind) : undefined
}

/**
 * Whether the error means "the caller stopped us". A cancelled fetch rejects
 * with an `AbortError`, but the signal is checked too: a provider is free to
 * fail in its own way once the request is already gone.
 */
function isAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  return error instanceof Error && error.name === 'AbortError'
}

export interface SessionOptions {
  scope: MemoryScope
  provider: Provider
  model: string
  system: string
  registry: ToolRegistry
  memory: Memory
  cwd: string
  /** The skills to index in the system prompt; the bodies load on demand. */
  skills?: SkillSummary[]
  maxSteps?: number
  maxTokens?: number
  temperature?: number
  recallLimit?: number
  permissionPolicy?: PermissionPolicy
  /** The record this session reads from and writes back to. */
  record: SessionRecord
  store: SessionStore
  /** Where this session's recap is kept, out of its transcript. */
  recaps?: RecapStore
  sessions?: SessionsConfig
  /** Where a turn is written down for later recall. Absent: nothing is logged. */
  history?: HistoryWriter
  /**
   * Where a model's context window comes from. Swapped in tests, so a test never
   * has to reach the network to know how big a model is.
   */
  lookupContextWindow?: (model: string) => Promise<number | undefined>
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
}

export interface SendOptions {
  signal?: AbortSignal
  /** The surface's inline confirmation prompt for tools that need it. */
  ask?: PermissionAsker
  /**
   * Where the surface hands in a message sent while this turn is already
   * running. The array belongs to the caller and is emptied as the messages are
   * taken up, so whatever is still in it when the turn ends was never seen — the
   * caller runs it as its own turn instead of losing it.
   */
  steering?: string[]
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
  /** The revision this session's copy of the transcript was built from. */
  private baseVersion: number
  /** Size of the last system prompt sent, which the transcript count omits. */
  private lastSystemTokens: number | undefined
  /** The ceiling the transcript is measured against, once the window is known. */
  private ceiling: number | undefined
  /** The lookup in flight: a turn waits on it only if it has not finished. */
  private readonly resolving: Promise<void>

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

  /**
   * The ceiling a request is measured against: the model's context window times
   * `compactAt`, or `maxInputTokens` when nothing knows the window.
   */
  private async computeCeiling(): Promise<number | undefined> {
    const config = this.options.sessions
    if (!config?.compaction) return undefined
    // Nothing is asked for unless a caller wired a lookup in: a session that
    // reached the network on its own would make every test a network test.
    const window = config.contextWindow ?? (await this.options.lookupContextWindow?.(this.options.model))
    if (!window) return config.maxInputTokens
    // Never below a floor: a share of a window that turns out tiny would
    // otherwise compact down to a request with no room to answer in.
    return Math.max(1024, Math.floor(window * config.compactAt))
  }

  /**
   * Read per prompt build, and by both callers that build one — the request, and
   * the budget that measures it. Two different answers there would mean a budget
   * saying a request fits while the request is bigger.
   */
  private browserFacts(): BrowserFacts | null {
    return this.options.browser?.() ?? null
  }

  get title(): string | undefined {
    return this.record.title
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
      yield* this.turn(input, opts)
    } finally {
      await lease?.release()
    }
  }

  private async *turn(input: string, opts?: SendOptions): AsyncGenerator<AgentEvent> {
    const {
      provider,
      model,
      system,
      registry,
      memory,
      cwd,
      maxSteps,
      maxTokens,
      temperature,
      permissionPolicy,
    } = this.options
    const signal = opts?.signal
    const steering = opts?.steering

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
    /** Corrections handed in mid-turn. What the user said is not lost with the turn. */
    const corrections: string[] = []
    let running: { name: string; args: unknown } | null = null

    const tools = registry.specs()
    const recalled = await memory.recall(this.scope, input, {
      limit: this.options.recallLimit ?? 5,
    })
    const prompt = {
      base: system,
      surface: asSurface(this.scope.gateway),
      cwd,
      provider: provider.id,
      model,
      tools,
      skills: this.options.skills,
      memories: recalled,
    }

    // Measured against the request that will actually be sent: the tool list,
    // the recalled memories and the running summary ride along with every turn,
    // and leaving them out of the count let the request go over budget.
    const compaction = await this.compactIfNeeded(prompt, signal)
    if (compaction) yield { type: 'compacted', ms: compaction.ms }

    const systemPrompt = buildSystemPrompt({ ...prompt, summary: this.summary, browser: this.browserFacts() })
    this.lastSystemTokens = estimateText(systemPrompt)

    this.messages.push({ role: 'user', content: [{ type: 'text', text: input }] })
    note({ kind: 'user', text: input })

    // The turn's one signal, one permission decision and one effort, shared by
    // the turn and by any subagent it delegates to.
    const abort = signal ?? new AbortController().signal
    const effort = this.options.reasoningEffort?.() ?? DEFAULT_REASONING_EFFORT
    const permission = permissionPolicy
      ? { policy: permissionPolicy, ask: opts?.ask }
      : undefined
    // Read through `this.scope` at call time: a gateway can rebind the session
    // to another conversation while it is running.
    const remember = (items: MemoryInput[]) => memory.remember(this.scope, items)
    const recall = (query: string, options?: { limit?: number }) =>
      this.recallSessions(query, options)

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
          remember,
          recall,
          // A subtask runs in its own context, but under this turn's model,
          // tools, permissions and stop: the same `ask` puts the subagent's
          // confirmations to the user, and the same signal stops both.
          task: (input) =>
            runSubagent({
              provider,
              model,
              registry,
              cwd,
              skills: this.options.skills,
              signal: abort,
              permission,
              maxSteps,
              maxTokens,
              temperature,
              reasoningEffort: effort,
              input,
              context: { remember, recall },
            }),
        },
        maxSteps,
        maxTokens,
        temperature,
        signal,
        steering,
        // Read at call time, so `/effort` takes effect on the next turn instead
        // of needing the runtime rebuilt. Never absent: a session built without
        // one still asks for Milo's default.
        reasoningEffort: effort,
        permission,
        keepSnapshots: this.options.keepSnapshots,
      })) {
        if (event.type === 'error') errored = true
        else if (event.type === 'text-delta') answer += event.delta
        else if (event.type === 'reasoning-delta') reasoning += event.delta
        else if (event.type === 'tool-start') {
          // The step that called a tool is finished being written. Without the
          // break, the line before a tool call and the answer after it are one
          // sentence in the log — and in an export, one paragraph.
          if (answer && !answer.endsWith('\n')) answer += '\n\n'
          running = { name: event.name, args: event.args }
        }
        else if (event.type === 'steer') {
          corrections.push(event.text)
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
    } catch (error) {
      // A stop is not a failure: reporting `AbortError` to the user turns their
      // own Ctrl+C into a red error line, and the abort is the expected end of
      // a stream the caller cancelled.
      if (isAbort(error, signal)) {
        errored = true
        yield { type: 'aborted' }
      } else {
        errored = true
        yield { type: 'error', message: errorMessage(error) }
      }
    } finally {
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
    }

    // Remember only what the user said — the assistant's own replies are not
    // durable facts and would pollute recall. A turn that failed or was stopped
    // is skipped as well: it never got as far as an answer. It goes in as
    // `said`, the layer recall reads second and eviction is allowed to drop;
    // what the `remember` tool saves is a `fact`, and nothing evicts those.
    const said = [input, ...corrections].filter((text) => text.trim())
    if (!errored && said.length > 0) {
      await memory.remember(
        this.scope,
        said.map((text) => ({ text, tags: ['user'], kind: 'said' as const })),
      )
    }
  }

  /**
   * Takes the record read under the lease as the transcript to build on, and
   * reports how the screen's copy differs: messages it has not shown, and
   * whether the turns that are gone were summarized away rather than only added
   * to. Null when nothing visible changed — the ordinary case of one process on
   * one session, and the reason a turn does not work to reload against itself.
   */
  private adoptLatest(latest: SessionRecord): { added: number; compacted: boolean } | null {
    if (latest.version === this.baseVersion) return null
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
    const added = Math.max(0, this.messages.length - before)
    return added > 0 || compacted ? { added, compacted } : null
  }

  /** Forgets the transcript (and any summary) but keeps the session's identity. */
  async clear(): Promise<void> {
    // Under the lease for the same reason a turn is: clearing from a stale copy
    // would either be refused or would drop turns written since. Adopting first
    // is what makes this the session as it actually stands.
    const lease = await this.store.acquire(this.id)
    try {
      if (lease.latest) this.adoptLatest(lease.latest)
      this.messages.length = 0
      this.summary = undefined
      this.record.droppedTokens = undefined
      await this.recaps.remove(this.id) // the recap describes what just went away
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
      messages: this.messages.length,
      turns: countTurns(this.messages),
      tokens: estimateTokens(this.messages),
      systemTokens: this.lastSystemTokens,
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

    // The window is a fact about the model, not about this session: wait for the
    // lookup only if it has not finished already.
    await this.resolving

    // Pictures and page snapshots first: both are the parts of a transcript that
    // a handful of turns can push over the ceiling on their own, and the oldest
    // of each is no longer what the next action is chosen from.
    dropOldImages(this.messages)
    dropOldSnapshots(this.messages, this.options.keepSnapshots)

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

    return {
      folded: countTurns(dropped),
      tokens: estimateTokens(dropped),
      ms: Date.now() - startedAt,
      // False when the model gave nothing: the turns went anyway, because a
      // request that fits beats one the provider rejects — and the caller is
      // told, rather than reading a summary that is not there.
      summarized: summary !== null,
    }
  }

  /**
   * Over the budget: summarize the oldest turns into `summary` and drop them.
   * If the summary call fails, the turns are dropped anyway — a request that
   * fits beats one that is rejected by the provider.
   *
   * Reports what the summary cost when it ran, because it is a model call of its
   * own standing between the question and the answer: without the number, its
   * time is attributed to the model thinking.
   */
  private async compactIfNeeded(
    prompt: Omit<SystemPromptInput, 'summary'>,
    signal?: AbortSignal,
  ): Promise<{ ms: number } | null> {
    const config = this.options.sessions
    if (!config?.compaction) return null

    // The window is a fact about the model, not about this turn: wait for the
    // lookup only if it has not finished already.
    await this.resolving
    const ceiling = this.ceiling ?? config.maxInputTokens

    // Before the budget is counted: pictures and page snapshots are the parts of
    // a transcript that a handful of turns can push over the ceiling on their
    // own, and the oldest of each is no longer what the next action is chosen
    // from.
    dropOldImages(this.messages)
    dropOldSnapshots(this.messages, this.options.keepSnapshots)

    const used = () =>
      estimateTokens(this.messages) +
      estimateText(buildSystemPrompt({ ...prompt, summary: this.summary, browser: this.browserFacts() }))
    if (used() <= ceiling) return null

    const cut = planCut(this.messages, config.keepTurns)
    if (cut <= 0) return null

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
    return { ms: Date.now() - startedAt }
  }
}
