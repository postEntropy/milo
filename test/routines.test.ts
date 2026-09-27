import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRuntime } from '../src/core/runtime.js'
import type { Routine } from '../src/core/routines.js'

// Point the install somewhere throwaway *before* the path module is loaded.
const home = mkdtempSync(path.join(tmpdir(), 'milo-routines-'))
process.env.MILO_HOME = home

const {
  addRoutine,
  describeWhen,
  findRoutine,
  formatLocal,
  MAX_ROUTINES,
  markRun,
  nameFor,
  nextRunAt,
  parseWhen,
  readRoutines,
  removeRoutine,
  RoutineScheduler,
  setEnabled,
  writeRoutines,
} = await import('../src/core/routines.js')
const { routinesFile } = await import('../src/core/config/paths.js')

const every = (minutes: number) => ({ kind: 'every' as const, minutes })
const at = (time: string, days?: number[]) => ({ kind: 'at' as const, time, days })

describe('parseWhen', () => {
  it('reads a duration in minutes, hours or days', () => {
    expect(parseWhen({ every: '30m' })).toEqual(every(30))
    expect(parseWhen({ every: '2h' })).toEqual(every(120))
    expect(parseWhen({ every: '1d' })).toEqual(every(1440))
    expect(parseWhen({ every: '90' })).toEqual(every(90))
    expect(parseWhen({ every: '2 horas' })).toEqual(every(120))
    expect(parseWhen({ every: '1 minuto' })).toEqual(every(1))
  })

  it('reads a clock time, with or without the hour spelled out', () => {
    expect(parseWhen({ at: '08:00' })).toEqual(at('08:00'))
    expect(parseWhen({ at: '8:00' })).toEqual(at('08:00'))
    expect(parseWhen({ at: '8h' })).toEqual(at('08:00'))
    expect(parseWhen({ at: '8h30' })).toEqual(at('08:30'))
  })

  it('reads days as names, ranges or numbers', () => {
    expect(parseWhen({ at: '08:00', days: ['seg', 'ter'] })).toEqual(at('08:00', [1, 2]))
    expect(parseWhen({ at: '08:00', days: ['seg-sex'] })).toEqual(at('08:00', [1, 2, 3, 4, 5]))
    expect(parseWhen({ at: '08:00', days: ['1-5'] })).toEqual(at('08:00', [1, 2, 3, 4, 5]))
    expect(parseWhen({ at: '08:00', days: ['mon', 'FRIDAY'] })).toEqual(at('08:00', [1, 5]))
    expect(parseWhen({ at: '08:00', days: ['sábado', 'domingo'] })).toEqual(at('08:00', [0, 6]))
  })

  it('refuses what it cannot read rather than guessing', () => {
    expect(parseWhen({})).toBeNull()
    expect(parseWhen({ every: '0m' })).toBeNull()
    expect(parseWhen({ every: 'soon' })).toBeNull()
    expect(parseWhen({ every: '2h', at: '08:00' })).toBeNull()
    expect(parseWhen({ at: '25:00' })).toBeNull()
    expect(parseWhen({ at: '8:99' })).toBeNull()
    expect(parseWhen({ at: '08:00', days: ['quando'] })).toBeNull()
    // Days without a clock time have nothing to attach to.
    expect(parseWhen({ every: '2h', days: ['seg'] })).toBeNull()
  })
})

describe('nextRunAt', () => {
  it('steps an interval straight off the given instant', () => {
    const from = new Date(2026, 8, 25, 10, 0, 0)
    expect(nextRunAt(every(30), from).getTime()).toBe(from.getTime() + 30 * 60_000)
  })

  it('takes the next clock time, and is strictly in the future', () => {
    const before = new Date(2026, 8, 25, 7, 0, 0)
    expect(nextRunAt(at('08:00'), before)).toEqual(new Date(2026, 8, 25, 8, 0, 0))

    // Exactly on the time is not "after" it: the day's turn has been had.
    const onTheDot = new Date(2026, 8, 25, 8, 0, 0)
    expect(nextRunAt(at('08:00'), onTheDot)).toEqual(new Date(2026, 8, 26, 8, 0, 0))
  })

  it('lands on a day the routine allows', () => {
    const from = new Date(2026, 8, 25, 7, 0, 0)
    const monday = nextRunAt(at('08:00', [1]), from)
    expect(monday.getDay()).toBe(1)
    expect(monday.getTime()).toBeGreaterThan(from.getTime())

    // Today matches and the hour has not come yet, so it is today.
    const today = nextRunAt(at('08:00', [from.getDay()]), from)
    expect(today).toEqual(new Date(2026, 8, 25, 8, 0, 0))
  })
})

