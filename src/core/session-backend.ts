import type { AgentEvent } from './agent/events.js'
import type { Message } from './providers/types.js'
import type { CommandCodeSessionBackend, SessionRecord } from './sessions/types.js'

export interface NativeSessionHistory {
  messages: Message[]
  nativeSessionId?: string
  title?: string
  preview: string
  messageCount: number
  updatedAt: number
}

export interface NativeSessionTurn {
  backend: CommandCodeSessionBackend
  history: NativeSessionHistory
  error?: string
}

export interface SessionBackendAvailability {
  id: 'command-code'
  available: boolean
  reason?: string
}

export interface CommandCodeSessionDriver {
  availability(): Promise<SessionBackendAvailability>
  history(record: SessionRecord): Promise<NativeSessionHistory>
  send(
    record: SessionRecord,
    input: string,
    options?: {
      signal?: AbortSignal
      retryPending?: boolean
      newTurn?: boolean
      onBackendUpdate?: (backend: CommandCodeSessionBackend) => Promise<void>
    },
  ): AsyncGenerator<AgentEvent, NativeSessionTurn, void>
  stop(record: SessionRecord): Promise<CommandCodeSessionBackend>
}
