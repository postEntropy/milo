import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileRecapStore, MemoryRecapStore } from '../src/core/sessions/recap.js'
import { rankSessions, withRecaps } from '../src/core/sessions/recall.js'
import type { SessionSummary } from '../src/core/sessions/types.js'
import { recallTool } from '../src/core/tools/recall.js'
import type { ToolContext } from '../src/core/tools/types.js'

function session(id: string, updatedAt: number, extra: Partial<SessionSummary> = {}): SessionSummary {
  // The name a row would show, by the rule the daemon composes it with.
  const label = extra.title ?? extra.preview ?? extra.recap ?? 'New session'
  return { id, createdAt: updatedAt, updatedAt, messageCount: 2, preview: '', label, ...extra }
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

  it('keeps the newer recap when an older one finishes last', async () => {
    const store = new FileRecapStore({ dir: mkdtempSync(path.join(tmpdir(), 'milo-recaps-')) })
    await store.write({ session: 'calm-otter-7', text: 'from the newer', sourceUpdatedAt: 20, at: 21 })

    // What a slower writer, digesting an older transcript, would land afterwards.
    await store.write({ session: 'calm-otter-7', text: 'from the older', sourceUpdatedAt: 10, at: 22 })

    expect((await store.read('calm-otter-7'))?.text).toBe('from the newer')
  })
})

describe('MemoryRecapStore', () => {
  it('keeps the newer recap when an older one finishes last', async () => {
    const store = new MemoryRecapStore()
    await store.write({ session: 'calm-otter-7', text: 'from the newer', sourceUpdatedAt: 20, at: 21 })
    await store.write({ session: 'calm-otter-7', text: 'from the older', sourceUpdatedAt: 10, at: 22 })

    expect((await store.read('calm-otter-7'))?.text).toBe('from the newer')
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

  it('names the routine a run belongs to, so the context is followed rather than searched again', async () => {
    const result = await recallTool.execute(
      { query: 'oauth' },
      {
        ...ctx,
        routine: {
          list: () => [
            {
              id: 'calm-otter-7',
              name: 'daily briefing',
              prompt: 'check the deploy',
              when: { kind: 'every', minutes: 60 },
              target: { gateway: 'none' },
              enabled: true,
              createdAt: 1,
            },
          ],
          create: async () => {
            throw new Error('not here')
          },
          update: async () => undefined,
          remove: async () => false,
        },
        recall: async () => [
          session('calm-otter-7', Date.now(), {
            recap: '- switched the auth flow to OAuth',
            scope: { gateway: 'routine', chatId: 'calm-otter-7' },
          }),
        ],
      },
    )

    expect(result.content).toContain('linked: routine calm-otter-7 (daily briefing)')
  })

  it('names the project and the jobs a session left behind', async () => {
    const jobs = {
      list: (sessionId?: string) =>
        sessionId === 'calm-otter-7'
          ? [
              {
                id: 'job_3',
                command: 'npm test',
                cwd: '/p',
                notify: 'auto' as const,
                origin: { gateway: 'cli' as const, chatId: 'main' },
                sessionId,
                state: 'done' as const,
                startedAt: 1,
                logPath: '/l',
                lines: [],
              },
            ]
          : [],
    }
    const result = await recallTool.execute(
      { query: 'oauth' },
      {
        ...ctx,
        jobs: jobs as unknown as ToolContext['jobs'],
        recall: async () => [
          session('calm-otter-7', Date.now(), {
            recap: '- switched the auth flow to OAuth',
            project: 'milo',
          }),
        ],
      },
    )

    expect(result.content).toContain('linked: project milo · jobs job_3 (done)')
  })

  it('says nothing about links when a session is tied to nothing', async () => {
    const result = await recallTool.execute(
      { query: 'oauth' },
      {
        ...ctx,
        recall: async () => [
          session('calm-otter-7', Date.now(), { recap: '- switched the auth flow to OAuth' }),
        ],
      },
    )

    expect(result.content).not.toContain('linked:')
  })

  it('fails cleanly with nowhere to recall from', async () => {
    const result = await recallTool.execute({ query: 'oauth' }, ctx)
    expect(result.isError).toBe(true)
  })
})
