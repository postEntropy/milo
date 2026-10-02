/**
 * Cuts a long tool output in the middle rather than at the end.
 *
 * The head carries the command's own chatter and the tail carries the error
 * (stderr is appended last), so trimming only the end is precisely how a
 * failure's message is thrown away. Shared by every tool that runs a process,
 * so the same rule holds wherever the output is big.
 */
export function clipMiddle(text: string, max: number, headShare = 0.6): string {
  if (text.length <= max) return text
  const head = text.slice(0, Math.floor(max * headShare))
  const tail = text.slice(-(max - head.length))
  const omitted = text.length - head.length - tail.length
  return `${head}\n… ${omitted} character(s) omitted …\n${tail}`
}
