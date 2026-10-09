import { describe, expect, it } from 'vitest'
import { keyStroke } from '../src/core/browser/keys.js'

describe('keyStroke', () => {
  it('names a known key with its physical code and virtual key code', () => {
    expect(keyStroke('Enter', 0)).toEqual({
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      modifiers: 0,
      text: '\r',
    })
  })

  it('derives a letter’s code from the character, so a shortcut is recognised', () => {
    expect(keyStroke('a', 2)).toEqual({
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
      modifiers: 2,
    })
  })

  it('derives a digit’s code the same way', () => {
    expect(keyStroke('7', 0)).toMatchObject({ code: 'Digit7', windowsVirtualKeyCode: 55 })
  })

  it('inserts no literal text when a modifier makes the key a shortcut', () => {
    expect(keyStroke('Enter', 8)).not.toHaveProperty('text')
    expect(keyStroke('Space', 2)).not.toHaveProperty('text')
  })

  it('falls back to the key itself for one it does not name', () => {
    expect(keyStroke('F5', 0)).toMatchObject({ key: 'F5', code: 'F5', windowsVirtualKeyCode: 0 })
  })
})
