import type { MediaModelsConfig, SessionsConfig } from './config/schema.js'
import type { BrowserSession } from './browser/index.js'
import type { GoogleState } from './google/state.js'
import { mcpFacts, type McpServers } from './mcp/servers.js'
import type { HistoryWriter } from './history.js'
import type { Memory, MemoryScope } from './memory/index.js'
import { scopeKey } from './memory/index.js'
import { DEFAULT_REASONING_EFFORT, type Provider, type ReasoningEffort } from './providers/types.js'
import type { Skill, SkillLibrary } from './skills/index.js'
import type { PermissionPolicy } from './tools/index.js'
import type { RoutineFn, ToolRegistry } from './tools/index.js'
import { ROUTINE_GATEWAY } from './routines.js'
import { Session } from './session.js'
import {
  contextBudget,
  MemoryRecapStore,
  MemorySessionStore,
  type RecapStore,
  type SessionRecord,
  type SessionStore,
  type SessionSummary,
  withRecaps,
} from './sessions/index.js'
import { errorMessage } from '../util/errors.js'
import { logWarn } from '../util/log.js'
import { findPreset } from './config/presets.js'

export interface RuntimeOptions {
  provider: Provider
  /**
   * How a provider is built for a model. `auto` picks its wire from the model
   * id, so a runtime given this builds the provider again when `setModel` moves
   * it, rather than carrying the first one into turns it was never resolved
   * for. Absent on a runtime holding a fixed provider: a test, a script.
   */
  providerFor?: (model: string) => Provider
  /**
   * The install's providers, so the runtime can move between them live. `use`
   * makes `id` the one later models resolve against (resolved from disk at that
   * moment, so one added since startup is found) and reports whether it exists;
   * `name` is what a surface calls it. Absent on a runtime holding a fixed
   * provider: a test, a script.
   */
  providerSwitch?: { use(id: string): boolean; name(id: string): string | undefined }
  model: string
  mediaModels?: MediaModelsConfig
  system: string
  registry: ToolRegistry
  memory: Memory
  cwd: string
  /** The skills directory, read live, so the index in every prompt stays current. */
  skills?: SkillLibrary
  maxSteps?: number
  maxTokens?: number
  temperature?: number
  recallLimit?: number
  /** Whether each finished turn is read for facts worth keeping. */
  derive?: boolean
  permissionPolicy?: PermissionPolicy
  /** Defaults to an in-memory store, which keeps tests off the disk. */
  store?: SessionStore
  /** Where a session's recap is kept, out of its transcript. In-memory by default. */
  recaps?: RecapStore
  sessions?: SessionsConfig
  /** Where turns are logged for later recall; absent means nothing is logged. */
  history?: HistoryWriter
  /**
   * How a routine is filed when the model makes one. Absent on a runtime that
   * cannot make routines, in which case the `routine` tool fails cleanly.
   */
  routine?: RoutineFn
  /** Where a model's context window comes from, for the compaction ceiling. */
  lookupContextWindow?: (model: string) => Promise<number | undefined>
  /** How hard the model should think; `medium` unless the config was changed. */
  reasoningEffort?: ReasoningEffort
  /**
   * The browser Milo drives, when one is configured. It is a process and a
   * socket with a lifetime, so it is closed on the way out rather than left for
   * the machine to reap.
   */
  browser?: BrowserSession | null
  /**
   * The external tool servers. They are processes with lifetimes, like the
   * browser, so they are let go on the way out instead of being left for the
   * machine to reap.
   */
  mcp?: McpServers | null
  /**
   * The Google grant as this run sees it. A value, not a getter: connecting an
   * account needs a restart for the tools to appear, so the line that describes
   * them is fixed for the life of the process with it.
   */
  google?: GoogleState | null
  /** How many page snapshots a request may carry; from the browser's config. */
  keepSnapshots?: number
  /** Maximum number of idle sessions kept in memory before older ones are evicted. */
  maxCachedSessions?: number
}

const DEFAULT_MAX_CACHED_SESSIONS = 16


