import type { AgentRuntime } from '../core/runtime.js'

export type GatewayId = 'cli' | 'telegram' | 'discord'

export interface Gateway {
  readonly id: GatewayId
  start(): Promise<void>
  stop(): Promise<void>
}

export interface GatewayRuntimeOptions {
  runtime: AgentRuntime
}
