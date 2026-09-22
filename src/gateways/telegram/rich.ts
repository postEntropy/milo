export interface RichSender {
  sendRich(chatId: string, markdown: string): Promise<number>
  sendPlain(chatId: string, text: string): Promise<number>
  editRich(chatId: string, messageId: number, markdown: string): Promise<void>
  editPlain(chatId: string, messageId: number, text: string): Promise<void>
}

/**
 * Telegram shows "message is not modified" whenever an edit repeats the current
 * content — which happens constantly while streaming. It is not a real failure
 * and must not be treated as one.
 */
export function isNotModified(error: unknown): boolean {
  const description = (error as { description?: string } | null)?.description ?? ''
  return description.includes('message is not modified')
}

/**
 * Sends the answer as a Telegram **rich message** (Bot API 10.1+) and degrades to
 * plain text when the API refuses it. Once a message has failed as rich it stays
 * plain for the rest of its life, so a half-written table mid-stream cannot make
 * the bubble flip between rich and plain on every edit.
 */
export class RichMessenger {
  private rich = true

  constructor(private readonly sender: RichSender) {}

  /** Call once per turn. */
  reset(): void {
    this.rich = true
  }

  get usingRich(): boolean {
    return this.rich
  }

  async post(chatId: string, markdown: string): Promise<number> {
    if (this.rich) {
      try {
        return await this.sender.sendRich(chatId, markdown)
      } catch {
        this.rich = false
      }
    }
    return this.sender.sendPlain(chatId, markdown)
  }

  async edit(chatId: string, messageId: number, markdown: string): Promise<void> {
    if (this.rich) {
      try {
        await this.sender.editRich(chatId, messageId, markdown)
        return
      } catch {
        this.rich = false
      }
    }
    await this.sender.editPlain(chatId, messageId, markdown)
  }
}
