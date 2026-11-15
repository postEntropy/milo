interface KeyInputModifiers {
  ctrl?: boolean
  meta?: boolean
  return?: boolean
}

function isCtrlLetter(input: string, key: { ctrl?: boolean }, letter: string): boolean {
  const lower = letter.toLowerCase()
  const rawControl = String.fromCharCode(lower.charCodeAt(0) - 96)
  if (input === rawControl) return true
  return Boolean(key.ctrl && input.toLowerCase() === lower)
}

/**
 * Ctrl+C. Ink is rendered with `exitOnCtrlC: false`, and in raw mode the
 * terminal no longer raises SIGINT, so every screen has to recognise the
 * keypress itself.
 */
export function isCtrlC(input: string, key: { ctrl?: boolean }): boolean {
  return isCtrlLetter(input, key, 'c')
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

/** Ctrl+O: toggle expanded tool details in the transcript. */
export function isExpandToolKey(input: string, key: { ctrl?: boolean }): boolean {
  return isCtrlLetter(input, key, 'o')
}

/**
 * Ctrl+M: toggle mouse tracking on/off so the user can select text normally.
 * Plain Return arrives as `\r` (`\u000d`) with `key.return = true` in non-kitty
 * terminals, so Return is excluded from matching raw `\u000d`.
 */
export function isMouseToggleKey(input: string, key: KeyInputModifiers): boolean {
  if (key.return) return false
  return isCtrlLetter(input, key, 'm')
}

/** Ctrl+Y: copy the latest response or selection to the clipboard. */
export function isCopyKey(input: string, key: { ctrl?: boolean }): boolean {
  return isCtrlLetter(input, key, 'y')
}
