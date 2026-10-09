/**
 * What a keystroke in the live browser becomes. Kept apart from the component so
 * the awkward part — which keys are characters, which are shortcuts, and the
 * modifier bitmask CDP wants — is pure and can be tested without a browser.
 */
import type { PanelInput } from '@protocol'

/** The event fields this reads, so a synthetic event is as good as a real one. */
export interface KeyEvent {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}

/** Keys that are a modifier themselves: pressing one sends nothing. */
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph', 'OS'])

/** `key` values an IME or a dead key reports while it is composing; the composed text comes later. */
const COMPOSING_KEYS = new Set(['Process', 'Unidentified', 'Dead'])

/** CDP's modifier bitmask. */
export function modifiersOf(event: KeyEvent): number {
  return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0)
}

/**
 * The input for one keydown, or null when it carries nothing to send. A printable
 * character goes as text, so it lands in a field however the page listens; anything
 * with Ctrl/Cmd/Alt held is a shortcut and goes as a key with its modifiers so the
 * page's own handlers see it. Ctrl/Cmd+V returns null on purpose: the browser fires
 * its paste event for that, and the clipboard text is forwarded from there.
 */
export function panelInputFor(event: KeyEvent): PanelInput | null {
  if (MODIFIER_KEYS.has(event.key) || COMPOSING_KEYS.has(event.key)) return null
  const modifiers = modifiersOf(event)
  if ((event.ctrlKey || event.metaKey) && (event.key === 'v' || event.key === 'V')) return null
  if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
    return { kind: 'type', text: event.key }
  }
  return { kind: 'key', key: event.key, ...(modifiers ? { modifiers } : {}) }
}

/** Typed or pasted text — a paste, or the result of an IME composing a character. */
export function typedInput(text: string): PanelInput | null {
  return text ? { kind: 'type', text } : null
}
