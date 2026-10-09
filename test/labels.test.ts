import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = mkdtempSync(path.join(os.tmpdir(), 'milo-labels-'))
process.env.MILO_HOME = home

const {
  BASE_LABELS,
  LABEL_COLORS,
  carryingLabel,
  createLabel,
  deleteLabel,
  labelMessages,
  listLabels,
  resolveLabel,
  toggleAssignment,
} = await import('../src/core/google/labels.js')

/** A page of mail as the Gmail client hands it up: only the fields a person sorts by. */
const mail = (id: string, subject = 'a note') => ({ id, threadId: `t-${id}`, from: 'ana@exemplo', subject, snippet: 'the gist' })

/** A stand-in for the decision model: one answer per message id, and how many calls it took. */
function fakeClassifier(answers: Record<string, { choice: string; confidence?: number }>) {
  const calls: string[] = []
  return {
    calls,
    ask: async (state: string) => {
      calls.push(state)
      return answers
    },
  }
}

const IDs = (labels: unknown): string[] => (labels as { id: string }[]).map((label) => label.id)

afterEach(() => {
  rmSync(path.join(home, 'labels.json'), { force: true })
})

describe('mail labels', () => {
  it('adds a person’s own label from the palette, and refuses what it cannot take', async () => {
    const created = await createLabel('Invoices', 'teal')
    expect(created.ok).toBe(true)
    expect(created.ok && created.labels).toEqual([
      expect.objectContaining({ name: 'Invoices', color: 'teal' }),
    ])

    const bad = await createLabel('Loud', 'chartreuse')
    expect(bad).toEqual({ ok: false, error: expect.stringContaining('terracotta') })
    expect(await createLabel('Invoices', 'sky')).toEqual({ ok: false, error: expect.stringContaining('already exists') })
    expect(await createLabel('   ', 'sky')).toEqual({ ok: false, error: expect.stringContaining('needs a name') })
  })

  it('deletes a label and refuses an id it does not know', async () => {
    const created = await createLabel('Invoices', 'teal')
    const id = created.ok ? created.labels[0]!.id : ''
    const deleted = await deleteLabel(id)
    expect(deleted.ok).toBe(true)
    expect(deleted.ok && deleted.labels).toEqual([])
    expect(await deleteLabel(id)).toEqual({ ok: false, error: expect.stringContaining('No label') })
  })

  it('every base label wears a colour from the palette', () => {
    expect(LABEL_COLORS).toHaveLength(8)
    for (const base of BASE_LABELS) expect(LABEL_COLORS).toContain(base.color)
  })

  it('lists what the install knows, and resolves one by name or id', async () => {
    const created = await createLabel('Invoices', 'teal')
    const id = created.ok ? created.labels[0]!.id : ''

    expect(listLabels()).toEqual([expect.objectContaining({ name: 'Invoices', color: 'teal' })])
    expect(resolveLabel('invoices')).toMatchObject({ id })
    expect(resolveLabel(id)).toMatchObject({ name: 'Invoices' })
    expect(resolveLabel('nothing')).toBeUndefined()
  })
})

