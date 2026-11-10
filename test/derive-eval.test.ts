import { describe, expect, it } from 'vitest'
import { derivationCompleted, scoreDerivation, type DeriveCall, type DeriveCase } from './fixtures/derive-eval.js'

const scenario: DeriveCase = {
  id: 'name', category: 'keep', person: 'Call me Sam.', answer: 'Understood.',
  expected: [{ description: 'Preferred name Sam', patterns: ['\\bsam\\b'] }],
}

describe('the derive evaluation rubric', () => {
  it('counts an extra unrelated fact as a failure even when the expected fact is present', () => {
    const score = scoreDerivation(scenario, [{ text: 'Prefers the name Sam.' }, { text: 'Lives on Mars.' }])
    expect(score.missing).toEqual([])
    expect(score.unexpected).toEqual(['Lives on Mars.'])
    expect(score.passed).toBe(false)
  })

  it('does not count the same expected fact repeated twice as a complete pass', () => {
    expect(scoreDerivation(scenario, [{ text: 'Call me Sam.' }, { text: 'Call me Sam.' }]).passed).toBe(false)
  })

  it('requires an ignore case to save no facts', () => {
    const ignore = { ...scenario, expected: [] }
    expect(scoreDerivation(ignore, []).passed).toBe(true)
    expect(scoreDerivation(ignore, [{ text: 'Prefers the name Sam.' }]).passed).toBe(false)
  })

  it('reports the missing fact instead of accepting a partially matching name', () => {
    expect(scoreDerivation(scenario, [{ text: 'Prefers the name Samantha.' }]).missing)
      .toEqual(['Preferred name Sam'])
  })

  it('compares the rubric without case or accent differences', () => {
    const language = { ...scenario, expected: [{ description: 'Portuguese', patterns: ['portugues'] }] }
    expect(scoreDerivation(language, [{ text: 'Prefere PORTUGUÊS.' }]).passed).toBe(true)
  })
})

describe('completion of a live derive evaluation', () => {
  const complete: DeriveCall = { stage: 'extract', text: 'NONE', finishReason: 'stop', latencyMs: 1 }

  it('does not give an ignore case credit for a failed or unfinished request', () => {
    expect(derivationCompleted([])).toBe(false)
    expect(derivationCompleted([{ ...complete, finishReason: undefined }])).toBe(false)
    expect(derivationCompleted([{ ...complete, error: 'timeout' }])).toBe(false)
    expect(derivationCompleted([{ ...complete, finishReason: 'length' }])).toBe(false)
  })

  it('accepts a successful retry while retaining the failed attempt in the report', () => {
    expect(derivationCompleted([{ ...complete, error: 'unsupported effort hint' }, complete])).toBe(true)
  })

  it('distinguishes a reviewer abstaining from a reviewer returning an unreadable decision', () => {
    expect(derivationCompleted([complete, { ...complete, stage: 'review', text: 'NONE' }])).toBe(true)
    expect(derivationCompleted([complete, { ...complete, stage: 'review', text: 'unclear' }])).toBe(false)
    expect(derivationCompleted([complete, { ...complete, stage: 'review', text: 'KEEP 1\nHere is why' }])).toBe(false)
  })
})
