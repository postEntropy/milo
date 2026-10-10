import { describe, expect, it } from 'vitest'
import { evaluateFormula, formatNumber, interpolate } from '../web/src/chat/genui/evaluate.js'

describe('a widget formula', () => {
  it('computes arithmetic over the inputs', () => {
    expect(evaluateFormula('seats * 29', { seats: 8 })).toBe(232)
  })

  it('respects precedence, parentheses and a leading sign', () => {
    expect(evaluateFormula('2 + 3 * 4', {})).toBe(14)
    expect(evaluateFormula('(2 + 3) * 4', {})).toBe(20)
    expect(evaluateFormula('-3 + 10', {})).toBe(7)
  })

  it('counts a checkbox as one or zero', () => {
    expect(evaluateFormula('base * extra', { base: 10, extra: true })).toBe(10)
    expect(evaluateFormula('base * extra', { base: 10, extra: false })).toBe(0)
  })

  it('refuses anything that is not arithmetic', () => {
    expect(evaluateFormula('fetch("/etc/passwd")', {})).toBeNull()
    expect(evaluateFormula('a.b', {})).toBeNull()
    expect(evaluateFormula('1 +', {})).toBeNull()
    expect(evaluateFormula('(1 + 2', {})).toBeNull()
    expect(evaluateFormula('1/0', {})).toBeNull()
  })

  it('is null when an id is missing or is not a number', () => {
    expect(evaluateFormula('seats * 29', { seats: 'many' })).toBeNull()
    expect(evaluateFormula('seats * 29', {})).toBeNull()
  })
})

describe('a widget template', () => {
  it('fills {id} from the current values', () => {
    expect(interpolate('{seats} seats at $29 each', { seats: 8 })).toBe('8 seats at $29 each')
  })

  it('leaves a reference to nothing alone, and says a checkbox in words', () => {
    expect(interpolate('{nope} seats', {})).toBe('{nope} seats')
    expect(interpolate('extra: {extra}', { extra: true })).toBe('extra: true')
  })

  it('renders a number the way the widget shows it', () => {
    expect(interpolate('{total}', { total: 12.5 })).toMatch(/^12[.,]50$/)
  })
})

describe('a number as the widget shows it', () => {
  it('keeps a whole number whole, and the rest at the places asked for', () => {
    expect(formatNumber(232)).toBe('232')
    expect(formatNumber(12.345)).toMatch(/^12[.,]35$/)
    expect(formatNumber(12.345, 0)).toBe('12')
  })
})
