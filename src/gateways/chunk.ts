/**
 * Breaks a message into pieces a chat will accept, preferring a line boundary and
 * falling back to a word one, so a long report is not cut mid-sentence.
 *
 * A routine posts its answer here rather than through the streaming
 * surface, which *trims* to fit — trimming would eat the end of the very thing
 * that was asked for, and there is no message to keep editing afterwards.
 */
export function chunk(text: string, maxLength: number): string[] {
  const clean = text.trim()
  if (!clean) return []
  if (clean.length <= maxLength) return [clean]

  const parts: string[] = []
  let rest = clean
  while (rest.length > maxLength) {
    let cut = rest.lastIndexOf('\n', maxLength)
    if (cut < maxLength * 0.5) cut = rest.lastIndexOf(' ', maxLength)
    if (cut <= 0) cut = maxLength
    parts.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  if (rest) parts.push(rest)
  return parts
}
