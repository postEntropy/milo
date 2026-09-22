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
}
