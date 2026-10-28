import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import lockfile from 'proper-lockfile'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRuntime } from '../src/core/runtime.js'
import type { OutgoingFile, RoutineDelivery } from '../src/core/outgoing.js'
import type { Routine } from '../src/core/routines.js'

// Point the install somewhere throwaway *before* the path module is loaded.
const home = mkdtempSync(path.join(tmpdir(), 'milo-routines-'))
process.env.MILO_HOME = home

const {
  addRoutine,
  describeSchedule,
  describeTarget,
  describeWhen,
  findRoutine,
  formatLocal,
  isSpent,
  MAX_ROUTINES,
  markRun,
  nameFor,
  nextRunAt,
  parseWhen,
  readRoutines,
  remainingRuns,
  removeRoutine,
  RoutineScheduler,
  runsLeft,
  setEnabled,
  upcomingRuns,
  updateRoutine,
} = await import('../src/core/routines.js')
const { SILENT } = await import('../src/core/silent.js')
const { routinesFile } = await import('../src/core/config/paths.js')

/** Seed the on-disk store directly; production writes go through the routine operations. */
async function seedRoutines(routines: Routine[]): Promise<void> {
  mkdirSync(path.dirname(routinesFile()), { recursive: true })
  writeFileSync(routinesFile(), `${JSON.stringify(routines, null, 2)}\n`)
}

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

  it('reads a day of the month and a month, as numbers, names or ranges', () => {
    expect(parseWhen({ at: '09:00', dayOfMonth: ['1'] })).toEqual({ kind: 'at', time: '09:00', dayOfMonth: [1] })
    expect(parseWhen({ at: '09:00', dayOfMonth: ['1', '15'] })).toEqual({ kind: 'at', time: '09:00', dayOfMonth: [1, 15] })
    expect(parseWhen({ at: '09:00', dayOfMonth: ['1-15'] })).toEqual({
      kind: 'at', time: '09:00', dayOfMonth: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    })
    expect(parseWhen({ at: '09:00', month: ['dec'] })).toEqual({ kind: 'at', time: '09:00', month: [12] })
    expect(parseWhen({ at: '09:00', month: ['12'] })).toEqual({ kind: 'at', time: '09:00', month: [12] })
    expect(parseWhen({ at: '09:00', month: ['jul', 'ago'] })).toEqual({ kind: 'at', time: '09:00', month: [7, 8] })
    // Read in either language, like the days.
    expect(parseWhen({ at: '09:00', month: ['dezembro'] })).toEqual({ kind: 'at', time: '09:00', month: [12] })
    expect(parseWhen({ at: '09:00', dayOfMonth: ['25'], month: ['dec'] })).toEqual({
      kind: 'at', time: '09:00', dayOfMonth: [25], month: [12],
    })
    // A month narrows the weekdays rather than replacing them.
    expect(parseWhen({ at: '09:00', days: ['mon'], month: ['jul'] })).toEqual({
      kind: 'at', time: '09:00', days: [1], month: [7],
    })
  })

  it('refuses a date it cannot read, or one that can never happen', () => {
    // A date needs a clock time, like the days do.
    expect(parseWhen({ month: ['dec'] })).toBeNull()
    expect(parseWhen({ dayOfMonth: ['1'] })).toBeNull()
    // A schedule is by day of the week or by day of the month, never both.
    expect(parseWhen({ at: '09:00', days: ['mon'], dayOfMonth: ['1'] })).toBeNull()
    // Out of range.
    expect(parseWhen({ at: '09:00', dayOfMonth: ['0'] })).toBeNull()
    expect(parseWhen({ at: '09:00', dayOfMonth: ['32'] })).toBeNull()
    expect(parseWhen({ at: '09:00', month: ['13'] })).toBeNull()
    expect(parseWhen({ at: '09:00', dayOfMonth: ['15-1'] })).toBeNull()
    // A day no month can hold.
    expect(parseWhen({ at: '09:00', dayOfMonth: ['31'], month: ['feb'] })).toBeNull()
    expect(parseWhen({ at: '09:00', dayOfMonth: ['31'], month: ['apr'] })).toBeNull()
    // ...but the 29th of February is real, and a day one of the months holds is kept.
    expect(parseWhen({ at: '09:00', dayOfMonth: ['29'], month: ['feb'] })).toEqual({
      kind: 'at', time: '09:00', dayOfMonth: [29], month: [2],
    })
    expect(parseWhen({ at: '09:00', dayOfMonth: ['31'], month: ['mar', 'apr'] })).toEqual({
      kind: 'at', time: '09:00', dayOfMonth: [31], month: [3, 4],
    })
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

  it('lands on the day of the month, in the month it names', () => {
    const from = new Date(2026, 8, 25, 7, 0, 0)

    // Day 10 of every month: the next is next month's.
    expect(nextRunAt({ kind: 'at', time: '09:00', dayOfMonth: [10] }, from))
      .toEqual(new Date(2026, 9, 10, 9, 0, 0))

    // The 25th of December this year is still ahead.
    expect(nextRunAt({ kind: 'at', time: '09:00', dayOfMonth: [25], month: [12] }, from))
      .toEqual(new Date(2026, 11, 25, 9, 0, 0))
    // Once it is behind us, it waits for next year.
    expect(nextRunAt({ kind: 'at', time: '09:00', dayOfMonth: [25], month: [12] }, new Date(2026, 11, 26, 7, 0, 0)))
      .toEqual(new Date(2027, 11, 25, 9, 0, 0))

    // Only December: the first of it.
    expect(nextRunAt({ kind: 'at', time: '09:00', month: [12] }, from))
      .toEqual(new Date(2026, 11, 1, 9, 0, 0))
  })

  it('finds a lone 29 February within its own leap cycle', () => {
    const from = new Date(2026, 0, 1, 7, 0, 0)
    expect(nextRunAt({ kind: 'at', time: '09:00', dayOfMonth: [29], month: [2] }, from))
      .toEqual(new Date(2028, 1, 29, 9, 0, 0))
  })
})

