/**
 * The terminal's own state, and giving it back.
 *
 * Everything the TUI turns on is turned off again here, from one `restore` — a
 * terminal left in the alt screen, or with the mouse reporting, is a shell that
 * behaves strangely afterwards, and only the person at it can tell.
 */
const ALT_SCREEN_ON = '\u001b[?1049h'
const ALT_SCREEN_OFF = '\u001b[?1049l'
const MOUSE_ON = '\u001b[?1000h\u001b[?1006h'
const MOUSE_OFF = '\u001b[?1000l\u001b[?1006l'

let altScreen = false
let mouse = false
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
  hookOnce()
  if (mouse) return
  mouse = true
  process.stdout.write(MOUSE_ON)
}

export function exitTui(): void {
  restore()
}
