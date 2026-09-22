const ALT_SCREEN_ON = '\u001b[?1049h'
const ALT_SCREEN_OFF = '\u001b[?1049l'

let active = false
let hooked = false

function restore(): void {
  if (active) {
    process.stdout.write(ALT_SCREEN_OFF)
    active = false
  }
}

export function enterAltScreen(): void {
  if (!hooked) {
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
  if (active) return
  active = true
  process.stdout.write(ALT_SCREEN_ON)
}

export function exitAltScreen(): void {
  restore()
}
