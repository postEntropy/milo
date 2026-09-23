import type { SessionsConfig } from './config/schema.js'
import type { HistoryWriter } from './history.js'
import type { Memory, MemoryScope } from './memory/index.js'
import { scopeKey } from './memory/index.js'
import type { Provider } from './providers/types.js'
import type { PermissionPolicy } from './tools/index.js'
import type { ToolRegistry } from './tools/index.js'
import { Session } from './session.js'
import {
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

export interface RuntimeOptions {
  provider: Provider
  model: string
  system: string
  registry: ToolRegistry
  memory: Memory
  cwd: string
  maxSteps?: number
  maxTokens?: number
  temperature?: number
  recallLimit?: number
  permissionPolicy?: PermissionPolicy
  /** Defaults to an in-memory store, which keeps tests off the disk. */
  store?: SessionStore
  /** Where a session's recap is kept, out of its transcript. In-memory by default. */
  recaps?: RecapStore
  sessions?: SessionsConfig
  /** Where turns are logged for later recall; absent means nothing is logged. */
  history?: HistoryWriter
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
        return cached
      }
      const record = await this.store.load(bound)
      // A binding whose record is gone falls through to a fresh session.
      if (record) return this.adopt(record, scope)
    }
    return this.createSession(scope)
  }

  /** Starts a fresh session and rebinds `scope` to it. */
  async newSession(scope: MemoryScope, title?: string): Promise<Session> {
    return this.createSession(scope, title)
  }

  /** Rebinds `scope` to an existing session; null when the id is unknown. */
  async resumeSession(scope: MemoryScope, id: string): Promise<Session | null> {
    const cached = this.cache.get(id)
    if (cached) {
      await this.detach(scope, id)
      cached.scope = scope
      await this.store.setBinding(scopeKey(scope), id)
      return cached
    }
    const record = await this.store.load(id)
    if (!record) return null
    await this.detach(scope, id)
    const session = this.adopt(record, scope)
    await this.store.setBinding(scopeKey(scope), id)
    return session
  }

  async listSessions(): Promise<SessionSummary[]> {
    return withRecaps(await this.store.list(), this.recaps)
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

  get permissions(): PermissionPolicy | undefined {
    return this.options.permissionPolicy
  }

  reset(): void {
    this.cache.clear()
  }

  private async createSession(scope: MemoryScope, title?: string): Promise<Session> {
    await this.detach(scope)
    const record = await this.store.create()
    if (title?.trim()) record.title = title.trim()
    await this.store.setBinding(scopeKey(scope), record.id)
    const session = this.adopt(record, scope)
    // Write it out now, so it shows up in /sessions and is /resume-able right away.
    await session.persist()
    return session
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

  private adopt(record: SessionRecord, scope: MemoryScope): Session {
    const cached = this.cache.get(record.id)
    if (cached) {
      cached.scope = scope
      return cached
    }
    const session = new Session({
      scope,
      provider: this.options.provider,
      model: this.options.model,
      system: this.options.system,
      registry: this.options.registry,
      memory: this.options.memory,
      cwd: this.options.cwd,
      maxSteps: this.options.maxSteps,
      maxTokens: this.options.maxTokens,
      temperature: this.options.temperature,
      recallLimit: this.options.recallLimit,
      permissionPolicy: this.options.permissionPolicy,
      record,
      store: this.store,
      recaps: this.recaps,
      sessions: this.options.sessions,
      history: this.options.history,
    })
    this.cache.set(record.id, session)
    return session
  }
}
