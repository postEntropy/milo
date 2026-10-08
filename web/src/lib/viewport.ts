/** A slice this big out of the visible height is a keyboard; the address bar's own
 *  shifting is far smaller, so the two are never confused. */
const KEYBOARD_MIN = 120

/**
 * Follows the phone's visible area so the composer rides the keyboard up and comes
 * back down with it.
 *
 * On iOS the keyboard shrinks the visual viewport **and** pans it — `height` and
 * `offsetTop` both move — and the composer has to follow both, or it ends up
 * behind the keys. `--keyboard-gap` is the space the keyboard covers, which the
 * phone's sticky composer is held up by; `--app-top` is the pan, which the fixed
 * topbar follows. The page scrolls on a phone — that is what Safari wants — so
 * this is a lift, not a shrink.
 *
 * Nothing is set unless the keyboard is actually up. iOS 26 leaves `offsetTop`
 * stuck above zero after the keyboard is dismissed, and dropping back to the
 * stylesheet's own `100dvh` — rather than following that stale offset — is what
 * makes the composer return instead of staying lifted with a gap beneath it.
 *
 * Pinch-zoom is left alone on purpose: it changes the visual viewport too, but
 * following it would reflow the whole app as the person zooms in.
 */
export function trackVisualViewport(): () => void {
  const viewport = window.visualViewport
  if (!viewport) return () => {}
  const root = document.documentElement
  const clear = (): void => {
    root.style.removeProperty('--app-height')
    root.style.removeProperty('--app-top')
    root.style.removeProperty('--keyboard-gap')
  }

  const apply = (): void => {
    if (Math.abs(viewport.scale - 1) > 0.01) { clear(); return }
    const keyboard = root.clientHeight - viewport.height
    if (keyboard <= KEYBOARD_MIN) { clear(); return }
    // Never lifted further than the keyboard is tall: mid-animation the pan can
    // report more than the keys cover for a frame, which threw the composer above
    // them before it settled back down.
    const top = Math.min(Math.max(viewport.offsetTop, 0), keyboard)
    root.style.setProperty('--app-height', `${viewport.height}px`)
    root.style.setProperty('--app-top', `${top}px`)
    // How far the visible area's foot sits above the layout viewport's: the space
    // the keyboard covers. The phone's sticky composer is held up by exactly this.
    const gap = Math.max(0, root.clientHeight - viewport.offsetTop - viewport.height)
    root.style.setProperty('--keyboard-gap', `${gap}px`)
  }

  apply()
  viewport.addEventListener('resize', apply)
  viewport.addEventListener('scroll', apply)
  return () => {
    viewport.removeEventListener('resize', apply)
    viewport.removeEventListener('scroll', apply)
    clear()
  }
}
