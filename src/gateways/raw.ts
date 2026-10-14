import { holdsGenUi } from '../core/genui.js'
import type { ContentPart, Message } from '../core/providers/types.js'
import { block } from '../util/markdown.js'
import { toolDisplayName } from './tool-line.js'

/** What a copy of a turn carries: the results' own words, or the path without them. */
export interface RawOptions {
  /**
   * The text a tool result came back with. Left out, the copy is the path the turn
   * walked: every call keeps its name and its arguments, and a call that failed still
   * says so — nothing goes wrong in silence, and nothing the model read floods the copy.
   */
  output?: boolean
}

/**
 * A turn copied whole: what the model said, what it thought, what it called and what
 * came back — the record behind the answer, not the answer drawn on a surface.
 *
 * Rendered on the server, once, because a surface never holds this. It is sent a tool
 * call as one line (`ToolMark`) and a widget as a tree, and the arguments, the results
 * and the block's own JSON never cross the wire — so a page rebuilding the raw could
 * only guess at what was left out, a truncated call and no result among the guesses.
 * The whole of it is here, so the whole of it is rendered here and travels as a string.
 *
 * The same function renders the turn's path with `output` off, which is the other choice
 * under one copy control: the two cannot drift apart, because there is only one of them.
 *
 * Null when the turn is prose and nothing else, which is the one case the plain copy
 * already covers: a surface offers the raw copy only where it is more than the words.
 */
export function rawTurn(messages: Message[], options: RawOptions = {}): string | null {
  const output = options.output ?? true
  const sections: string[] = []
  let more = false
  for (const message of messages) {
    // The model's own output: the person's words were their own message, and are not
    // what this is a copy of.
    if (message.role !== 'assistant' && message.role !== 'tool') continue
    for (const part of message.content) {
      const section = sectionOf(part, output)
      if (section === null) continue
      sections.push(section)
      if (moreThanProse(part, output)) more = true
    }
  }
  return more ? sections.join('\n\n') : null
}

/** One part as it reads in the raw, or null for one with nothing to show. */
function sectionOf(part: ContentPart, output: boolean): string | null {
  if (part.type === 'reasoning') {
    return part.text.trim() ? `**Reasoning**\n\n${block(part.text)}` : null
  }
  // The model's words verbatim, which is what keeps a `genui` block in its own JSON
  // rather than the drawn widget: the block is the model's text, and the raw is a copy
  // of the model's text.
  if (part.type === 'text') return part.text.replace(/\s+$/, '') || null
  if (part.type === 'tool-call') {
    const args = JSON.stringify(part.args ?? {}, null, 2)
    return `**${toolDisplayName(part.name)}**\n\n${block(args)}`
  }
  if (part.type === 'tool-result') {
    // Without the output the result is not quoted, only said: what came back is not the
    // copy's business here, and a failure is the one thing that would otherwise vanish
    // from the path entirely.
    if (!output) return part.isError ? '**Result — it failed**' : null
    if (!part.content.trim()) return null
    return `**Result${part.isError ? ' — it failed' : ''}**\n\n${block(part.content)}`
  }
  return null
}

/**
 * What makes a turn worth a raw copy: a thought, a call, a result, or a block the model
 * wrote to be drawn. Anything else is the words the plain copy already holds. A result
 * the copy leaves out counts for nothing — a failed one it still says does count.
 */
function moreThanProse(part: ContentPart, output: boolean): boolean {
  if (part.type === 'reasoning' || part.type === 'tool-call') return true
  if (part.type === 'tool-result') return output || part.isError === true
  return part.type === 'text' && holdsGenUi(part.text)
}
