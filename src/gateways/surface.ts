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
