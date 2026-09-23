import { describe, expect, it } from 'vitest'
import { isCtrlC, isSteerKey } from '../src/gateways/cli/keys.js'

describe('isCtrlC', () => {
  it('recognises the raw control character', () => {
    expect(isCtrlC('\u0003', {})).toBe(true)
  })

  it('recognises ctrl+c when Ink normalises it', () => {
    expect(isCtrlC('c', { ctrl: true })).toBe(true)
    expect(isCtrlC('C', { ctrl: true })).toBe(true)
  })

  it('ignores a plain c', () => {
    expect(isCtrlC('c', {})).toBe(false)
    expect(isCtrlC('C', {})).toBe(false)
  })

  it('ignores other control combos', () => {
    expect(isCtrlC('d', { ctrl: true })).toBe(false)
  })
})

describe('isSteerKey', () => {
  it('recognises the Ctrl modifier the kitty protocol reports', () => {
    expect(isSteerKey({ ctrl: true })).toBe(true)
  })

  it('recognises alt+enter, the modifier a plain terminal can send', () => {
    expect(isSteerKey({ meta: true })).toBe(true)
  })

  it('leaves a bare return alone, so it queues', () => {
    expect(isSteerKey({})).toBe(false)
  })
})
