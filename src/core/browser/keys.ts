/**
 * One key, as CDP's `Input.dispatchKeyEvent` wants it: the name a page's handlers
 * see, the physical `code`, its virtual key code, and the modifier bitmask. Kept
 * apart from the session so the mapping — including the letters and digits a
 * shortcut needs a virtual key code for — can be tested without a browser.
 */

export interface KeyStroke {
  key: string
  code: string
  windowsVirtualKeyCode: number
  nativeVirtualKeyCode: number
  modifiers: number
  text?: string
}

/** Keys worth naming: a name the page's own handlers recognise. */
const KEY_CODES: Record<string, { code: string; keyCode: number; text?: string }> = {
  enter: { code: 'Enter', keyCode: 13, text: '\r' },
  tab: { code: 'Tab', keyCode: 9 },
  escape: { code: 'Escape', keyCode: 27 },
  backspace: { code: 'Backspace', keyCode: 8 },
  delete: { code: 'Delete', keyCode: 46 },
  space: { code: 'Space', keyCode: 32, text: ' ' },
  arrowup: { code: 'ArrowUp', keyCode: 38 },
  arrowdown: { code: 'ArrowDown', keyCode: 40 },
  arrowleft: { code: 'ArrowLeft', keyCode: 37 },
  arrowright: { code: 'ArrowRight', keyCode: 39 },
  pagedown: { code: 'PageDown', keyCode: 34 },
  pageup: { code: 'PageUp', keyCode: 33 },
  home: { code: 'Home', keyCode: 36 },
  end: { code: 'End', keyCode: 35 },
}

/** A letter or a digit's code and virtual key code, which its character gives. */
function alphanumeric(key: string): { code: string; keyCode: number } | null {
  if (!/^[a-zA-Z0-9]$/.test(key)) return null
  const upper = key.toUpperCase()
  return /[0-9]/.test(key)
    ? { code: `Digit${key}`, keyCode: upper.charCodeAt(0) }
    : { code: `Key${upper}`, keyCode: upper.charCodeAt(0) }
}

/**
 * The stroke for one key. A letter or digit derives its code from the character, so
 * a shortcut like Cmd+A reaches the page with a real virtual key code instead of a
 * name the page ignores; anything else not named above falls back to itself.
 */
export function keyStroke(key: string, modifiers: number): KeyStroke {
  const table = KEY_CODES[key.toLowerCase()] ?? alphanumeric(key)
  return {
    key,
    code: table?.code ?? key,
    windowsVirtualKeyCode: table?.keyCode ?? 0,
    nativeVirtualKeyCode: table?.keyCode ?? 0,
    modifiers,
    // With a modifier held the key is a shortcut, not text: no literal to insert.
    ...(table?.text && modifiers === 0 ? { text: table.text } : {}),
  }
}
