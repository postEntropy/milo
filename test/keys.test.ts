import { describe, expect, it } from 'vitest'
import {
  isCopyKey,
  isCtrlC,
  isExpandToolKey,
  isMouseToggleKey,
  isSteerKey,
} from '../src/gateways/cli/keys.js'

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

describe('isExpandToolKey', () => {
  it('recognises Ctrl+O from Ink or raw control byte', () => {
    expect(isExpandToolKey('o', { ctrl: true })).toBe(true)
    expect(isExpandToolKey('O', { ctrl: true })).toBe(true)
    expect(isExpandToolKey('\u000f', {})).toBe(true)
  })

  it('ignores plain o and other control combos', () => {
    expect(isExpandToolKey('o', {})).toBe(false)
    expect(isExpandToolKey('c', { ctrl: true })).toBe(false)
  })
})

describe('isMouseToggleKey', () => {
  it('recognises Ctrl+M from Ink or raw control byte when not Return', () => {
    expect(isMouseToggleKey('m', { ctrl: true })).toBe(true)
    expect(isMouseToggleKey('M', { ctrl: true })).toBe(true)
    expect(isMouseToggleKey('\u000d', {})).toBe(true)
  })

  it('ignores Return and plain m', () => {
    expect(isMouseToggleKey('', { return: true })).toBe(false)
    expect(isMouseToggleKey('\r', { return: true })).toBe(false)
    expect(isMouseToggleKey('', { ctrl: true, return: true })).toBe(false)
    expect(isMouseToggleKey('m', {})).toBe(false)
  })
})

describe('isCopyKey', () => {
  it('recognises Ctrl+Y from Ink or raw control byte', () => {
    expect(isCopyKey('y', { ctrl: true })).toBe(true)
    expect(isCopyKey('Y', { ctrl: true })).toBe(true)
    expect(isCopyKey('\u0019', {})).toBe(true)
  })

  it('ignores plain y and other control combos', () => {
    expect(isCopyKey('y', {})).toBe(false)
    expect(isCopyKey('o', { ctrl: true })).toBe(false)
  })
})
