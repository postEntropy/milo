/**
 * A URL an emulator can click. Wrapping the visible text in an OSC 8 hyperlink
 * makes it a real link in terminals that support it (Kitty, Ghostty, WezTerm,
 * foot, iTerm2, Windows Terminal), whatever their own URL detector decides — and
 * prints it bare when the stream is not a terminal, so a redirected log stays
 * text. The text is left unchanged on screen: only the escape is added.
 */
export function hyperlink(url: string, text = url): string {
  if (!process.stderr.isTTY) return text
  return `\u001b]8;;${url}\u001b\\${text}\u001b]8;;\u001b\\`
}
