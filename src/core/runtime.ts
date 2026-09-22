import type { SessionsConfig } from './config/schema.js'
import type { Memory, MemoryScope } from './memory/index.js'
import { scopeKey } from './memory/index.js'
import type { Provider } from './providers/types.js'
import type { PermissionPolicy } from './tools/index.js'
import type { ToolRegistry } from './tools/index.js'
import { Session } from './session.js'
import {
  MemorySessionStore,
  type SessionRecord,
  type SessionStore,
  type SessionSummary,
} from './sessions/index.js'

export interface RuntimeOptions {
  provider: Provider
  model: string
  system: string
  registry: ToolRegistry
  memory: Memory
  cwd: string
  maxSteps?: number
  temperature?: number
  recallLimit?: number
  permissionPolicy?: PermissionPolicy
  /** Defaults to an in-memory store, which keeps tests off the disk. */
  store?: SessionStore
  sessions?: SessionsConfig
}

/**
 * The transport-agnostic core. Gateways ask it for a Session; the transport
 * address is only a pointer to the session currently bound to it, so the same
 * conversation can be picked up from another gateway.
 */
export class AgentRuntime {
  private readonly cache = new Map<string, Session>()
  private readonly store: SessionStore
  private readonly options: RuntimeOptions

  constructor(options: RuntimeOptions) {
    this.options = options
    this.store = options.store ?? new MemorySessionStore()
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
      cached.scope = scope
      await this.store.setBinding(scopeKey(scope), id)
      return cached
    }
    const record = await this.store.load(id)
    if (!record) return null
    const session = this.adopt(record, scope)
    await this.store.setBinding(scopeKey(scope), id)
    return session
  }

  async listSessions(): Promise<SessionSummary[]> {
    return this.store.list()
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
    const record = await this.store.create()
    if (title?.trim()) record.title = title.trim()
    await this.store.setBinding(scopeKey(scope), record.id)
    const session = this.adopt(record, scope)
    // Write it out now, so it shows up in /sessions and is /resume-able right away.
    await session.persist()
    return session
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
      temperature: this.options.temperature,
      recallLimit: this.options.recallLimit,
      permissionPolicy: this.options.permissionPolicy,
      record,
      store: this.store,
      sessions: this.options.sessions,
    })
    this.cache.set(record.id, session)
    return session
  }
}
