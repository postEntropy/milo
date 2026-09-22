import type { Memory, MemoryScope } from './memory/index.js'
import { scopeKey } from './memory/index.js'
import type { Provider } from './providers/types.js'
import type { PermissionPolicy } from './tools/index.js'
import type { ToolRegistry } from './tools/index.js'
import { Session } from './session.js'

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
}

/**
 * The transport-agnostic core. Gateways ask it for a Session keyed by
 * conversation; the same key always returns the same history and memory scope.
 */
export class AgentRuntime {
  private readonly sessions = new Map<string, Session>()
  private readonly options: RuntimeOptions

  constructor(options: RuntimeOptions) {
    this.options = options
  }

  getSession(scope: MemoryScope): Session {
    const key = scopeKey(scope)
    let session = this.sessions.get(key)
    if (!session) {
      session = new Session({ id: key, scope, ...this.options })
      this.sessions.set(key, session)
    }
    return session
  }

  get sessionCount(): number {
    return this.sessions.size
  }

  get permissions(): PermissionPolicy | undefined {
    return this.options.permissionPolicy
  }

  reset(): void {
    this.sessions.clear()
  }
}
