/** A slice this big out of the visible height is a keyboard; the address bar's own
 *  shifting is far smaller, so the two are never confused. */
const KEYBOARD_MIN = 120

/**
 * Follows the phone's visible area so the composer rides the keyboard up and comes
 * back down with it.
 *
 * On iOS the keyboard shrinks the visual viewport **and** pans it — `height` and
 * `offsetTop` both move — and the shell has to follow both, or it ends up partly
 * outside what is on screen. The page itself must not scroll while this happens
 * (`body` is pinned): the browser's own scroll to bring the focused field into
 * view is a second lift on top of this one, and the composer overshoots the keys.
 *
 * Nothing is set unless the keyboard is actually up. iOS 26 leaves `offsetTop`
 * stuck above zero after the keyboard is dismissed, and going back to the
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
