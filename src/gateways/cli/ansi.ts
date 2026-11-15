/**
 * The terminal's own state, and giving it back.
 *
 * Everything the TUI turns on is turned off again here, from one `restore` — a
 * terminal left in the alt screen, with the mouse reporting, or with bracketed
 * paste still enabled, is a shell that behaves strangely afterwards, and only
 * the person at it can tell.
 */
const ALT_SCREEN_ON = '\u001b[?1049h'
const ALT_SCREEN_OFF = '\u001b[?1049l'
const MOUSE_ON = '\u001b[?1000h\u001b[?1006h'
const MOUSE_OFF = '\u001b[?1000l\u001b[?1006l'
const BRACKETED_PASTE_ON = '\u001b[?2004h'
const BRACKETED_PASTE_OFF = '\u001b[?2004l'

let altScreen = false
let mouse = false
let bracketedPaste = false
let hooked = false

function restore(): void {
  if (altScreen) {
    process.stdout.write(ALT_SCREEN_OFF)
    altScreen = false
  }
  if (mouse) {
    process.stdout.write(MOUSE_OFF)
    mouse = false
  }
  if (bracketedPaste) {
    process.stdout.write(BRACKETED_PASTE_OFF)
    bracketedPaste = false
  }
}

function hookOnce(): void {
  if (hooked) return
  hooked = true
  process.on('exit', restore)
  process.on('SIGINT', () => {
    restore()
    process.exit(130)
  })
  process.on('SIGTERM', () => {
    restore()
    process.exit(143)
  })
}

/** The whole screen: the TUI draws over it, and the shell's own scroll is gone. */
export function enterTui(): void {
  hookOnce()
  if (altScreen) return
  altScreen = true
  process.stdout.write(ALT_SCREEN_ON)
}

/**
 * The mouse, as SGR events. Asking the terminal to report them is what stops it
 * turning the wheel into arrow keys, which this TUI reads as the input history —
 * and on a phone, where the drag gesture *is* the wheel, that is the difference
 * between scrolling the conversation and walking through what you typed.
 */
export function enterMouseTracking(): void {
  setMouseTracking(true)
}

/** Toggle SGR mouse tracking on or off at runtime (e.g. so users can select text). */
export function setMouseTracking(enabled: boolean): void {
  if (enabled) {
    hookOnce()
    if (mouse) return
    mouse = true
    process.stdout.write(MOUSE_ON)
    return
  }
  if (!mouse) return
  mouse = false
  process.stdout.write(MOUSE_OFF)
}

/**
 * Bracketed paste mode (`CSI ? 2004 h`): wraps pasted text in `\u001b[200~` and
 * `\u001b[201~` so the TUI can distinguish pasted newlines from pressing Enter.
 */
export function enterBracketedPaste(): void {
  hookOnce()
  if (bracketedPaste) return
  bracketedPaste = true
  process.stdout.write(BRACKETED_PASTE_ON)
}

/** Encodes `text` as an OSC 52 sequence targeting the system clipboard. */
function osc52Sequence(text: string): string {
  const encoded = Buffer.from(text, 'utf8').toString('base64')
  return `\u001b]52;c;${encoded}\u0007`
}

/** Copies `text` to the terminal clipboard using OSC 52. */
export function copyToClipboard(text: string): void {
  process.stdout.write(osc52Sequence(text))
}

export function exitTui(): void {
  restore()
}
