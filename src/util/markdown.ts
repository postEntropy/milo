/**
 * Text made safe for Markdown.
 *
 * Both the session export and the raw copy of a turn hand a surface the model's own
 * words verbatim — a tool result, a thought, a block of JSON — and either can contain
 * backticks of its own. A fence drawn too short is ended by the text it is meant to
 * hold, and the rest of the block spills out as prose: the copy then says something the
 * model never did. So the fence is measured against its contents, not guessed at.
 */

/** A fence long enough that backticks inside the text cannot end it early. */
function fence(text: string): string {
  const longest = (text.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0)
  return '`'.repeat(Math.max(3, longest + 1))
}

/** Arbitrary text — a tool result, a thought — as something Markdown will not mangle. */
export function block(text: string): string {
  const body = text.replace(/\s+$/, '')
  const mark = fence(body)
  return `${mark}\n${body}\n${mark}`
}