/** What a caller may pin on a fresh session, beyond the scope it talks to. */
export interface NewSessionOptions {
  /** Tools the run may use with nobody to ask — a routine's standing grants. */
  grantedTools?: string[]
  /** The chat its turns may send files to — a routine's own target. */
  deliverTo?: { gateway: string; conversationId: string }
}

/**
 * The transport-agnostic core. Gateways ask it for a Session; the transport
 * address is only a pointer to the session currently bound to it, so the same
 * conversation can be picked up from another gateway.
 */
export class AgentRuntime {
  private readonly cache = new Map<string, Session>()
  private readonly store: SessionStore
  private readonly recaps: RecapStore
  private readonly options: RuntimeOptions
  /** Recaps being written in the background; a switch never waits for them. */
  private readonly pendingRecaps = new Set<Promise<void>>()
  /** Scopes this process has opened a session for; see `sessionFor`. */
  private readonly opened = new Set<string>()

  constructor(options: RuntimeOptions) {
    this.options = options
    this.store = options.store ?? new MemorySessionStore()
    this.recaps = options.recaps ?? new MemoryRecapStore()
  }

  /** The session bound to `scope`, creating and binding one on first use. */
  async getSession(scope: MemoryScope): Promise<Session> {
    const key = scopeKey(scope)
    const bound = await this.store.getBinding(key)
    if (bound) {
      const cached = this.cache.get(bound)
      if (cached) {
        cached.scope = scope
        return this.touch(bound, cached)
      }
      const record = await this.store.load(bound)
      // A binding whose record is gone falls through to a fresh session.
      if (record) return this.adopt(record, scope)
    }
    return this.createSession(scope)
  }

  /**
   * Starts a fresh session and rebinds `scope` to it. `grantedTools` is a
   * routine's standing grants — tools it may use with nobody to ask — and
   * `deliverTo` is the chat its turns may send files to.
   */
  async newSession(
    scope: MemoryScope,
    title?: string,
    options?: NewSessionOptions,
  ): Promise<Session> {
    return this.createSession(scope, title, options)
  }

  /**
   * The session for a conversation, opened fresh the first time this process
   * sees it and reused after that.
   *
   * This is what a surface talks to. "Opening the CLI or restarting the daemon
   * begins a new conversation" is a rule about a *run*, not about a scope, so it
   * lives here rather than in each gateway — no caller can get it wrong, and the
   * ones that mean "the conversation I am already in" keep using `getSession`.
   *
   * Nothing is lost by it: the session left behind stays on disk, is still
   * listed by `/sessions` and is still `/resume`-able.
   */
  async sessionFor(scope: MemoryScope): Promise<Session> {
    const key = scopeKey(scope)
    if (this.opened.has(key)) return this.getSession(scope)
    this.opened.add(key)
    return this.newSession(scope)
  }

  /**
   * Rebinds `scope` to an existing session; null when the id is unknown. The
   * scope counts as opened: a resume is this run choosing the session for it, so
   * a surface that then opens the scope — the web, whose socket reconnects after
   * the id is minted — must be handed that session rather than a fresh one.
   */
  async resumeSession(scope: MemoryScope, id: string): Promise<Session | null> {
    const cached = this.cache.get(id)
    if (cached) {
      await this.detach(scope, id)
      cached.scope = scope
      await this.store.setBinding(scopeKey(scope), id)
      this.opened.add(scopeKey(scope))
      return this.touch(id, cached)
    }
    const record = await this.store.load(id)
    if (!record) return null
    await this.detach(scope, id)
    const session = this.adopt(record, scope)
    await this.store.setBinding(scopeKey(scope), id)
    this.opened.add(scopeKey(scope))
    return session
  }

  /**
   * Forks an existing session into a new one and rebinds `scope` to it.
   * Returns the new Session, or null if `sourceId` was not found.
   */
  async forkSession(
    scope: MemoryScope,
    sourceId: string,
    options?: { upToTurn?: number; title?: string },
  ): Promise<Session | null> {
    const cached = this.cache.get(sourceId)
    if (cached) {
      await cached.settle()
    }
    await this.detach(scope)
    const record = await this.store.fork(sourceId, { ...options, scope })
    if (!record) return null
    await this.store.setBinding(scopeKey(scope), record.id)
    this.opened.add(scopeKey(scope))
    return this.adopt(record, scope)
  }