describe('sorting mail into labels', () => {
  it('materialises the base label a message falls into, and remembers the assignment', async () => {
    const classifier = fakeClassifier({ m1: { choice: 'receipt', confidence: 0.9 } })
    const first = await labelMessages(classifier, [mail('m1')])

    expect(first.byMessage.get('m1')).toEqual([expect.objectContaining({ id: 'receipt', name: 'Receipts', color: 'sage' })])
    expect(IDs(first.labels)).toContain('receipt')

    // The assignment is on disk, so a second read asks the model nothing.
    const second = await labelMessages(classifier, [mail('m1')])
    expect(second.byMessage.get('m1')).toEqual([expect.objectContaining({ id: 'receipt' })])
    expect(classifier.calls).toHaveLength(1)
  })

  it('leaves a message that fits nothing unlabelled, and does not ask again', async () => {
    const classifier = fakeClassifier({ m1: { choice: 'none', confidence: 0.99 } })
    expect((await labelMessages(classifier, [mail('m1')])).byMessage.get('m1')).toEqual([])
    await labelMessages(classifier, [mail('m1')])
    expect(classifier.calls).toHaveLength(1)
  })

  it('keeps a choice only when the model is sure enough of it', async () => {
    const unsure = fakeClassifier({ m1: { choice: 'newsletter', confidence: 0.2 } })
    expect((await labelMessages(unsure, [mail('m1')])).byMessage.get('m1')).toEqual([])
  })

  it('reads the inbox even when the classifier fails', async () => {
    const broken = { ask: async () => { throw new Error('classifier review timed out') } }
    const result = await labelMessages(broken, [mail('m1')])
    expect(result.byMessage.get('m1')).toEqual([])
    expect(result.labels).toEqual([])
  })

  it('never recreates a base label the person deleted', async () => {
    const classifier = fakeClassifier({ m1: { choice: 'receipt', confidence: 0.9 } })
    await labelMessages(classifier, [mail('m1')])
    expect(await deleteLabel('receipt')).toMatchObject({ ok: true })

    // Hidden now: a fresh message the model still calls a receipt stays unlabelled,
    // and the label is not made again.
    const again = fakeClassifier({ m2: { choice: 'receipt', confidence: 0.9 } })
    const result = await labelMessages(again, [mail('m2')])
    expect(result.byMessage.get('m2')).toEqual([])
    expect(IDs(result.labels)).not.toContain('receipt')
  })

  it('answers which of a page’s messages carry a label', async () => {
    const classifier = fakeClassifier({
      m1: { choice: 'receipt', confidence: 0.9 },
      m2: { choice: 'newsletter', confidence: 0.9 },
    })
    const { byMessage } = await labelMessages(classifier, [mail('m1'), mail('m2')])
    const page = [mail('m1'), mail('m2')].map((message) => ({ ...message, labels: byMessage.get(message.id) ?? [] }))

    expect(carryingLabel(page, 'receipt').map((message) => message.id)).toEqual(['m1'])
    expect(carryingLabel(page, 'newsletter').map((message) => message.id)).toEqual(['m2'])
    // No label asked for: the page comes back whole, so a caller can pass its filter through.
    expect(carryingLabel(page).map((message) => message.id)).toEqual(['m1', 'm2'])
    expect(carryingLabel(page, 'nope')).toEqual([])
  })

  it('writes what it decided to the store, not just to memory', async () => {
    const classifier = fakeClassifier({ m1: { choice: 'calendar', confidence: 0.8 } })
    await labelMessages(classifier, [mail('m1')])
    const store = JSON.parse(readFileSync(path.join(home, 'labels.json'), 'utf8'))
    expect(store.assignments.m1.labels).toEqual(['calendar'])
    expect(IDs(store.labels)).toContain('calendar')
  })

  it('sorts a page in bounded batches, so no single request carries the whole page', async () => {
    const page = Array.from({ length: 23 }, (_, index) => mail(`m${index}`))
    const answers = Object.fromEntries(page.map((message) => [message.id, { choice: 'newsletter', confidence: 0.9 }]))
    const classifier = fakeClassifier(answers)

    const { byMessage } = await labelMessages(classifier, page)

    // 23 messages at ten to a call: three calls, and the last one still sorted.
    expect(classifier.calls).toHaveLength(3)
    expect(byMessage.get('m22')).toEqual([expect.objectContaining({ id: 'newsletter', name: 'Newsletters' })])
  })

  it('keeps the batches that sorted when one of them fails', async () => {
    const page = Array.from({ length: 12 }, (_, index) => mail(`m${index}`))
    let call = 0
    const classifier = {
      ask: async () => {
        call += 1
        if (call === 1) throw new Error('classifier review timed out')
        return Object.fromEntries(page.map((message) => [message.id, { choice: 'receipt', confidence: 0.9 }]))
      },
    }

    const { byMessage } = await labelMessages(classifier, page)

    // The first batch (ten) failed and stays unlabelled; the second (two) still sorted.
    expect(byMessage.get('m0')).toEqual([])
    expect(byMessage.get('m11')).toEqual([expect.objectContaining({ id: 'receipt' })])
  })
})

describe('putting a label on by hand', () => {
  const assigned = (): string[] => JSON.parse(readFileSync(path.join(home, 'labels.json'), 'utf8')).assignments.m1.labels

  it('adds and removes one, and refuses a label it does not know', async () => {
    const made = await createLabel('Invoices', 'teal')
    const id = made.ok ? made.labels[0]!.id : ''

    expect(await toggleAssignment('m1', id, true)).toMatchObject({ ok: true })
    expect(assigned()).toEqual([id])
    expect(await toggleAssignment('m1', id, false)).toMatchObject({ ok: true })
    expect(assigned()).toEqual([])
    expect(await toggleAssignment('m1', 'nope', true)).toEqual({ ok: false, error: expect.stringContaining('No label') })
  })

  it('keeps a hand removal from being undone by the next sort', async () => {
    const classifier = fakeClassifier({ m1: { choice: 'receipt', confidence: 0.9 } })
    await labelMessages(classifier, [mail('m1')])
    await toggleAssignment('m1', 'receipt', false)

    // The message was decided (now empty), so sorting reads it as done and asks nothing.
    const again = fakeClassifier({ m1: { choice: 'receipt', confidence: 0.9 } })
    expect((await labelMessages(again, [mail('m1')])).byMessage.get('m1')).toEqual([])
    expect(again.calls).toHaveLength(0)
  })
})
