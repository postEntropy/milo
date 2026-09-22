import { describe, expect, it } from 'vitest'
import { denialMessage, describeAccess, isAllowed, normalize } from '../src/gateways/access'

describe('isAllowed', () => {
  it('allows anyone when the list is empty or missing', () => {
    expect(isAllowed([], ['1'])).toBe(true)
    expect(isAllowed(undefined, ['1'])).toBe(true)
    expect(isAllowed(['  '], ['1'])).toBe(true)
  })

  it('fails closed for ids that are not listed', () => {
    expect(isAllowed(['42'], ['7'])).toBe(false)
    expect(isAllowed(['42'], [undefined])).toBe(false)
    expect(isAllowed(['42'], [])).toBe(false)
  })

  it('matches either the user id or the conversation id', () => {
    expect(isAllowed(['42'], [42, 99])).toBe(true)
    expect(isAllowed(['99'], [42, 99])).toBe(true)
    expect(isAllowed(['42'], ['42'])).toBe(true)
  })

  it('tolerates padding and blank entries', () => {
    expect(isAllowed([' 42 '], ['42'])).toBe(true)
    expect(isAllowed(['42', ''], ['7'])).toBe(false)
  })
})

describe('describeAccess', () => {
  it('summarises the state', () => {
    expect(describeAccess([])).toBe('anyone')
    expect(describeAccess(undefined)).toBe('anyone')
    expect(describeAccess(['1', '2'])).toBe('2 allowed')
    expect(describeAccess(['1', ' '])).toBe('1 allowed')
  })
})

describe('normalize', () => {
  it('trims and drops blanks', () => {
    expect([...normalize([' a ', '', '  '])]).toEqual(['a'])
  })
})

describe('denialMessage', () => {
  it('hands back the id so the owner can allow it', () => {
    expect(denialMessage('42')).toContain('42')
    expect(denialMessage(undefined)).toContain('unknown')
  })
})