  /**
   * The conversations a person can open. A routine's own runs are sessions too,
   * but nobody talks in them: they are what a routine produced, read in the
   * Routines surface through `listRuns`. Listing them here too had every surface
   * offer them as resumable conversations, all titled after the routine.
   */
  async listSessions(): Promise<SessionSummary[]> {
    const sessions = (await this.store.list())
      .filter((session) => session.scope?.gateway !== ROUTINE_GATEWAY)
    return withRecaps(sessions, this.recaps)
  }

  /**
   * What a routine has produced, newest first — its own history, not a
   * conversation. Read off the record's scope, which is what survives the next
   * run replacing the binding.
   */
  async listRuns(routineId: string): Promise<SessionSummary[]> {
    return (await this.store.list()).filter(
      (session) =>
        session.scope?.gateway === ROUTINE_GATEWAY &&
        session.scope.conversationId === routineId,
    )
  }

  /**
   * A saved session read as it stands. Unlike `resumeSession` this takes no
   * lease and binds nothing, so looking at a past run does not take the
   * conversation over from whoever is in it.
   */
  async loadSession(id: string): Promise<SessionRecord | null> {
    return this.store.load(id)
  }

  /**
   * Deletes a saved session outright — the record and the recap with it. Only
   * the record goes: a scope still bound to it falls through to a fresh
   * conversation on its next message, so refusing to delete the session a
   * conversation is currently in is the caller's decision, not this one's.
   */
  async removeSession(id: string): Promise<boolean> {
    const exists = (await this.store.list()).some((session) => session.id === id)
    if (!exists) return false
    this.cache.delete(id)
    await this.store.remove(id)
    await this.recaps.remove(id)
    return true
  }

  /**
   * Sets or clears a session's title. Writes the update through the store,
   * keeping the cache in sync when the session is currently in memory.
   */
  async renameSession(id: string, title: string): Promise<boolean> {
    const trimmed = title.trim()
    const cached = this.cache.get(id)
    if (cached) {
      await cached.rename(trimmed)
      return true
    }
    const record = await this.store.load(id)
    if (!record) return false
    record.title = trimmed || undefined
    await this.store.save(record, record.version)
    return true
  }

  /**
   * Waits for the recaps still being written in the background. A switch never
   * waits for them, so this is the seam for a caller that is about to exit. A
   * recap that failed is already logged and must not fail this too.
   */
  async flush(): Promise<void> {
    while (this.pendingRecaps.size > 0) {
      await Promise.allSettled([...this.pendingRecaps])
    }
  }

  get sessionCount(): number {
    return this.cache.size
  }

  /**
   * The way out: the recaps still being written, the fact extractions still in
   * flight, and the browser, if one was started. Safe to call more than once,
   * and safe to call when a caller only ever wanted the recaps — `flush()`
   * remains the seam for that.
   */
  async close(): Promise<void> {
    await this.flush()
    // Extractions write to memory, and a process that exits under them drops a
    // fact the turn decided was worth keeping. Waited for together, and a
    // failure in one is not a reason to leave the rest of the way out undone.
    await Promise.allSettled([...this.cache.values()].map((session) => session.settle()))
    await this.options.browser?.close()
    await this.options.mcp?.close()
  }

  /** The external tool servers, for the surfaces that report them. */
  get mcp(): McpServers | null {
    return this.options.mcp ?? null
  }

  /** The browser Milo drives, when one is configured. */
  get browser(): BrowserSession | null {
    return this.options.browser ?? null
  }

  /** The skills on this install, for `/skills`. */
  get skills(): Skill[] {
    return this.options.skills?.list() ?? []
  }

  /** The install's memory store, for a surface that lists or drops notes. */
  get memory(): Memory {
    return this.options.memory
  }

  /**
   * The provider the next turn runs on, for a caller that makes its own one-shot
   * call — a background reading of the notes, say. It is the running provider, so
   * a model switch is picked up here the same way a session picks it up.
   */
  get provider(): Provider {
    return this.options.provider
  }

