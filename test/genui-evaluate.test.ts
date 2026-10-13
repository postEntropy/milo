import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { evaluateFormula, formatNumber, interpolate } from '../web/src/chat/genui/evaluate.js'

/**
 * The cases both the browser and the phone evaluate.
 *
 * The formula engine exists twice — `evaluate.ts` here and `MiloGenUi` in
 * `ios/GenUi` — because the two surfaces have no runtime in common. The cases
 * live in one file, as data, so a divergence has to fail a build on one side
 * rather than show up as a wrong number on the other.
 */
interface FormulaCase {
  name: string
  formula: string
  values: Record<string, number | string | boolean>
  expected: number | null
}
interface TemplateCase {
  name: string
  text: string
  values: Record<string, number | string | boolean>
  expected: string
}
const fixtures: { formula: FormulaCase[]; template: TemplateCase[] } = JSON.parse(
  readFileSync(new URL('./fixtures/genui-evaluate.json', import.meta.url), 'utf8'),
)

describe('a widget formula', () => {
  for (const testCase of fixtures.formula) {
    it(testCase.name, () => {
      expect(evaluateFormula(testCase.formula, testCase.values)).toBe(testCase.expected)
    })
  }
})

describe('a widget template', () => {
  for (const testCase of fixtures.template) {
    it(testCase.name, () => {
      expect(interpolate(testCase.text, testCase.values)).toBe(testCase.expected)
    })
  }
})

describe('a number as the widget shows it', () => {
  it('keeps a whole number whole, and the rest at the places asked for', () => {
    expect(formatNumber(232)).toBe('232')
    expect(formatNumber(12.345)).toMatch(/^12[.,]35$/)
    expect(formatNumber(12.345, 0)).toBe('12')
  })
})
