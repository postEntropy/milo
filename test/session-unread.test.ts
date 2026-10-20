import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SqliteMemory } from '../src/core/memory/sqlite.js'
import type { Provider } from '../src/core/providers/types.js'
import { AgentRuntime } from '../src/core/runtime.js'
import { FileSessionStore } from '../src/core/sessions/file-store.js'
import { formatSessionList } from '../src/core/sessions/format.js'
import { MemorySessionSeen } from '../src/core/sessions/seen.js'
import { createToolRegistry } from '../src/core/tools/index.js'

const baseProvider: Provider = {
  id: 'stub',
  async *stream() {
    yield { type: 'text', delta: 'ok' }
    yield { type: 'done', finishReason: 'stop' }
  },
}

/** A provider that thinks for a moment, so a turn's end is a later instant than its start. */
const slowProvider: Provider = {
  id: 'slow',
  async *stream() {
    await new Promise((resolve) => setTimeout(resolve, 20))
    yield { type: 'text', delta: 'ok' }
    yield { type: 'done', finishReason: 'stop' }
  },
}

/** A runtime over a throwaway install, with the watermark held in memory. */
function setup(provider: Provider = baseProvider) {
  const dir = mkdtempSync(path.join(tmpdir(), 'milo-unread-'))
  const store = new FileSessionStore({ dir: path.join(dir, 'sessions') })
  const seen = new MemorySessionSeen()
  const runtime = new AgentRuntime({
    provider,
    model: 'test-model',
    system: 'BASE',
    registry: createToolRegistry(),
    memory: new SqliteMemory({ dir: path.join(dir, 'memory') }),
    cwd: dir,
    store,
    seen,
  })
  return { runtime, store, seen }
}

/** A session already spoken in, written the way a turn would have left it. */
async function spoken(store: FileSessionStore, text: string) {
  const record = await store.create()
  record.messages.push({ role: 'user', content: [{ type: 'text', text }] })
  await store.save(record, record.version)
  return record.id
}

describe('session unread marks', () => {
  it('records where the history stands instead of lighting all of it up', async () => {
    const { runtime, store } = setup()
    await spoken(store, 'one')
    await spoken(store, 'two')

    const listed = await runtime.listSessions()

    expect(listed).toHaveLength(2)
    expect(listed.every((session) => session.unread === undefined)).toBe(true)
  })

  it('marks a session that moved after the last look at it', async () => {
    const { runtime, store } = setup()
    const id = await spoken(store, 'one')
    // The first listing is the baseline.
    await runtime.listSessions()

    const record = await store.load(id)
    await store.save({ ...record!, updatedAt: record!.updatedAt + 60_000 }, record!.version)

    expect((await runtime.listSessions()).find((session) => session.id === id)?.unread).toBe(true)
  })

  it('clears the mark once the session is looked at again', async () => {
    const { runtime, store, seen } = setup()
    const id = await spoken(store, 'one')
    await runtime.listSessions()

    const record = await store.load(id)
    const moved = record!.updatedAt + 60_000
    await store.save({ ...record!, updatedAt: moved }, record!.version)
    expect((await runtime.listSessions()).find((session) => session.id === id)?.unread).toBe(true)

    seen.mark(id, moved + 1)

    expect((await runtime.listSessions()).find((session) => session.id === id)?.unread).toBeUndefined()
  })

  it('records a look for the surface that showed the session', async () => {
    const { runtime, store, seen } = setup()
    const id = await spoken(store, 'one')

    runtime.markSessionSeen(id)

    expect(typeof seen.all().get(id)).toBe('number')
  })

  it('marks a session that moved after its birth, even before it was ever opened', async () => {
    const { runtime, store } = setup()
    // A session minted for a delivery: nobody is at a screen when it is made.
    const session = await runtime.getSession({ gateway: 'web', chatId: 'routine-target' })
    const record = await store.load(session.id)
    await store.save({ ...record!, updatedAt: record!.updatedAt + 60_000 }, record!.version)

    expect((await runtime.listSessions()).find((row) => row.id === session.id)?.unread).toBe(true)
  })

  it('gives the rest of the history a line when a look was written before its first listing', async () => {
    const { runtime, store, seen } = setup()
    const early = await spoken(store, 'early')
    const late = await spoken(store, 'late')
    // The first look can arrive before any listing — a session opened, a turn run —
    // and it must not leave the rest of the history without a line to move from.
    seen.mark(early)

    const listed = await runtime.listSessions()

    expect(listed.every((session) => session.unread === undefined)).toBe(true)
    expect(seen.all().has(late)).toBe(true)
  })

  it('leaves a web turn unread unless a screen says it was read', async () => {
    // The browser and the phone use this gateway, and their answer can land after the
    // person has left the chat: the daemon marks the turn's start, not its end.
    const { runtime, store, seen } = setup(slowProvider)
    const session = await runtime.getSession({ gateway: 'web', chatId: 'open-chat' })

    for await (const _event of session.send('oi')) {
      // drain
    }

    const record = await store.load(session.id)
    expect(seen.all().get(session.id)).toBeLessThan(record!.updatedAt)
    expect((await runtime.listSessions()).find((row) => row.id === session.id)?.unread).toBe(true)
  })

  it('marks the session a turn ran in, because that turn was being shown', async () => {
    const { runtime, store, seen } = setup()
    const session = await runtime.getSession({ gateway: 'cli', chatId: 'main' })

    for await (const _event of session.send('hello')) {
      // drain
    }

    // A terminal hands the answer over whole, so the end of its turn is a look too.
    const record = await store.load(session.id)
    expect(seen.all().get(session.id)).toBeGreaterThanOrEqual(record!.updatedAt)
  })

  it('drops the mark with the session itself', async () => {
    const { runtime, store, seen } = setup()
    const id = await spoken(store, 'one')
    runtime.markSessionSeen(id)

    expect(await runtime.removeSession(id)).toBe(true)

    expect(seen.all().has(id)).toBe(false)
  })

  it('leads the listing with the mark, plain and in Markdown', () => {
    const summary = {
      id: 'calm-otter-7',
      title: 'Deploys',
      createdAt: 1,
      updatedAt: 2,
      messageCount: 2,
      preview: '',
      unread: true,
    }

    expect(formatSessionList([summary])).toContain('● calm-otter-7')
    expect(formatSessionList([summary], { markdown: true })).toContain('● **calm-otter-7')
  })
})