  /** What the provider in use is called, for a surface that shows it. */
  get providerName(): string {
    return this.options.providerSwitch?.name(this.options.provider.id) ?? this.options.provider.id
  }

  get permissions(): PermissionPolicy | undefined {
    return this.options.permissionPolicy
  }

  /** The model the next turn runs on, read per turn by every session. */
  get model(): string {
    return this.options.model
  }

  /**
   * The budget a request is measured against, for a surface that draws a context
   * meter: the model's window times `compactAt`, from the same rule the session
   * folds by. The raw window would fill the bar at 100% while the oldest turns
   * were already being summarized at 70% of it — two answers to one question.
   */
  async contextBudget(): Promise<number | undefined> {
    const config = this.options.sessions
    const window = config?.contextWindow ?? (await this.options.lookupContextWindow?.(this.options.model))
    return contextBudget(config, window)
  }

  /**
   * Moves the model the sessions after this one start on, leaving the ones
   * already open on the model they are running — work in progress is not
   * hijacked by a change to the install's default. This is what saving the
   * config does, so the next conversation picks the model up with no restart.
   */
  setDefaultModel(model: string): void {
    this.installModel(model)
  }

  setMediaModels(mediaModels: MediaModelsConfig | undefined): void {
    this.options.mediaModels = mediaModels
    for (const session of this.cache.values()) session.setMediaModels(mediaModels)
  }

  /**
   * Switches the model for this install: the open sessions and the ones after.
   * The provider is built again where the runtime knows how — a model can
   * resolve to another wire — and the sessions already open, which hold the
   * previous one, are handed the new.
   */
  setModel(model: string): void {
    const provider = this.installModel(model)
    for (const session of this.cache.values()) {
      session.setModel(model)
      if (provider) session.setProvider(provider)
    }
  }

  /**
   * Moves the install onto another provider, and onto that provider's model —
   * the open sessions and the ones after, the same shape `setModel` has. The
   * provider is resolved from disk at this moment, so one configured since
   * startup is picked up without a restart. A model id belongs to a provider, so
   * when none is named the provider's own default is used.
   */
  setProvider(id: string, model?: string): void {
    this.installProvider(id, model, true)
  }

  /**
   * The same move for the sessions after this one only: a conversation already
   * open keeps what it is answering with. This is the config's own path.
   */
  setDefaultProvider(id: string, model?: string): void {
    this.installProvider(id, model, false)
  }

  /** Puts another provider in place, and the model it landed on. */
  private installProvider(id: string, model: string | undefined, current: boolean): void {
    if (!this.options.providerSwitch?.use(id)) {
      throw new Error(`Provider "${id}" is not configured or has no key.`)
    }
    const chosen = model?.trim() || findPreset(id)?.models[0] || this.options.model
    const provider = this.options.providerFor?.(chosen)
    this.options.model = chosen
    if (provider) this.options.provider = provider
    if (!current || !provider) return
    for (const session of this.cache.values()) {
      session.setModel(chosen)
      session.setProvider(provider)
    }
  }

  /** Puts a model and the provider it resolves to in place, and says which. */
  private installModel(model: string): Provider | undefined {
    this.options.model = model
    const provider = this.options.providerFor?.(model)
    if (provider) this.options.provider = provider
    return provider
  }

  /** How hard the model thinks, from the turn after this one. */
  setReasoningEffort(effort: ReasoningEffort): void {
    this.options.reasoningEffort = effort
  }

  /** The effort that will be sent: never absent, because Milo has a default. */
  get reasoningEffort(): ReasoningEffort {
    return this.options.reasoningEffort ?? DEFAULT_REASONING_EFFORT
  }

  reset(): void {
    this.cache.clear()
  }

  private async createSession(
    scope: MemoryScope,
    title?: string,
    options?: NewSessionOptions,
  ): Promise<Session> {
    await this.detach(scope)
    const record = await this.store.create(scope)
    if (title?.trim()) record.title = title.trim()
    await this.store.setBinding(scopeKey(scope), record.id)
    // Not written out here: a session takes its file on its first turn, so a run
    // that opens a conversation and never speaks in it leaves nothing behind.
    return this.adopt(record, scope, options)
  }

