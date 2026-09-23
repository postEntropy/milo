import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileRecapStore, MemoryRecapStore } from '../src/core/sessions/recap.js'
import { rankSessions, withRecaps } from '../src/core/sessions/recall.js'
import type { SessionSummary } from '../src/core/sessions/types.js'
import { recallTool } from '../src/core/tools/recall.js'

function session(id: string, updatedAt: number, extra: Partial<SessionSummary> = {}): SessionSummary {
  return { id, createdAt: updatedAt, updatedAt, messageCount: 2, preview: '', ...extra }
}

describe('rankSessions', () => {
  it('brings back the sessions a question is about, best first', () => {
    const auth = session('calm-otter-7', Date.now(), {
      recap: '- switched the auth flow to OAuth\n- dropped the session cookie',
    })
    const other = session('brave-fox-2', Date.now(), {
      recap: '- styled the settings screen',
    })

    const hits = rankSessions([other, auth], 'the oauth thing')
    expect(hits.map((hit) => hit.id)).toEqual(['calm-otter-7'])
  })

  it('does not answer with whatever was said most recently', () => {
    const recent = session('calm-otter-7', Date.now())
    expect(rankSessions([recent], 'quantum chromodynamics')).toEqual([])
  })

  it('sees the words the user actually typed, not only the recap', () => {
    const one = session('calm-otter-7', Date.now(), { preview: 'fix the flaky checkout test' })
    expect(rankSessions([one], 'flaky checkout').map((hit) => hit.id)).toEqual(['calm-otter-7'])
  })

  it('keeps to the limit', () => {
    const many = Array.from({ length: 10 }, (_, index) =>
      session(`calm-otter-${index}`, Date.now(), { recap: 'auth work' }),
    )
    expect(rankSessions(many, 'auth', 3)).toHaveLength(3)
  })
})

describe('withRecaps', () => {
  it('shows a recap that matches the transcript it was written from', async () => {
    const recaps = new MemoryRecapStore()
    await recaps.write({ session: 'calm-otter-7', text: '- one', sourceUpdatedAt: 10, at: 20 })

    const [shown] = await withRecaps([session('calm-otter-7', 10)], recaps)
    expect(shown?.recap).toBe('- one')
  })

  it('hides a recap left behind by an older transcript', async () => {
    const recaps = new MemoryRecapStore()
    await recaps.write({ session: 'calm-otter-7', text: '- one', sourceUpdatedAt: 10, at: 20 })

    const [stale] = await withRecaps([session('calm-otter-7', 99)], recaps)
    expect(stale?.recap).toBeUndefined()
  })
})

describe('FileRecapStore', () => {
  it('round-trips a recap and forgets it on request', async () => {
    const store = new FileRecapStore({ dir: mkdtempSync(path.join(tmpdir(), 'milo-recaps-')) })
    await store.write({ session: 'calm-otter-7', text: '- one', sourceUpdatedAt: 1, at: 2 })

    expect(await store.read('calm-otter-7')).toMatchObject({ text: '- one', sourceUpdatedAt: 1 })
    await store.remove('calm-otter-7')
    expect(await store.read('calm-otter-7')).toBeNull()
  })

  it('treats a missing recap as simply absent', async () => {
    const store = new FileRecapStore({ dir: mkdtempSync(path.join(tmpdir(), 'milo-recaps-')) })
    expect(await store.read('calm-otter-7')).toBeNull()
  })
})

describe('recall', () => {
  const ctx = { cwd: process.cwd(), signal: new AbortController().signal }

  it('returns the sessions a question is about', async () => {
    const result = await recallTool.execute(
      { query: 'oauth' },
      {
        ...ctx,
        recall: async () => [
          session('calm-otter-7', Date.now(), { recap: '- switched the auth flow to OAuth' }),
        ],
      },
    )

    expect(result.content).toContain('calm-otter-7')
    expect(result.content).toContain('OAuth')
  })

  it('points at search_history when nothing matches', async () => {
    const result = await recallTool.execute({ query: 'oauth' }, { ...ctx, recall: async () => [] })
    expect(result.content).toContain('search_history')
  })

  it('fails cleanly with nowhere to recall from', async () => {
    const result = await recallTool.execute({ query: 'oauth' }, ctx)
    expect(result.isError).toBe(true)
  })
})
