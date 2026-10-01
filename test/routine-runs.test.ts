import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Provider, StreamEvent } from '../src/core/providers/types.js'
import type { Routine } from '../src/core/routines.js'

// Point the install somewhere throwaway *before* the path module is loaded.
const home = mkdtempSync(path.join(tmpdir(), 'milo-routine-runs-'))
process.env.MILO_HOME = home

const { MAX_RUNS_PER_ROUTINE, ROUTINE_GATEWAY, addRoutine, removeRoutineWithRuns, runRoutineOnce } =
  await import('../src/core/routines.js')
const { AgentRuntime } = await import('../src/core/runtime.js')
const { FileSessionStore } = await import('../src/core/sessions/file-store.js')
const { MemoryRecapStore } = await import('../src/core/sessions/recap.js')
const { pruneSessions } = await import('../src/core/sessions/retention.js')

const CONVERSATION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
})

/** The provider every run here answers with: one word, then done. */
const provider: Provider = {
  id: 'stub',
  async *stream(): AsyncGenerator<StreamEvent> {
    yield { type: 'text', delta: 'ok' }
    yield { type: 'done', finishReason: 'stop' }
  },
}

/**
 * A runtime over a real file store whose clock moves on every write, so runs
 * made in the same millisecond still order by when they happened.
 */
function build(dir: string) {
  let clock = Date.UTC(2026, 8, 25, 8, 0, 0)
  const store = new FileSessionStore({ dir: path.join(dir, 'sessions'), now: () => (clock += 1000) })
  const recaps = new MemoryRecapStore()
  const runtime = new AgentRuntime({
    provider,
    model: 'test-model',
    system: '',
    registry: { specs: () => [] } as never,
    memory: { remember: async () => undefined, recall: async () => [], list: async () => [], forget: async () => false } as never,
    cwd: dir,
    store,
    recaps,
  })
  return { runtime, store, recaps }
}

function routine(id: string): Routine {
  return {
    id,
    name: 'daily briefing',
    prompt: 'look at the repo',
    when: { kind: 'every', minutes: 60 },
    target: { gateway: 'web', conversationId: CONVERSATION },
    enabled: true,
    createdAt: Date.UTC(2026, 8, 25),
  }
}

describe('a routine run is a session of its own', () => {
  it('records the run under the routine, and keeps it out of the conversation list', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milo-runs-'))
    const { runtime } = build(dir)
    const r = routine('brave-otter-1')

    const result = await runRoutineOnce(runtime, r)

    expect(result.id).toBeTruthy()
    // The record on disk says whose run it is, which is what survives the next
    // run replacing the binding.
    expect((await runtime.loadSession(result.id!))?.scope).toEqual({ gateway: ROUTINE_GATEWAY, conversationId: r.id })
    expect((await runtime.listRuns(r.id)).map((run) => run.id)).toEqual([result.id])
    // Nobody talks in a run, so it is not offered as a conversation to open.
    expect(await runtime.listSessions()).toEqual([])
  })

  it('lists a routine its own runs, newest first, and no one else’s', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milo-runs-'))
    const { runtime } = build(dir)
    const mine = routine('brave-otter-1')
    const other = routine('calm-badger-2')

    const first = await runRoutineOnce(runtime, mine)
    const second = await runRoutineOnce(runtime, mine)
    await runRoutineOnce(runtime, other)

    expect((await runtime.listRuns(mine.id)).map((run) => run.id)).toEqual([second.id, first.id])
    expect((await runtime.listRuns(other.id)).map((run) => run.id).length).toBe(1)
    // Both routines' runs are sessions on disk; the shared list still shows none.
    expect(await runtime.listSessions()).toEqual([])
  })

  it('keeps only the last runs of a routine, so the history cannot grow forever', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milo-runs-'))
    const { runtime } = build(dir)
    const r = routine('brave-otter-1')

    for (let index = 0; index < MAX_RUNS_PER_ROUTINE + 3; index += 1) {
      await runRoutineOnce(runtime, r)
    }

    expect((await runtime.listRuns(r.id)).length).toBe(MAX_RUNS_PER_ROUTINE)
  })
})

describe('a routine’s history outlives the generic prune', () => {
  it('spares the runs when old sessions are swept', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milo-runs-'))
    const { runtime, store, recaps } = build(dir)
    const r = routine('brave-otter-1')

    const run = await runRoutineOnce(runtime, r)
    for (let index = 0; index < 3; index += 1) {
      const session = await runtime.newSession({ gateway: 'web', conversationId: CONVERSATION })
      for await (const _event of session.send(`hello ${index}`)) { /* drain */ }
    }

    await pruneSessions(store, recaps, 1)

    // The conversations beyond `keep` go; the run is bounded by the routine, not
    // by this, so sweeping it here would make the Runs surface lose what it showed.
    expect((await runtime.listRuns(r.id)).map((entry) => entry.id)).toEqual([run.id])
    expect((await runtime.listSessions()).length).toBe(1)
  })

  it('drops the runs when the routine itself is removed', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milo-runs-'))
    const { runtime } = build(dir)
    const r = routine('brave-otter-1')
    const created = await addRoutine({
      name: r.name,
      prompt: r.prompt,
      when: r.when,
      target: r.target,
      enabled: true,
    })
    const made = await runRoutineOnce(runtime, created)

    expect(await removeRoutineWithRuns(runtime, created.id)).toBe(true)

    // A run is only reachable through its routine, so it goes with the routine
    // rather than staying as a file nothing can open.
    expect(await runtime.listRuns(created.id)).toEqual([])
    expect(await runtime.loadSession(made.id!)).toBeNull()
  })
})