  /**
   * Leaving a session for another one. Its recap is written in the background,
   * so a switch never waits on a model call; `flush()` waits for the ones still
   * in flight. The binding is read here, before the caller rebinds it, so the
   * recap is of the session actually being left.
   */
  private async detach(scope: MemoryScope, keepId?: string): Promise<void> {
    const bound = await this.store.getBinding(scopeKey(scope))
    if (!bound || bound === keepId) return
    const record = await this.store.load(bound)
    if (!record) return
    // `adopt` hands back the session already in use when there is one, so the
    // recap is written from the transcript a running turn is still growing —
    // and, being kept elsewhere on disk, never gets in that turn's way.
    const pending = this.adopt(record, scope)
      .recap()
      .catch((error) => logWarn(`could not recap session ${bound}: ${errorMessage(error)}`))
    this.pendingRecaps.add(pending)
    void pending.finally(() => this.pendingRecaps.delete(pending))
  }

  private adopt(record: SessionRecord, scope: MemoryScope, options?: NewSessionOptions): Session {
    const cached = this.cache.get(record.id)
    if (cached) {
      cached.scope = scope
      return this.touch(record.id, cached)
    }
    const session = new Session({
      scope,
      provider: this.options.provider,
      providerFor: this.options.providerFor,
      mediaModels: this.options.mediaModels,
      model: this.options.model,
      system: this.options.system,
      registry: this.options.registry,
      memory: this.options.memory,
      cwd: this.options.cwd,
      // A getter, not the list: the system prompt is built per turn, and a skill
      // installed since the last one belongs in it.
      skills: this.options.skills ? () => this.options.skills!.list() : undefined,
      maxSteps: this.options.maxSteps,
      maxTokens: this.options.maxTokens,
      temperature: this.options.temperature,
      recallLimit: this.options.recallLimit,
      derive: this.options.derive,
      permissionPolicy: this.options.permissionPolicy,
      grantedTools: options?.grantedTools,
      deliverTo: options?.deliverTo,
      record,
      store: this.store,
      recaps: this.recaps,
      sessions: this.options.sessions,
      history: this.options.history,
      routine: this.options.routine,
      lookupContextWindow: this.options.lookupContextWindow,
      keepSnapshots: this.options.keepSnapshots,
      // A getter, so the prompt says what the browser is now rather than what it
      // was when the runtime was built.
      browser: () => this.browser?.facts() ?? null,
      // Likewise the servers, and for the reason the catalog cannot cover: a
      // server toggled, reloaded or reconnected since the runtime was built is in
      // the report, and one that is off or failed is in it too.
      mcp: () => (this.mcp ? mcpFacts(this.mcp) : null),
      // A plain value: the grant does not move under a running process — a new
      // one needs a restart for its tools to appear, and this says the same.
      google: this.options.google ?? null,
      // A getter, not the value: `/effort` changes what the next turn sends
      // without the runtime having to be rebuilt around it.
      reasoningEffort: () => this.reasoningEffort,
      onIdle: (idleSession) => this.onSessionIdle(idleSession),
    })
    this.cacheSession(record.id, session)
    return session
  }

  private touch(id: string, session: Session): Session {
    this.cache.delete(id)
    this.cache.set(id, session)
    return session
  }

  private cacheSession(id: string, session: Session): void {
    this.cache.delete(id)
    this.cache.set(id, session)
    this.pruneCache()
  }

  private onSessionIdle(session: Session): void {
    // Routine sessions run once and are never resumed interactively.
    if (session.scope.gateway === ROUTINE_GATEWAY) {
      this.cache.delete(session.id)
    } else {
      this.pruneCache()
    }
  }

  private pruneCache(): void {
    const limit = this.options.maxCachedSessions ?? DEFAULT_MAX_CACHED_SESSIONS
    if (this.cache.size <= limit) return
    for (const [id, session] of this.cache.entries()) {
      if (this.cache.size <= limit) break
      if (!session.busy) {
        this.cache.delete(id)
      }
    }
  }
}
