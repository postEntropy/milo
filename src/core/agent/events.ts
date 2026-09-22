export type AgentEvent =
  | { type: 'text-delta'; delta: string }
  | { type: 'reasoning-delta'; delta: string }
  | { type: 'tool-start'; id: string; name: string; args: unknown }
  | { type: 'tool-end'; id: string; name: string; result: string; isError: boolean }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'done'; finishReason: string }
  | { type: 'error'; message: string }
