import type { OutgoingFile } from '../core/outgoing.js'
import type { PermissionRequest } from '../core/tools/permission.js'

/**
 * What a turn needs from a chat transport. Every gateway (Telegram, Discord,
 * …) implements this once; the turn logic itself lives in `runner.ts` and is
 * transport-agnostic and testable with a fake surface.
 */
export interface ChatSurface {
  /** Post the initial placeholder and return a message handle. */
  post(conversationId: string, text: string): Promise<string>
  /** Replace the message text (called as the answer streams). */
  edit(conversationId: string, messageId: string, text: string): Promise<void>
  /** Ask for permission inline; must resolve false on expiry. */
  ask(conversationId: string, messageId: string, request: PermissionRequest): Promise<boolean>
  /**
   * Post the files the turn asked to send, as their own messages. Called once the
   * turn is over, so the files follow the answer rather than interrupting it.
   */
  files(conversationId: string, files: OutgoingFile[]): Promise<void>
  /**
   * Keep the transport's own "Milo is working" indicator on — Telegram's chat
   * action, Discord's typing — until the returned function is called.
   *
   * The surface owns the refreshing, because both engines expire on their own
   * clock (Telegram's action after about five seconds, Discord's typing after
   * ten) and neither renews itself. The turn calls this once, at its start, and
   * stops it when it ends — including when it ends badly: an indicator nobody
   * stopped keeps saying the bot is working at a turn that is long over.
   */
  typing(conversationId: string): () => void
}
