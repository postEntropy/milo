import type { ActionRow, SessionCardItem, TranscriptMessage } from '@protocol'

/**
 * One row of a conversation on a screen: what the server sent, plus what the page
 * knows about it while the turn is being drawn.
 *
 * Its own module because it is named by both the renderer and the fold of agent
 * events — and the fold is asked for by tests that have no DOM to give it.
 */
export interface ChatMessage extends TranscriptMessage {
  id: string
  status?: string
  /** What this turn cost the model: tokens in, tokens out. */
  tokens?: { input: number; output: number }
  /** How long the model took before its first output of this turn, in ms. */
  thoughtMs?: number
  /** When the turn's wait for its next output began: what the thought time is
   *  measured from, and that its own line belongs on screen. */
  waitingSince?: number
  /** Already on screen when the session was opened, so it does not settle in again. */
  loaded?: boolean
  actions?: ActionRow[]
  cards?: SessionCardItem[]
}
