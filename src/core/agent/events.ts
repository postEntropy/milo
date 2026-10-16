import type { GenUiRender } from '../genui.js'
import type { PanelRequest } from '../panel.js'
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
  /**
   * The panel beside the chat changed. Carries the request — a file path or the
   * browser — which the surface resolves its own way; the web gateway turns it
   * into the renderable state and draws it. Like `todo`, it is never part of the
   * transcript sent back to the model.
   */
  | { type: 'panel'; request: PanelRequest }
  /**
   * A generated interface to draw beside the prose — the tree a block held, lifted
   * out of the stream by the loop. Like `todo` and `panel` it is display state: the
   * surfaces draw it and it is never part of the transcript sent back to the model,
   * which already has the block in its own words.
   *
   * A draft is the same widget read while the block is still being written: a prefix
   * of it, drawn because the schema accepted that prefix. A surface replaces the
   * draft with each one that follows, and with the finished `ui` when the block closes.
   */
  | { type: 'ui'; render: GenUiRender; draft?: boolean }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  /**
   * The oldest turns are being folded into the summary right now. A model call of
   * its own stands between the question and the answer and it costs seconds, so
   * the wait is named before it starts — the same reason `waiting` is said before
   * the queue rather than after it.
   */
  | { type: 'compacting' }
  /**
   * The fold is done, and what it came to: how many turns went, what they were
   * worth in estimated tokens, whether a summary was written in their place, and
   * how long the call took. A session-level event rather than a loop one: it
   * happens first, and without the numbers the wait it added reads as the model
   * thinking.
   */
  | { type: 'compacted'; ms: number; folded: number; tokens: number; summarized: boolean }
  /**
   * This session was not as this copy had it: another Milo used it in between —
   * the same conversation reached from a second terminal, or a daemon — and what
   * it left is now the base of this turn's transcript. `added` counts the
   * messages the screen has not shown, `removed` the ones that were on it and are
   * no longer there (a `/clear` or a fold from elsewhere), and `compacted` says
   * the turns that are gone were summarized away rather than only appended to.
   * Nothing is lost quietly: the answer is drawn from more — or less — than the
   * screen showed, and the surface says which.
   */
  | { type: 'rebased'; added: number; removed: number; compacted: boolean }
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
