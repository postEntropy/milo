import { describe, expect, it } from 'vitest'
import { modifiersOf, panelInputFor, typedInput } from '../web/src/panel/keys.js'

const event = (
  key: string,
  over: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {},
) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...over })

describe('panelInputFor', () => {
  it('sends a printable character as text, so it lands in whatever field has focus', () => {
    expect(panelInputFor(event('a'))).toEqual({ kind: 'type', text: 'a' })
    expect(panelInputFor(event('A', { shiftKey: true }))).toEqual({ kind: 'type', text: 'A' })
  })

  it('sends a named key as a key', () => {
    expect(panelInputFor(event('Enter'))).toEqual({ kind: 'key', key: 'Enter' })
    expect(panelInputFor(event('ArrowUp'))).toEqual({ kind: 'key', key: 'ArrowUp' })
  })

  it('carries a shortcut through with its modifiers, rather than as a character', () => {
    expect(panelInputFor(event('a', { metaKey: true }))).toEqual({ kind: 'key', key: 'a', modifiers: 4 })
    expect(panelInputFor(event('c', { ctrlKey: true }))).toEqual({ kind: 'key', key: 'c', modifiers: 2 })
  })

  it('holds Shift and Control and Alt alone — pressing one sends nothing', () => {
    expect(panelInputFor(event('Shift', { shiftKey: true }))).toBeNull()
    expect(panelInputFor(event('Control', { ctrlKey: true }))).toBeNull()
    expect(panelInputFor(event('Meta', { metaKey: true }))).toBeNull()
  })

  it('leaves Ctrl/Cmd+V to the paste event, which carries the clipboard text', () => {
    expect(panelInputFor(event('v', { metaKey: true }))).toBeNull()
    expect(panelInputFor(event('V', { ctrlKey: true, shiftKey: true }))).toBeNull()
  })

  it('holds the keys an IME reports while it is composing', () => {
    expect(panelInputFor(event('Process'))).toBeNull()
    expect(panelInputFor(event('Dead'))).toBeNull()
  })
})

describe('typedInput', () => {
  it('forwards pasted or composed text', () => {
    expect(typedInput('123456')).toEqual({ kind: 'type', text: '123456' })
  })

  it('sends nothing for empty text', () => {
    expect(typedInput('')).toBeNull()
  })
})

describe('modifiersOf', () => {
  it('reads CDP’s bitmask: Alt 1, Ctrl 2, Meta 4, Shift 8', () => {
    expect(modifiersOf(event('a'))).toBe(0)
    expect(modifiersOf(event('a', { altKey: true }))).toBe(1)
    expect(modifiersOf(event('a', { ctrlKey: true }))).toBe(2)
    expect(modifiersOf(event('a', { metaKey: true }))).toBe(4)
    expect(modifiersOf(event('a', { shiftKey: true }))).toBe(8)
    expect(modifiersOf(event('a', { ctrlKey: true, shiftKey: true }))).toBe(10)
  })
})