describe('describeWhen', () => {
  it('says an interval in the largest whole unit', () => {
    expect(describeWhen(every(30))).toBe('every 30m')
    expect(describeWhen(every(120))).toBe('every 2h')
    expect(describeWhen(every(1440))).toBe('every 1d')
  })

  it('says a time, and its days when it has any', () => {
    expect(describeWhen(at('08:00'))).toBe('08:00, every day')
    // Days are read in either language; they are written back in one.
    expect(describeWhen(at('08:00', [1, 2, 3, 4, 5]))).toBe('08:00, mon–fri')
    expect(describeWhen(at('08:00', [1, 3, 5]))).toBe('08:00, mon, wed, fri')
  })
})

describe('formatLocal', () => {
  it('reads as a local date and time', () => {
    expect(formatLocal(new Date(2026, 8, 26, 8, 5))).toBe('2026-09-26 08:05')
  })
})

describe('the store', () => {
  const routine = (over: Record<string, unknown> = {}) => ({
    prompt: 'look at the repo',
    when: at('08:00'),
    target: { gateway: 'telegram' as const, conversationId: '123' },
    enabled: true,
    ...over,
  })

  it('round-trips what it writes', () => {
    writeRoutines([])
    const added = addRoutine(routine())
    expect(added.id).toMatch(/^[a-z]+-[a-z]+-\d+$/)
    expect(added.createdAt).toBeGreaterThan(0)

    const read = readRoutines()
    expect(read).toHaveLength(1)
    expect(read[0]!.id).toBe(added.id)
    expect(findRoutine(added.id)?.prompt).toBe('look at the repo')
  })

  it('gives an absent file as an empty list', () => {
    writeFileSync(routinesFile(), '')
    expect(readRoutines()).toEqual([])
  })

  it('drops entries it cannot trust instead of failing to start', () => {
    writeFileSync(
      routinesFile(),
      JSON.stringify([
        { id: 'ok-otter-1', prompt: 'x', when: at('08:00'), target: { gateway: 'telegram', conversationId: '1' } },
        { id: 'no-prompt', when: at('08:00'), target: { gateway: 'telegram', conversationId: '1' } },
        { id: 'bad-when', prompt: 'x', when: { kind: 'sometimes' }, target: { gateway: 'telegram', conversationId: '1' } },
        { id: 'bad-target', prompt: 'x', when: at('08:00'), target: { gateway: 'email', conversationId: '1' } },
        'not even an object',
      ]),
    )
    expect(readRoutines().map((entry) => entry.id)).toEqual(['ok-otter-1'])
  })

  it('treats a missing `enabled` as on', () => {
    writeFileSync(
      routinesFile(),
      JSON.stringify([
        { id: 'ok-otter-1', prompt: 'x', when: at('08:00'), target: { gateway: 'telegram', conversationId: '1' } },
      ]),
    )
    expect(readRoutines()[0]!.enabled).toBe(true)
  })

  it('accepts a web chat as a destination', () => {
    writeFileSync(
      routinesFile(),
      JSON.stringify([
        {
          id: 'ok-otter-1',
          prompt: 'x',
          when: at('08:00'),
          target: { gateway: 'web', conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
        },
      ]),
    )
    expect(readRoutines()[0]!.target.gateway).toBe('web')
  })

  it('removes, enables and disables by id', () => {
    writeRoutines([])
    const added = addRoutine(routine())

    expect(removeRoutine('nobody-here-1')).toBe(false)
    expect(setEnabled('nobody-here-1', false)).toBe(false)

    expect(setEnabled(added.id, false)).toBe(true)
    expect(findRoutine(added.id)?.enabled).toBe(false)

    expect(removeRoutine(added.id)).toBe(true)
    expect(findRoutine(added.id)).toBeUndefined()
  })

  it('writes down the run so a restart can tell', () => {
    writeRoutines([])
    const added = addRoutine(routine())

    markRun(added.id, 'error', 1_700_000_000_000)
    expect(findRoutine(added.id)).toMatchObject({ lastRunAt: 1_700_000_000_000, lastResult: 'error' })
  })

  it('keeps the grants a routine carries, and copes with a file without them', () => {
    writeRoutines([])
    const added = addRoutine({ ...routine(), allow: ['shell_command'] })
    expect(findRoutine(added.id)?.allow).toEqual(['shell_command'])

    writeFileSync(
      routinesFile(),
      JSON.stringify([
        { id: 'calm-otter-1', prompt: 'x', when: at('08:00'), target: { gateway: 'telegram', conversationId: '1' } },
      ]),
    )
    expect(readRoutines()[0]!.allow).toBeUndefined()
  })

  it('refuses to grow past its ceiling', () => {
    writeRoutines(
      Array.from({ length: MAX_ROUTINES }, (_value, index) => ({
        ...routine(),
        id: `routine-${index}-1`,
        createdAt: 0,
      })),
    )
    expect(() => addRoutine(routine())).toThrow(/at most/)
  })

  it('writes a file a person can read', () => {
    writeRoutines([])
    addRoutine(routine({ name: 'briefing' }))
    const raw = readFileSync(routinesFile(), 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(raw).toContain('"briefing"')
  })

  it('names a routine from its prompt, on a word boundary', () => {
    writeRoutines([])
    const added = addRoutine(
      routine({ prompt: 'look at the repo and tell me what moved since yesterday' }),
    )

    expect(added.name).toBe('look at the repo and tell me what moved…')
    // A short prompt is its own name, without the trailing punctuation.
    expect(nameFor('check the deploy.')).toBe('check the deploy')
    expect(nameFor('say hi')).toBe('say hi')
  })

  it('keeps the name it was given rather than deriving one', () => {
    writeRoutines([])
    expect(addRoutine(routine({ name: '  daily briefing  ' })).name).toBe('daily briefing')
  })
})

const sample = (over: Partial<Routine> = {}): Routine => ({
  id: 'calm-otter-1',
  name: 'briefing',
  prompt: 'look at the repo',
  when: at('08:00'),
  target: { gateway: 'telegram', conversationId: '123' },
  enabled: true,
  createdAt: 0,
  ...over,
})

interface FakeRun {
  answer?: string
  fail?: string
  gate?: Promise<void>
}

/** A runtime whose one session answers in whatever way the test asked for. */
function fakeRuntime(options: FakeRun = {}): {
  runtime: AgentRuntime
  prompts: string[]
  sessions: { grantedTools?: string[] }[]
} {
  const prompts: string[] = []
  const sessions: { grantedTools?: string[] }[] = []
  const runtime = {
    async newSession(_scope: unknown, _title?: string, session?: { grantedTools?: string[] }) {
      sessions.push({ grantedTools: session?.grantedTools })
      return {
        async *send(prompt: string) {
          prompts.push(prompt)
          if (options.gate) await options.gate
          if (options.fail) {
            yield { type: 'error' as const, message: options.fail }
            return
          }
          yield { type: 'text-delta' as const, delta: options.answer ?? 'ok' }
        },
      }
    },
  }
  return { runtime: runtime as unknown as AgentRuntime, prompts, sessions }
}

function harness(options: FakeRun = {}) {
  const { runtime, prompts, sessions } = fakeRuntime(options)
  const delivered: { id: string; text: string }[] = []
  const logs: string[] = []
  let clock = new Date(2026, 8, 25, 7, 59, 30)
  const scheduler = new RoutineScheduler({
    runtime,
    deliver: async (routine, text) => {
      delivered.push({ id: routine.id, text })
    },
    log: (line) => logs.push(line),
    now: () => clock,
  })
  return {
    scheduler,
    prompts,
    sessions,
    delivered,
    logs,
    setClock: (date: Date) => {
      clock = date
    },
    /** Moves the wall clock without touching the timer queue. */
    advanceClock: (ms: number) => {
      clock = new Date(clock.getTime() + ms)
    },
  }
}

describe('RoutineScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('fires a due routine and delivers what it answered', async () => {
    writeRoutines([sample()])
    const h = harness()
    h.scheduler.start()

    h.advanceClock(60_000)
    await vi.advanceTimersByTimeAsync(61_000)

    expect(h.prompts).toEqual(['look at the repo'])
    // The name leads the message, so a chat with several routines can tell which
    // one just spoke.
    expect(h.delivered).toEqual([{ id: 'calm-otter-1', text: 'briefing\n\nok' }])
    expect(readRoutines()[0]).toMatchObject({ lastResult: 'ok' })
    expect(readRoutines()[0]!.lastRunAt).toBeGreaterThan(0)
    h.scheduler.stop()
  })

  it('does not make up a routine it slept through', async () => {
    // 07:00 has already passed when the daemon comes up at 07:59.
    writeRoutines([sample({ when: at('07:00') })])
    const h = harness()
    h.scheduler.start()

    h.setClock(new Date(2026, 8, 25, 9, 0, 0))
    await vi.advanceTimersByTimeAsync(120_000)

    expect(h.prompts).toEqual([])
    expect(readRoutines()[0]!.lastRunAt).toBeUndefined()
    h.scheduler.stop()
  })

  it('runs an interval routine once per occurrence, never twice for one', async () => {
    writeRoutines([sample({ when: every(1) })])
    const h = harness()
    h.scheduler.start()

    h.setClock(new Date(2026, 8, 25, 8, 0, 40))
    await vi.advanceTimersByTimeAsync(120_000)
    expect(h.prompts).toHaveLength(1)

    // More ticks at the same instant: the occurrence already had its turn.
    await vi.advanceTimersByTimeAsync(120_000)
    expect(h.prompts).toHaveLength(1)

    h.setClock(new Date(2026, 8, 25, 8, 1, 40))
    await vi.advanceTimersByTimeAsync(120_000)
    expect(h.prompts).toHaveLength(2)
    h.scheduler.stop()
  })

  it('leaves a disabled routine alone', async () => {
    writeRoutines([sample({ when: every(1), enabled: false })])
    const h = harness()
    h.scheduler.start()

    h.setClock(new Date(2026, 8, 25, 8, 0, 40))
    await vi.advanceTimersByTimeAsync(120_000)

    expect(h.prompts).toEqual([])
    h.scheduler.stop()
  })

  it('skips an occurrence rather than stack it on a run still going', async () => {
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    writeRoutines([sample({ when: every(1) })])
    const h = harness({ gate })
    h.scheduler.start()

    h.setClock(new Date(2026, 8, 25, 8, 0, 40))
    await vi.advanceTimersByTimeAsync(120_000)
    expect(h.prompts).toHaveLength(1)

    h.setClock(new Date(2026, 8, 25, 8, 1, 40))
    await vi.advanceTimersByTimeAsync(120_000)

    expect(h.prompts).toHaveLength(1)
    expect(h.logs.some((line) => line.includes('skipped'))).toBe(true)

    release()
    await vi.advanceTimersByTimeAsync(10)
    h.scheduler.stop()
  })

  it('says when a routine failed, and marks the run', async () => {
    writeRoutines([sample({ when: every(1) })])
    const h = harness({ fail: 'boom' })
    h.scheduler.start()

    h.setClock(new Date(2026, 8, 25, 8, 0, 40))
    await vi.advanceTimersByTimeAsync(120_000)

    expect(h.delivered[0]!.text).toContain('failed')
    expect(h.delivered[0]!.text).toContain('boom')
    expect(readRoutines()[0]!.lastResult).toBe('error')
    expect(h.logs.some((line) => line.includes('failed'))).toBe(true)
    h.scheduler.stop()
  })

  it('posts nothing when the routine answered nothing', async () => {
    writeRoutines([sample({ when: every(1) })])
    const h = harness({ answer: '' })
    h.scheduler.start()

    h.setClock(new Date(2026, 8, 25, 8, 0, 40))
    await vi.advanceTimersByTimeAsync(120_000)

    expect(h.delivered).toEqual([])
    h.scheduler.stop()
  })

  it("carries the routine's grants into the run, which is the only place they apply", async () => {
    writeRoutines([sample({ when: every(1), allow: ['shell_command'] })])
    const h = harness()
    h.scheduler.start()

    h.setClock(new Date(2026, 8, 25, 8, 0, 40))
    await vi.advanceTimersByTimeAsync(120_000)

    expect(h.sessions).toEqual([{ grantedTools: ['shell_command'] }])
    h.scheduler.stop()
  })

  it('stops firing once stopped', async () => {
    writeRoutines([sample({ when: every(1) })])
    const h = harness()
    h.scheduler.start()
    h.scheduler.stop()

    h.setClock(new Date(2026, 8, 25, 9, 0, 0))
    await vi.advanceTimersByTimeAsync(600_000)

    expect(h.prompts).toEqual([])
  })
})
