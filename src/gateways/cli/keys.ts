/**
 * Ctrl+C. Ink is rendered with `exitOnCtrlC: false`, and in raw mode the
 * terminal no longer raises SIGINT, so every screen has to recognise the
 * keypress itself.
 */
export function isCtrlC(input: string, key: { ctrl?: boolean }): boolean {
  if (input === '\u0003') return true
  return Boolean(key.ctrl && input.toLowerCase() === 'c')
}
