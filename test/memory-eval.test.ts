import { describe, expect, it } from 'vitest'
import { INSTALL_SCOPE } from '../src/core/memory/types.js'
import { NOTES, runEval, seedEvalStore } from './fixtures/memory-eval.js'

/**
 * The eval set as a floor, so a change that makes recall worse fails here
 * instead of shipping.
 *
 * Keyword-only, on purpose: no embedder, no engine, no network, so it measures
 * the same thing on every machine. The semantic half is measured by
 * `npm run eval:memory -- --semantic` against the real engine — a fake embedder
 * standing in for it would only be measuring the fake — and until that run
 * happens, the semantic numbers are unproven rather than passing.
 *
 * Every floor sits under the number that was measured, not on it: a floor set
 * at the value it was measured on fails the first time a machine rounds
 * differently, and a test that fails for that reason gets deleted rather than
 * fixed.
 *
 * The `REWORDED` axis — the same notes asked in other words — is deliberately
 * not asserted anywhere below. A word store scores near zero on it by design and
 * an embedder is what moves it, so the difference only exists with a model; a
 * test that needs the network is not a floor anything can stand on. It is scored
 * by `npm run eval:memory` and printed there, which is where it belongs.
 */
async function evaluate(coverage: boolean) {
  const seeded = await seedEvalStore({ memory: { coverage } })
  // A `sameFact` collapse would silently shrink the set and every floor below
  // would then be measured against notes that are not there.
  expect(seeded.facts).toBe(NOTES.length)

  try {
    return await runEval((query, limit) => seeded.memory.recall(INSTALL_SCOPE, query, { limit }))
  } finally {
    seeded.close()
  }
}

describe('recall quality', () => {
  it('finds the note that answers, and answers nothing when nothing does', async () => {
    const metrics = await evaluate(true)

    expect(metrics.recall).toBeGreaterThanOrEqual(0.95)
    expect(metrics.mrr).toBeGreaterThanOrEqual(0.9)
    expect(metrics.precision).toBeGreaterThanOrEqual(0.7)
    // A question with no answer in the store must come back empty. A note
    // returned anyway is a line of every prompt spent on something the person
    // never told it — and the model has to read past it to notice.
    expect(metrics.falsePositiveRate).toBe(0)
  })

  it('keeps the reply to the notes that carry the question, without losing the answer', async () => {
    const [plain, trimmed] = [await evaluate(false), await evaluate(true)]

    // Trimming the tail must never cost the note that was the answer.
    expect(trimmed.recall).toBeGreaterThanOrEqual(plain.recall)
    // And the tail is the whole point: the reply is mostly notes that answer.
    expect(trimmed.precision).toBeGreaterThan(plain.precision + 0.1)
  })

  it('stays in the time a recall is allowed to spend', async () => {
    const metrics = await evaluate(true)

    // Recall runs before every turn, so the budget is a millisecond and this is
    // the guard that a future signal does not quietly spend it.
    expect(metrics.latencyMs).toBeLessThan(2)
  })
})
