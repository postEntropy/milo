export type AgentEvent =
  | { type: 'text-delta'; delta: string }
  | { type: 'reasoning-delta'; delta: string }
  | { type: 'tool-start'; id: string; name: string; args: unknown }
  | { type: 'tool-end'; id: string; name: string; result: string; isError: boolean }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  /**
   * The transcript was compacted just before this turn. A session-level event
   * rather than a loop one: it happens first, it costs a model call of its own,
   * and without it the wait it adds is read as the model thinking.
   */
  | { type: 'compacted'; ms: number }
  /**
   * A message the user sent while the turn was already running, taken up at a
   * step boundary. The turn carries on with it — a correction, not a new turn.
   */
  | { type: 'steer'; text: string }
  | { type: 'done'; finishReason: string }
  /** The turn was stopped (Ctrl+C, shutdown) — not a failure. */
  | { type: 'aborted' }
  | { type: 'error'; message: string }
