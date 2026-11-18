import type { CommandResult } from '../commands.js'
import { chunk } from '../chunk.js'
import { toHtml } from './html.js'

const TELEGRAM_HTML_MAX = 4096

function splitHtmlSafe(part: string, htmlLimit: number): string[] {
  if (toHtml(part).length <= htmlLimit) return [part]
  const out: string[] = []
  const queue = [part]
  while (queue.length > 0) {
    const item = queue.shift()!
    const htmlLen = toHtml(item).length
    if (htmlLen <= htmlLimit || item.length <= 1) {
      out.push(item)
      continue
    }
    const target = Math.max(64, Math.floor((item.length * htmlLimit) / htmlLen * 0.85))
    const pieces = target < item.length ? chunk(item, target) : [item.slice(0, Math.ceil(item.length / 2)), item.slice(Math.ceil(item.length / 2))]
    if (pieces.length <= 1) {
      const mid = Math.ceil(item.length / 2)
      queue.unshift(item.slice(0, mid), item.slice(mid))
    } else {
      queue.unshift(...pieces)
    }
  }
  return out
}

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
  maxHtmlLength = TELEGRAM_HTML_MAX,
): { parts: string[]; markdown: boolean } {
  const markdown = Boolean(command.markdown)
  const rawParts = chunk(markdown ? command.markdown! : (command.reply ?? ''), maxLength)
  return {
    parts: markdown ? rawParts.flatMap((part) => splitHtmlSafe(part, maxHtmlLength)) : rawParts,
    markdown,
  }
}
