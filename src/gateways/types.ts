import type { AgentRuntime } from '../core/runtime.js'

export type GatewayId = 'cli' | 'telegram' | 'discord' | 'web'

export interface Gateway {
  readonly id: GatewayId
  start(): Promise<void>
  stop(): Promise<void>
  /**
   * Posts a message with no turn behind it, so a routine's answer can reach the
   * chat. Absent on a surface that cannot be written to out of band — the CLI is
   * a prompt someone is sitting at, not a place a timer can speak into.
   */
  deliver?(conversationId: string, text: string): Promise<void>
}

export interface GatewayRuntimeOptions {
  runtime: AgentRuntime
}
