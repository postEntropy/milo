import type { CommandResult } from '../commands.js'
import { chunk } from '../chunk.js'

/**
 * A command reply as the messages it goes out as, split from **one** source: the
 * Markdown when the command has a rendering for it, the plain text otherwise.
 *
 * One source is what makes the fallback safe. A part that goes out as the words
 * alone is the same part that would have gone out as HTML, so a reply the API
 * refuses halfway — "message is too long", markup it cannot parse — continues at
 * the part that failed instead of starting over and repeating what the person
 * already read.
 *
 * `markdown` says whether the first part may be attempted as HTML at all; a
 * command with no rendering goes out plain from the first message. Either way it
 * is split to the limit, because a command reply can outgrow one message:
 * `/sessions` lists up to ten conversations with their recaps, and Telegram
 * refuses a whole one with "message is too long", which is a failure a command
 * must not end in.
 */
export function commandReplyParts(
  command: CommandResult,
  maxLength: number,
): { parts: string[]; markdown: boolean } {
  const markdown = Boolean(command.markdown)
  return {
    parts: chunk(markdown ? command.markdown! : (command.reply ?? ''), maxLength),
    markdown,
  }
}
