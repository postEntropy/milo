import { toHtml, toPlain } from './html.js'

export interface TelegramSender {
  sendHtml(chatId: string, html: string): Promise<number>
  sendPlain(chatId: string, text: string): Promise<number>
  editHtml(chatId: string, messageId: number, html: string): Promise<void>
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
 * Sends the answer as an ordinary Telegram message in HTML, and degrades to
 * plain text when the API refuses it — the words without the markup, never the
 * raw Markdown, which would show the person its fences and asterisks.
 *
 * Once a message has failed as HTML it stays plain for the rest of its life, so
 * a half-written block mid-stream cannot make the bubble flip between the two on
 * every edit.
 *
 * One per turn: whether the API takes the markup is a fact about one message,
 * and a turn is one message.
 */
export class TelegramMessenger {
  private html = true

  constructor(private readonly sender: TelegramSender) {}

  get usingHtml(): boolean {
    return this.html
  }

  async post(chatId: string, markdown: string): Promise<number> {
    if (this.html) {
      try {
        return await this.sender.sendHtml(chatId, toHtml(markdown))
      } catch {
        this.html = false
      }
    }
    return this.sender.sendPlain(chatId, toPlain(markdown))
  }

  async edit(chatId: string, messageId: number, markdown: string): Promise<void> {
    if (this.html) {
      try {
        await this.sender.editHtml(chatId, messageId, toHtml(markdown))
        return
      } catch {
        this.html = false
      }
    }
    await this.sender.editPlain(chatId, messageId, toPlain(markdown))
  }
}
