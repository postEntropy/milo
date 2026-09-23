/**
 * Ctrl+C. Ink is rendered with `exitOnCtrlC: false`, and in raw mode the
 * terminal no longer raises SIGINT, so every screen has to recognise the
 * keypress itself.
 */
export function isCtrlC(input: string, key: { ctrl?: boolean }): boolean {
  if (input === '\u0003') return true
  return Boolean(key.ctrl && input.toLowerCase() === 'c')
}

/**
 * Ctrl+Enter: hand the message to the turn already running instead of queueing
 * it behind. Alt+Enter does the same, because a terminal only reports the Ctrl
 * modifier on Enter when the kitty keyboard protocol is on (see `kittyKeyboard`
 * in `bin/cli.ts`) — and Alt+Enter is distinguishable without it.
 */
export function isSteerKey(key: { ctrl?: boolean; meta?: boolean }): boolean {
  return Boolean(key.ctrl || key.meta)
}
