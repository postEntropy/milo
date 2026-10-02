import type { TodoItem } from '../todos.js'

export type AgentEvent =
  | { type: 'text-delta'; delta: string }
  | { type: 'reasoning-delta'; delta: string }
  | { type: 'tool-start'; id: string; name: string; args: unknown }
  | { type: 'tool-end'; id: string; name: string; result: string; isError: boolean }
  /**
   * The plan the turn is keeping changed. A surface draws the whole list from
   * this; it is never part of the transcript sent back to the model, because the
   * model is the one that set it.
   */
  | { type: 'todo'; items: TodoItem[] }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  /**
   * The transcript was compacted just before this turn. A session-level event
   * rather than a loop one: it happens first, it costs a model call of its own,
   * and without it the wait it adds is read as the model thinking.
   */
  | { type: 'compacted'; ms: number }
  /**
   * This session was not as this copy had it: another Milo used it in between —
   * the same conversation reached from a second terminal, or a daemon — and what
   * it left is now the base of this turn's transcript. `added` counts the
   * messages the screen has not shown; `compacted` says the turns that are gone
   * were summarized away rather than only appended to. Nothing is lost quietly:
   * the surface can say the answer is drawn from more — or less — than it showed.
   */
  | { type: 'rebased'; added: number; compacted: boolean }
  /**
   * Another holder has this session and the turn is waiting for it. Said before
   * the wait, so the quiet is attributed to the wait and not to the model.
   */
  | { type: 'waiting' }
  /**
   * The wait is over, and what it cost. The turn starts here: without this the
   * time between the lease being taken and the model's first token would be
   * charged to the wait, and a slow model would read as a slow queue.
   */
  | { type: 'waited'; ms: number }
  /**
   * A message the user sent while the turn was already running, taken up at a
   * step boundary. The turn carries on with it — a correction, not a new turn.
   */
  | { type: 'steer'; text: string }
  | { type: 'done'; finishReason: string }
  /** The turn was stopped (Ctrl+C, shutdown) — not a failure. */
  | { type: 'aborted' }
  | { type: 'error'; message: string }
