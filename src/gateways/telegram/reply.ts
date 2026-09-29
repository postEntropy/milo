import type { CommandResult } from '../commands.js'
import { chunk } from '../chunk.js'
import { toHtml } from './html.js'

/**
 * A command reply as the messages it goes out as: the Markdown rendered to HTML
 * for the rich path, and the plain text for the fallback, each split to the
 * surface's limit.
 *
 * A command reply can outgrow one message — `/sessions` lists up to ten
 * conversations with their recaps — and Telegram refuses a whole one with
 * "message is too long", which is a failure a command must not end in.
 */
export function commandReplyParts(
  command: CommandResult,
  maxLength: number,
): { html: string[]; plain: string[] } {
  return {
    html: command.markdown ? chunk(command.markdown, maxLength).map(toHtml) : [],
    plain: chunk(command.reply ?? '', maxLength),
  }
}
