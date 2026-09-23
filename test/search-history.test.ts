import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { HistoryEntry } from '../src/core/history.js'
import type { ToolContext } from '../src/core/tools/types.js'

// Point the log somewhere throwaway *before* the path module is loaded.
const home = mkdtempSync(path.join(tmpdir(), 'milo-search-history-'))
process.env.MILO_HOME = home

const { fileHistory } = await import('../src/core/history.js')
const { searchHistoryTool } = await import('../src/core/tools/search-history.js')
const { FileMemory } = await import('../src/core/memory/local.js')
const { Session } = await import('../src/core/session.js')
const { MemorySessionStore } = await import('../src/core/sessions/memory-store.js')
const { createToolRegistry } = await import('../src/core/tools/index.js')
type Provider = import('../src/core/providers/types.js').Provider
type StreamEvent = import('../src/core/providers/types.js').StreamEvent

const ctx: ToolContext = { cwd: process.cwd(), signal: new AbortController().signal }

const entry = (over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  at: '2026-09-22T21:00:00.000Z',
  session: 'calm-otter-7',
  scope: 'cli:main',
  kind: 'user',
  text: 'hello',
  ...over,
})

beforeEach(() => {
  rmSync(path.join(home, 'history'), { recursive: true, force: true })
})

describe('search_history', () => {
  it('is read-only, and hands back what a past turn said', async () => {
    fileHistory.append([
      entry({ text: 'how do I test the fetch tool against a real server?' }),
    ])

    const result = await searchHistoryTool.execute({ query: 'fetch tool' }, ctx)

    expect(searchHistoryTool.readOnly).toBe(true)
    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('how do I test the fetch tool against a real server?')
    expect(result.content).toContain('cli:main')
    expect(result.content).toContain('calm-otter-7')
  })

  it('shows the tool a turn ran, and that it failed', async () => {
    fileHistory.append([
      entry({
        at: '2026-09-22T21:30:00.000Z',
        kind: 'tool',
        tool: {
          name: 'fetch_url',
          args: { url: 'https://github.com/private/repo' },
          result: 'Fetch failed for https://github.com/private/repo: 404 Not Found',
          isError: true,
        },
      }),
    ])

    const result = await searchHistoryTool.execute({ query: 'private repo' }, ctx)

    expect(result.content).toContain('fetch_url (failed)')
    expect(result.content).toContain('404')
  })

  it('includes the reasoning behind an answer', async () => {
    fileHistory.append([
      entry({
        at: '2026-09-22T22:00:00.000Z',
        kind: 'assistant',
        text: 'the repo is private',
        reasoning: 'a 404 from GitHub hides a private repository',
      }),
    ])

    const result = await searchHistoryTool.execute({ query: 'hides a private' }, ctx)

    expect(result.content).toContain('assistant: the repo is private')
    expect(result.content).toContain('thought: a 404 from GitHub hides a private repository')
  })

  it('says so when nothing matches', async () => {
    const result = await searchHistoryTool.execute({ query: 'nothing at all' }, ctx)

    expect(result.content).toContain('Nothing in the history matches "nothing at all"')
  })

  it('finds a turn that a session logged, end to end', async () => {
    const store = new MemorySessionStore()
    const record = await store.create()
    const provider: Provider = {
      id: 'stub',
      async *stream(): AsyncGenerator<StreamEvent> {
        yield { type: 'reasoning', delta: 'the user is asking about the migration' }
        yield { type: 'text', delta: 'we renamed the column last week' }
        yield { type: 'done', finishReason: 'stop' }
      },
    }

    const session = new Session({
      scope: { gateway: 'cli', conversationId: 'e2e' },
      provider,
      model: 'test-model',
      system: 'BASE',
      registry: createToolRegistry(),
      memory: new FileMemory({ dir: mkdtempSync(path.join(tmpdir(), 'milo-e2e-')) }),
      cwd: process.cwd(),
      record,
      store,
      history: fileHistory,
    })
    for await (const _event of session.send('what did we rename?')) {
      // drain
    }

    const result = await searchHistoryTool.execute({ query: 'renamed the column' }, ctx)

    expect(result.content).toContain('renamed the column last week')
    expect(result.content).toContain(session.id)
    // The thought is searchable too, not just what was said out loud.
    expect(result.content).toContain('migration')
  })

  it('stops at the limit and says there is more', async () => {
    fileHistory.append([
      entry({ at: '2026-09-22T21:00:00.000Z', text: 'repeated thing' }),
      entry({ at: '2026-09-22T21:01:00.000Z', text: 'repeated thing again' }),
    ])

    const result = await searchHistoryTool.execute({ query: 'repeated', limit: 1 }, ctx)

    expect(result.content).toContain('2026-09-22 21:01')
    expect(result.content).not.toContain('21:00')
    expect(result.content).toContain('more match(es) than shown')
  })
})