describe('upcomingRuns', () => {
  it('steps an interval forward, one after another', () => {
    const from = new Date(2026, 8, 25, 10, 0, 0)
    expect(upcomingRuns(every(30), from, 3).map((at) => at.getTime())).toEqual([
      from.getTime() + 30 * 60_000,
      from.getTime() + 60 * 60_000,
      from.getTime() + 90 * 60_000,
    ])
  })

  it('lands on the days a clock schedule allows, skipping the rest', () => {
    const from = new Date(2026, 8, 25, 7, 0, 0)
    const times = upcomingRuns(at('08:00', [1, 3]), from, 3)
    expect(times).toEqual([
      new Date(2026, 8, 28, 8, 0, 0),
      new Date(2026, 8, 30, 8, 0, 0),
      new Date(2026, 9, 5, 8, 0, 0),
    ])
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

  it('says a date or a month, in the display language', () => {
    expect(describeWhen({ kind: 'at', time: '09:00', dayOfMonth: [25], month: [12] }))
      .toBe('09:00, day 25 of December')
    expect(describeWhen({ kind: 'at', time: '09:00', dayOfMonth: [1, 15] }))
      .toBe('09:00, days 1, 15 of every month')
    expect(describeWhen({ kind: 'at', time: '09:00', month: [12] }))
      .toBe('09:00, every day in December')
    expect(describeWhen({ kind: 'at', time: '09:00', days: [1, 3, 5], month: [7] }))
      .toBe('09:00, mon, wed, fri in July')
  })
})

describe('the run ceiling', () => {
  it('reads a routine with no ceiling as never spent, and as having no count to read', () => {
    expect(isSpent({})).toBe(false)
    expect(runsLeft({})).toBeNull()
  })

  it('is spent once the timer has run it as many times as it was allowed', () => {
    expect(isSpent({ limit: 5, runs: 4 })).toBe(false)
    expect(isSpent({ limit: 5 })).toBe(false)
    expect(runsLeft({ limit: 5, runs: 4 })).toBe(1)
    expect(isSpent({ limit: 5, runs: 5 })).toBe(true)
    expect(runsLeft({ limit: 5, runs: 5 })).toBe(0)
    // A count past the ceiling is still spent, not a negative number of runs left.
    expect(runsLeft({ limit: 5, runs: 9 })).toBe(0)
  })

  it('says the ceiling with the time, and nothing when there is none', () => {
    expect(describeSchedule({ when: every(1), limit: 5 })).toBe('every 1m, 5 runs')
    expect(describeSchedule({ when: every(1), limit: 1 })).toBe('every 1m, 1 run')
    expect(describeSchedule({ when: every(1) })).toBe('every 1m')
  })

  it('carries no more times than the runs it still has', () => {
    const from = new Date(2026, 8, 25, 8, 0, 0)

    expect(remainingRuns({ when: every(10), limit: 3 }, from, 5)).toHaveLength(3)
    expect(remainingRuns({ when: every(10), limit: 3, runs: 2 }, from, 5)).toHaveLength(1)
    expect(remainingRuns({ when: every(10), limit: 3, runs: 3 }, from, 5)).toEqual([])
    // No ceiling at all is the schedule's own reading, unchanged.
    expect(remainingRuns({ when: every(10) }, from, 5)).toEqual(upcomingRuns(every(10), from, 5))
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
    target: { gateway: 'telegram' as const, chatId: '123' },
    enabled: true,
    ...over,
  })

  it('round-trips what it writes', async () => {
    await seedRoutines([])
    const added = await addRoutine(routine())
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

  it('keeps the chat a routine named before the field was renamed', () => {
    writeFileSync(
      routinesFile(),
      JSON.stringify([
        {
          id: 'calm-otter-2',
          prompt: 'x',
          when: at('08:00'),
          target: { gateway: 'web', conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
        },
      ]),
    )
    // Still delivers where it was pointed, rather than dropping out of the list.
    expect(readRoutines()[0]!.target).toEqual({
      gateway: 'web',
      chatId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    })
  })

  it('drops entries it cannot trust instead of failing to start', () => {
    writeFileSync(
      routinesFile(),
      JSON.stringify([
        { id: 'ok-otter-1', prompt: 'x', when: at('08:00'), target: { gateway: 'telegram', chatId: '1' } },
        { id: 'no-prompt', when: at('08:00'), target: { gateway: 'telegram', chatId: '1' } },
        { id: 'bad-when', prompt: 'x', when: { kind: 'sometimes' }, target: { gateway: 'telegram', chatId: '1' } },
        { id: 'bad-target', prompt: 'x', when: at('08:00'), target: { gateway: 'email', chatId: '1' } },
        'not even an object',
      ]),
    )
    expect(readRoutines().map((entry) => entry.id)).toEqual(['ok-otter-1'])
  })

  it('drops a routine whose date can never be scheduled', () => {
    writeFileSync(
      routinesFile(),
      JSON.stringify([
        // A day of the week and a day of the month in one schedule.
        { id: 'both-days-1', prompt: 'x', when: { kind: 'at', time: '09:00', days: [1], dayOfMonth: [1] }, target: { gateway: 'telegram', chatId: '1' } },
        // The 31st of a month that has 30 days, and February's own impossible 31st.
        { id: 'bad-date-1', prompt: 'x', when: { kind: 'at', time: '09:00', dayOfMonth: [31], month: [2] }, target: { gateway: 'telegram', chatId: '1' } },
        // The 29th of February is a real date.
        { id: 'ok-date-1', prompt: 'x', when: { kind: 'at', time: '09:00', dayOfMonth: [29], month: [2] }, target: { gateway: 'telegram', chatId: '1' } },
      ]),
    )
    expect(readRoutines().map((entry) => entry.id)).toEqual(['ok-date-1'])
  })

  it('treats a missing `enabled` as on', () => {
    writeFileSync(
      routinesFile(),
      JSON.stringify([
        { id: 'ok-otter-1', prompt: 'x', when: at('08:00'), target: { gateway: 'telegram', chatId: '1' } },
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
          target: { gateway: 'web', chatId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
        },
      ]),
    )
    expect(readRoutines()[0]!.target.gateway).toBe('web')
  })

  it('keeps a routine that delivers nowhere, its runs living on the Routines screen', () => {
    writeFileSync(
      routinesFile(),
      JSON.stringify([
        { id: 'calm-otter-2', prompt: 'x', when: at('08:00'), target: { gateway: 'none' } },
      ]),
    )
    const target = readRoutines()[0]!.target
    expect(target).toEqual({ gateway: 'none' })
    expect(describeTarget(target)).toBe('the Routines screen')
  })

  it('reads an interval in seconds, held as a fraction of a minute', () => {
    const when = parseWhen({ every: '30s' })
    expect(when).toEqual({ kind: 'every', minutes: 0.5 })
    expect(describeWhen(when!)).toBe('every 30s')
    expect(parseWhen({ every: '1s' })).toEqual({ kind: 'every', minutes: 1 / 60 })
    expect(parseWhen({ every: '0s' })).toBeNull()
  })

  it('removes, enables and disables by id', async () => {
    await seedRoutines([])
    const added = await addRoutine(routine())

    expect(await removeRoutine('nobody-here-1')).toBe(false)
    expect(await setEnabled('nobody-here-1', false)).toBeUndefined()

    expect((await setEnabled(added.id, false))?.enabled).toBe(false)
    expect(findRoutine(added.id)?.enabled).toBe(false)

    expect(await removeRoutine(added.id)).toBe(true)
    expect(findRoutine(added.id)).toBeUndefined()
  })

  it('keeps a ceiling, counts the runs, and drops a count that is not one', async () => {
    await seedRoutines([])
    const added = await addRoutine(routine({ limit: 3 }))
    expect(readRoutines()[0]!.limit).toBe(3)

    await markRun(added.id, 'ok', 1_000)
    expect(readRoutines()[0]).toMatchObject({ runs: 1, enabled: true })

    // A file someone edited by hand reads by the same rule as an empty grant: what is
    // not a whole number of runs is no count, and no count is not a reason to drop the
    // routine.
    writeFileSync(routinesFile(), JSON.stringify([{ ...added, limit: 'three', runs: -1 }]))
    expect(readRoutines()[0]).toMatchObject({ limit: undefined, runs: undefined })
  })

  it('stops the routine itself on the run that uses the ceiling up', async () => {
    await seedRoutines([])
    const added = await addRoutine(routine({ limit: 2 }))

    await markRun(added.id, 'ok', 1_000)
    expect(findRoutine(added.id)).toMatchObject({ enabled: true, runs: 1 })

    await markRun(added.id, 'ok', 2_000)
    expect(findRoutine(added.id)).toMatchObject({ enabled: false, runs: 2 })
  })

  it('takes a ceiling off with a zero, the way an empty grant is no grant', async () => {
    await seedRoutines([])
    const added = await addRoutine(routine({ limit: 5 }))
    await markRun(added.id, 'ok', 1_000)

    await updateRoutine(added.id, { limit: 0 })

    // The tally goes with the ceiling it counted against: nothing is counting now, so
    // the next ceiling put on starts at zero rather than part-used.
    expect(findRoutine(added.id)).toMatchObject({ limit: undefined, runs: undefined })
  })

  it('starts a ceiling put on a routine that has been repeating for ages at zero', async () => {
    await seedRoutines([])
    const added = await addRoutine(routine())

    await markRun(added.id, 'ok', 1_000)
    await markRun(added.id, 'ok', 2_000)
    // A routine with no ceiling takes no tally, so there is none to inherit.
    expect(findRoutine(added.id)!.runs).toBeUndefined()

    await updateRoutine(added.id, { limit: 5 })

    const capped = findRoutine(added.id)!
    expect(capped.limit).toBe(5)
    expect(isSpent(capped)).toBe(false)
  })

  it('starts a spent routine counting over when it is switched on, and leaves a paused one alone', async () => {
    await seedRoutines([])
    const spent = await addRoutine(routine({ limit: 1 }))
    await markRun(spent.id, 'ok', 1_000)
    expect(findRoutine(spent.id)!.enabled).toBe(false)

    await setEnabled(spent.id, true)
    expect(findRoutine(spent.id)).toMatchObject({ enabled: true, runs: undefined })

    const paused = await addRoutine(routine({ prompt: 'the other one', limit: 5 }))
    await markRun(paused.id, 'ok', 1_000)
    await setEnabled(paused.id, false)
    await setEnabled(paused.id, true)

    expect(findRoutine(paused.id)).toMatchObject({ enabled: true, runs: 1 })
  })

  it('starts the count over when a spent routine is given a new ceiling, and keeps it mid-stretch', async () => {
    await seedRoutines([])
    const spent = await addRoutine(routine({ limit: 1 }))
    await markRun(spent.id, 'ok', 1_000)

    await updateRoutine(spent.id, { limit: 4 })
    expect(findRoutine(spent.id)).toMatchObject({ limit: 4, runs: undefined })

    const going = await addRoutine(routine({ prompt: 'the other one', limit: 5 }))
    await markRun(going.id, 'ok', 1_000)

    await updateRoutine(going.id, { limit: 9 })
    expect(findRoutine(going.id)).toMatchObject({ limit: 9, runs: 1 })
  })

  it('changes a routine in place, keeping its id and creation time', async () => {
    await seedRoutines([])
    const added = await addRoutine(routine({ name: 'briefing' }))

    const updated = await updateRoutine(added.id, {
      when: at('09:00', [1, 2, 3, 4, 5]),
      target: { gateway: 'discord', chatId: '999' },
      enabled: false,
    })

    expect(updated?.id).toBe(added.id)
    expect(updated?.createdAt).toBe(added.createdAt)
    expect(updated?.when).toEqual(at('09:00', [1, 2, 3, 4, 5]))
    expect(updated?.target).toEqual({ gateway: 'discord', chatId: '999' })
    expect(updated?.enabled).toBe(false)
    // What the patch left out is kept as it was.
    expect(findRoutine(added.id)).toMatchObject({ prompt: 'look at the repo', name: 'briefing' })
  })

  it('renames, clears the grants, and says nothing about an id it does not have', async () => {
    await seedRoutines([])
    const added = await addRoutine({ ...routine(), allow: ['shell_command'] })

    expect((await updateRoutine(added.id, { name: '  the briefing  ' }))?.name).toBe('the briefing')
    // An empty list clears the grants: the field is gone, not left as [].
    expect((await updateRoutine(added.id, { allow: [] }))?.allow).toBeUndefined()
    expect(await updateRoutine('nobody-here-1', { enabled: false })).toBeUndefined()
  })

  it('falls back to the prompt for a name cleared to nothing', async () => {
    await seedRoutines([])
    const added = await addRoutine(routine({ name: 'briefing' }))

    expect((await updateRoutine(added.id, { name: '   ' }))?.name).toBe('Look at the repo')
  })

  it('writes down the run so a restart can tell', async () => {
    await seedRoutines([])
    const added = await addRoutine(routine())

    await markRun(added.id, 'error', 1_700_000_000_000)
    expect(findRoutine(added.id)).toMatchObject({ lastRunAt: 1_700_000_000_000, lastResult: 'error' })
  })

  it('keeps the silent mode, takes it off with a false, and reads only a true', async () => {
    await seedRoutines([])
    const added = await addRoutine(routine({ silent: true }))
    expect(findRoutine(added.id)?.silent).toBe(true)

    await updateRoutine(added.id, { silent: false })
    expect(findRoutine(added.id)?.silent).toBeUndefined()

    // What a hand-edited file holds that is not a true is not the mode.
    writeFileSync(routinesFile(), JSON.stringify([{ ...added, silent: 'yes' }]))
    expect(readRoutines()[0]!.silent).toBeUndefined()
  })

  it('keeps the grants a routine carries, and copes with a file without them', async () => {
    await seedRoutines([])
    const added = await addRoutine({ ...routine(), allow: ['shell_command'] })
    expect(findRoutine(added.id)?.allow).toEqual(['shell_command'])

    writeFileSync(
      routinesFile(),
      JSON.stringify([
        { id: 'calm-otter-1', prompt: 'x', when: at('08:00'), target: { gateway: 'telegram', chatId: '1' } },
      ]),
    )
    expect(readRoutines()[0]!.allow).toBeUndefined()
  })

  it('refuses to grow past its ceiling', async () => {
    await seedRoutines(
      Array.from({ length: MAX_ROUTINES }, (_value, index) => ({
        ...routine(),
        id: `routine-${index}-1`,
        createdAt: 0,
      })),
    )
    await expect(addRoutine(routine())).rejects.toThrow(/at most/)
  })

  it('refuses to write over a routines file it cannot read', async () => {
    // A tolerant read answers nothing, but a write must not be built on that
    // reading: the next add would otherwise erase the whole file.
    writeFileSync(routinesFile(), '{ not json')
    await expect(addRoutine(routine())).rejects.toThrow(/routines\.json/)
    expect(readFileSync(routinesFile(), 'utf8')).toBe('{ not json')
  })

  it('writes a file a person can read', async () => {
    await seedRoutines([])
    await addRoutine(routine({ name: 'briefing' }))
    const raw = readFileSync(routinesFile(), 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(raw).toContain('"briefing"')
  })

  it('names a routine from its prompt, on a word boundary, as a name reads', async () => {
    await seedRoutines([])
    const added = await addRoutine(
      routine({ prompt: 'look at the repo and tell me what moved since yesterday' }),
    )

    expect(added.name).toBe('Look at the repo and tell me what moved…')
    // A short prompt is its own name, without the trailing punctuation, capitalised —
    // the first letter only, so the person's own capitalisation inside it is kept.
    expect(nameFor('check the deploy.')).toBe('Check the deploy')
    expect(nameFor('say hi')).toBe('Say hi')
    expect(nameFor('check the NGU Idle autosave')).toBe('Check the NGU Idle autosave')
  })

  it('keeps the name it was given rather than deriving one', async () => {
    await seedRoutines([])
    expect((await addRoutine(routine({ name: '  daily briefing  ' }))).name).toBe('daily briefing')
  })

  // Two writers in different processes each rewrite the whole list from the copy
  // they read, so the lock is what keeps the slower one from erasing the other.
  it('waits for the lock another process is holding', async () => {
    await seedRoutines([])
    const release = await lockfile.lock(routinesFile(), { realpath: false, stale: 10_000 })
    let added = false
    const adding = addRoutine(routine()).then(() => {
      added = true
    })

    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(added).toBe(false)

    await release()
    await adding
    expect(readRoutines()).toHaveLength(1)
  })

  it('lands its change on top of one written while it waited', async () => {
    await seedRoutines([])
    const release = await lockfile.lock(routinesFile(), { realpath: false, stale: 10_000 })
    const adding = addRoutine(routine({ prompt: 'from the assistant' }))

    // The other process writes its own change while this add waits for the lock.
    await new Promise((resolve) => setTimeout(resolve, 30))
    writeFileSync(
      routinesFile(),
      JSON.stringify([
        {
          id: 'calm-otter-9',
          prompt: 'from the CLI',
          when: at('08:00'),
          target: { gateway: 'telegram', chatId: '1' },
          enabled: true,
        },
      ]),
    )

    await release()
    await adding
    expect(readRoutines().map((entry) => entry.prompt).sort()).toEqual([
      'from the CLI',
      'from the assistant',
    ])
  })
})

const sample = (over: Partial<Routine> = {}): Routine => ({
  id: 'calm-otter-1',
  name: 'briefing',
  prompt: 'look at the repo',
  when: at('08:00'),
  target: { gateway: 'telegram', chatId: '123' },
  enabled: true,
  createdAt: 0,
  ...over,
})

interface FakeRun {
  answer?: string
  fail?: string
  gate?: Promise<void>
  /** Files the fake turn asked the surfaces to send. */
  files?: OutgoingFile[]
}

/** What the stub session was pinned with, so a test can read it back. */
interface SentSession {
  grantedTools?: string[]
  deliverTo?: { gateway: string; chatId: string }
}

/** A runtime whose one session answers in whatever way the test asked for. */
function fakeRuntime(options: FakeRun = {}): {
  runtime: AgentRuntime
  prompts: string[]
  asides: Array<string | undefined>
  sessions: SentSession[]
} {
  const prompts: string[] = []
  const asides: Array<string | undefined> = []
  const sessions: SentSession[] = []
  const runtime = {
    // No history behind this run: the sweep has nothing to trim, and a run this
    // fake produced is not one the test asks the store about.
    async listRuns() {
      return []
    },
    async newSession(_scope: unknown, _title?: string, session?: SentSession) {
      sessions.push({ grantedTools: session?.grantedTools, deliverTo: session?.deliverTo })
      return {
        id: 'fake-run-1',
        async *send(prompt: string, sent?: { aside?: string }) {
          prompts.push(prompt)
          asides.push(sent?.aside)
          if (options.gate) await options.gate
          if (options.fail) {
            yield { type: 'error' as const, message: options.fail }
            return
          }
          yield { type: 'text-delta' as const, delta: options.answer ?? 'ok' }
        },
        takeOutgoing: () => options.files ?? [],
        // The run writes what it produced into its own record; there is no record
        // behind this fake, so the call is counted and dropped.
        appendNotice: async () => undefined,
      }
    },
  }
  return { runtime: runtime as unknown as AgentRuntime, prompts, asides, sessions }
}

function harness(options: FakeRun = {}) {
  const { runtime, prompts, asides, sessions } = fakeRuntime(options)
  const delivered: { id: string; text?: string; files?: OutgoingFile[]; routine?: RoutineDelivery }[] = []
  const logs: string[] = []
  let clock = new Date(2026, 8, 25, 7, 59, 30)
  const scheduler = new RoutineScheduler({
    runtime,
    deliver: async (routine, message) => {
      delivered.push({ id: routine.id, ...message })
    },
    log: (line) => logs.push(line),
    now: () => clock,
  })
  return {
    scheduler,
    prompts,
    asides,
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
    /**
     * Moves the timers and waits for the runs the tick started: a fire marks the
     * run in `routines.json` under the file's lock, and a test that only advanced
     * the clock would read that file while the write is still in flight.
     */
    advance: async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms)
      await scheduler.settle()
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
    await seedRoutines([sample()])
    const h = harness()
    h.scheduler.start()

    h.advanceClock(60_000)
    await h.advance(61_000)

    expect(h.prompts).toEqual(['look at the repo'])
    // The name travels as data, not as the first line of the answer: a surface that
    // draws a head signs the delivery with it, and one that can only draw words puts
    // it above the words — neither says it twice.
    expect(h.delivered).toEqual([{
      id: 'calm-otter-1',
      text: 'ok',
      routine: { name: 'briefing', at: new Date(2026, 8, 25, 8, 0, 30).getTime() },
    }])
    expect(readRoutines()[0]).toMatchObject({ lastResult: 'ok' })
    expect(readRoutines()[0]!.lastRunAt).toBeGreaterThan(0)
    h.scheduler.stop()
  })

  it('stops itself once it has run as many times as it was allowed', async () => {
    await seedRoutines([sample({ when: every(1), limit: 2 })])
    const h = harness()
    h.scheduler.start()

    h.advanceClock(60_000)
    await h.advance(61_000)
    h.advanceClock(60_000)
    await h.advance(61_000)

    expect(h.prompts).toEqual(['look at the repo', 'look at the repo'])
    // The second run was the last it was allowed, so it is off now — not merely never
    // due again, which would leave it looking switched on everywhere.
    expect(readRoutines()[0]).toMatchObject({ enabled: false, runs: 2 })

    h.advanceClock(60_000)
    await h.advance(61_000)
    expect(h.prompts).toHaveLength(2)
    h.scheduler.stop()
  })

  it('does not make up a routine it slept through', async () => {
    // 07:00 has already passed when the daemon comes up at 07:59.
    await seedRoutines([sample({ when: at('07:00') })])
    const h = harness()
    h.scheduler.start()

    h.setClock(new Date(2026, 8, 25, 9, 0, 0))
    await h.advance(120_000)

    expect(h.prompts).toEqual([])
    expect(readRoutines()[0]!.lastRunAt).toBeUndefined()
    h.scheduler.stop()
  })

  it('does not fire a burst of the occurrences it slept through', async () => {
    // Every minute, and the machine then sleeps for ten: the timer that was armed
    // fires once, late, with ten occurrences behind it.
    await seedRoutines([sample({ when: every(1) })])
    const h = harness()
    h.scheduler.start()

    // The timer that was armed fires once, late: ten occurrences are behind it.
    h.setClock(new Date(2026, 8, 25, 8, 10, 0))
    await h.advance(60_000)
    // Then the loop re-arms each tick, one second apart, the way it would while
    // the run is going. One occurrence is owed, not one per second of the gap.
    for (let tick = 0; tick < 10; tick += 1) await h.advance(1_000)

    expect(h.prompts).toHaveLength(1)
    h.scheduler.stop()
  })

  it('runs an interval routine once per occurrence, never twice for one', async () => {
    await seedRoutines([sample({ when: every(1) })])
    const h = harness()
    h.scheduler.start()

    h.setClock(new Date(2026, 8, 25, 8, 0, 40))
    await h.advance(120_000)
    expect(h.prompts).toHaveLength(1)

    // More ticks at the same instant: the occurrence already had its turn.
    await h.advance(120_000)
    expect(h.prompts).toHaveLength(1)

    h.setClock(new Date(2026, 8, 25, 8, 1, 40))
    await h.advance(120_000)
    expect(h.prompts).toHaveLength(2)
    h.scheduler.stop()
  })

  it('leaves a disabled routine alone', async () => {
    await seedRoutines([sample({ when: every(1), enabled: false })])
    const h = harness()
    h.scheduler.start()

    h.setClock(new Date(2026, 8, 25, 8, 0, 40))
    await h.advance(120_000)

    expect(h.prompts).toEqual([])
    h.scheduler.stop()
  })

  it('skips an occurrence rather than stack it on a run still going', async () => {
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    await seedRoutines([sample({ when: every(1) })])
    const h = harness({ gate })
    h.scheduler.start()

    h.setClock(new Date(2026, 8, 25, 8, 0, 40))
    // The gate keeps the first run going, so these advance the timers without
    // waiting the run out — which is the whole point of the test.
    await vi.advanceTimersByTimeAsync(120_000)
    expect(h.prompts).toHaveLength(1)

    h.setClock(new Date(2026, 8, 25, 8, 1, 40))
    await vi.advanceTimersByTimeAsync(120_000)

    expect(h.prompts).toHaveLength(1)
    expect(h.logs.some((line) => line.includes('skipped'))).toBe(true)

    release()
    await h.advance(10)
    h.scheduler.stop()
  })

  it('says when a routine failed, and marks the run', async () => {
    await seedRoutines([sample({ when: every(1) })])
    const h = harness({ fail: 'boom' })
    h.scheduler.start()

    h.setClock(new Date(2026, 8, 25, 8, 0, 40))
    await h.advance(120_000)

    // What went wrong is the text; the failure is the delivery's own state, which
    // the surface draws in the card's head rather than in the answer.
    expect(h.delivered[0]!.text).toBe('boom')
    expect(h.delivered[0]!.routine).toEqual({
      name: 'briefing',
      at: new Date(2026, 8, 25, 8, 0, 40).getTime(),
      failed: true,
    })
    expect(readRoutines()[0]!.lastResult).toBe('error')
    expect(h.logs.some((line) => line.includes('failed'))).toBe(true)
    h.scheduler.stop()
  })

  it('posts nothing when the routine answered nothing', async () => {
    await seedRoutines([sample({ when: every(1) })])
    const h = harness({ answer: '' })
    h.scheduler.start()

    h.setClock(new Date(2026, 8, 25, 8, 0, 40))
    await h.advance(120_000)

    expect(h.delivered).toEqual([])
    h.scheduler.stop()
  })

  it('tells only a silent routine’s run that it may stay silent, without rewriting the ask', async () => {
    await seedRoutines([
      sample({ when: every(1), silent: true }),
      sample({ id: 'calm-otter-2', name: 'the other', when: every(1) }),
    ])
    const h = harness()
    h.scheduler.start()

    h.setClock(new Date(2026, 8, 25, 8, 0, 40))
    await h.advance(120_000)

    // The instruction rides the system prompt; each prompt is still the person's.
    expect(h.prompts).toEqual(['look at the repo', 'look at the repo'])
    expect(h.asides.filter((aside) => aside?.includes(SILENT))).toHaveLength(1)
    expect(h.asides.filter((aside) => aside === undefined)).toHaveLength(1)
    h.scheduler.stop()
  })

  it('stays silent when a silent routine had nothing to report', async () => {
    await seedRoutines([sample({ when: every(1), silent: true })])
    const h = harness({ answer: SILENT })
    h.scheduler.start()

    h.setClock(new Date(2026, 8, 25, 8, 0, 40))
    await h.advance(120_000)

    expect(h.delivered).toEqual([])
    // The run happened and is on record, which is where the person reads it.
    expect(readRoutines()[0]!.lastResult).toBe('ok')
    h.scheduler.stop()
  })

  it('delivers the marker as words from a routine that was not made silent', async () => {
    await seedRoutines([sample({ when: every(1) })])
    const h = harness({ answer: SILENT })
    h.scheduler.start()

    h.setClock(new Date(2026, 8, 25, 8, 0, 40))
    await h.advance(120_000)

    expect(h.delivered[0]!.text).toBe(SILENT)
    h.scheduler.stop()
  })

  it('sends the file a silent run made, with no words', async () => {
    await seedRoutines([sample({ when: every(1), silent: true })])
    const shot: OutgoingFile = { path: '/tmp/shot.png', name: 'shot.png', mimeType: 'image/png' }
    const h = harness({ answer: SILENT, files: [shot] })
    h.scheduler.start()

    h.setClock(new Date(2026, 8, 25, 8, 0, 40))
    await h.advance(120_000)

    expect(h.delivered).toEqual([{
      id: 'calm-otter-1',
      files: [shot],
      routine: { name: 'briefing', at: new Date(2026, 8, 25, 8, 0, 40).getTime() },
    }])
    h.scheduler.stop()
  })

  it("carries the routine's grants into the run, which is the only place they apply", async () => {
    await seedRoutines([sample({ when: every(1), allow: ['shell_command'] })])
    const h = harness()
    h.scheduler.start()

    h.setClock(new Date(2026, 8, 25, 8, 0, 40))
    await h.advance(120_000)

    expect(h.sessions).toEqual([{
      grantedTools: ['shell_command'],
      deliverTo: { gateway: 'telegram', chatId: '123' },
    }])
    h.scheduler.stop()
  })

  it("tells the run which chat it may send files to, the routine's own target", async () => {
    await seedRoutines([sample({ when: every(1), target: { gateway: 'discord', chatId: '987' } })])
    const h = harness()
    h.scheduler.start()

    h.setClock(new Date(2026, 8, 25, 8, 0, 40))
    await h.advance(120_000)

    expect(h.sessions).toEqual([{ grantedTools: undefined, deliverTo: { gateway: 'discord', chatId: '987' } }])
    h.scheduler.stop()
  })

  it('delivers a file even when the run answered nothing', async () => {
    await seedRoutines([sample({ when: every(1) })])
    const shot: OutgoingFile = { path: '/tmp/shot.png', name: 'shot.png', mimeType: 'image/png' }
    const h = harness({ answer: '', files: [shot] })
    h.scheduler.start()

    h.setClock(new Date(2026, 8, 25, 8, 0, 40))
    await h.advance(120_000)

    expect(h.delivered).toEqual([{
      id: 'calm-otter-1',
      files: [shot],
      // A file with no answer still says which routine sent it.
      routine: { name: 'briefing', at: new Date(2026, 8, 25, 8, 0, 40).getTime() },
    }])
    h.scheduler.stop()
  })

  it('stops firing once stopped', async () => {
    await seedRoutines([sample({ when: every(1) })])
    const h = harness()
    h.scheduler.start()
    h.scheduler.stop()

    h.setClock(new Date(2026, 8, 25, 9, 0, 0))
    await h.advance(600_000)

    expect(h.prompts).toEqual([])
  })
})
