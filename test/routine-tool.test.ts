import { describe, expect, it } from 'vitest'
import type { NewRoutine, Routine } from '../src/core/routines.js'
import { routineTool } from '../src/core/tools/routine.js'
import type { RoutineStore, ToolContext } from '../src/core/tools/types.js'

const every = (minutes: number) => ({ kind: 'every' as const, minutes })
const at = (time: string, days?: number[]) => ({ kind: 'at' as const, time, days })

/** A routine already in the install's list, for the tests that change or drop one. */
const briefing = (over: Partial<Routine> = {}): Routine => ({
  id: 'calm-otter-1',
  name: 'daily briefing',
  prompt: 'look at the repo',
  when: every(120),
  target: { gateway: 'telegram', conversationId: '123' },
  enabled: true,
  createdAt: 0,
  ...over,
})

interface Harness {
  ctx: ToolContext
  /** What `create` was handed, in order. */
  added: NewRoutine[]
  /** What `update` was handed, in order. */
  updated: Array<{ id: string; patch: Partial<Omit<Routine, 'id' | 'createdAt'>> }>
  /** The ids `remove` was handed, in order. */
  removed: string[]
}

/** An in-memory list behind the store, so a test reads back what the tool asked for. */
function harness(over: Partial<ToolContext> = {}, fail?: string, seed: Routine[] = []): Harness {
  const added: NewRoutine[] = []
  const updated: Array<{ id: string; patch: Partial<Omit<Routine, 'id' | 'createdAt'>> }> = []
  const removed: string[] = []
  let routines = seed
  const store: RoutineStore = {
    list: () => routines,
    async create(input) {
      if (fail) throw new Error(fail)
      added.push(input)
      const routine = { ...input, id: 'calm-otter-9', createdAt: 0 } as Routine
      routines = [...routines, routine]
      return routine
    },
    async update(id, patch) {
      updated.push({ id, patch })
      const target = routines.find((routine) => routine.id === id)
      if (!target) return undefined
      const next = { ...target, ...patch, id: target.id, createdAt: target.createdAt }
      routines = routines.map((routine) => (routine.id === id ? next : routine))
      return next
    },
    async remove(id) {
      removed.push(id)
      const kept = routines.filter((routine) => routine.id !== id)
      const found = kept.length !== routines.length
      routines = kept
      return found
    },
  }
  const ctx: ToolContext = {
    cwd: process.cwd(),
    signal: new AbortController().signal,
    routine: store,
    ...over,
  }
  return { ctx, added, updated, removed }
}

describe('the routine tool', () => {
  it('turns "every two hours" into an interval aimed at the current chat', async () => {
    const { ctx, added } = harness({ origin: { gateway: 'telegram', conversationId: '123' } })

    const result = await routineTool.execute({ prompt: 'look at the repo', every: '2h' }, ctx)

    expect(result.isError).toBeFalsy()
    expect(added).toEqual([
      {
        prompt: 'look at the repo',
        name: undefined,
        when: { kind: 'every', minutes: 120 },
        target: { gateway: 'telegram', conversationId: '123' },
        enabled: true,
      },
    ])
    // The resolved time is said back, so a wrong hour is caught before it fires.
    expect(result.content).toContain('every 2h')
    expect(result.content).toContain('telegram:123')
    expect(result.content).toContain('milo routines remove calm-otter-9')
  })

  it('reads weekday mornings, and aims them at the chat they came from', async () => {
    const { ctx, added } = harness({
      origin: { gateway: 'discord', conversationId: '999' },
    })

    const result = await routineTool.execute(
      { prompt: 'briefing', name: 'daily briefing', at: '8h', days: ['mon-fri'] },
      ctx,
    )

    expect(result.isError).toBeFalsy()
    expect(added[0]!.when).toEqual({ kind: 'at', time: '08:00', days: [1, 2, 3, 4, 5] })
    expect(added[0]!.target).toEqual({ gateway: 'discord', conversationId: '999' })
    expect(result.content).toContain('08:00, mon–fri')
  })

  it('reads a date, and says the day and the month back', async () => {
    const { ctx, added } = harness({ origin: { gateway: 'telegram', conversationId: '123' } })

    const result = await routineTool.execute(
      { prompt: 'briefing', at: '9h', dayOfMonth: ['25'], month: ['dec'] },
      ctx,
    )

    expect(result.isError).toBeFalsy()
    expect(added[0]!.when).toEqual({ kind: 'at', time: '09:00', dayOfMonth: [25], month: [12] })
    expect(result.content).toContain('09:00, day 25 of December')
  })

  it('refuses a weekday and a day of the month together, and says the valid shapes', async () => {
    const { ctx, added } = harness({ origin: { gateway: 'telegram', conversationId: '123' } })

    const result = await routineTool.execute({ prompt: 'x', at: '9h', days: ['mon'], dayOfMonth: ['1'] }, ctx)

    expect(result.isError).toBe(true)
    expect(result.content).toContain('not a time I can set')
    expect(added).toEqual([])
  })

  it('carries the tools a writing routine needs, and says what it was granted', async () => {
    const { ctx, added } = harness({ origin: { gateway: 'telegram', conversationId: '123' } })

    const result = await routineTool.execute(
      { prompt: 'append the tick to the csv', every: '1m', allow: ['shell_command', 'write_file'] },
      ctx,
    )

    expect(result.isError).toBeFalsy()
    expect(added[0]!.allow).toEqual(['shell_command', 'write_file'])
    expect(result.content).toContain('may use shell_command, write_file')
  })

  it('asks for no grant when the routine only reads', async () => {
    const { ctx } = harness({ origin: { gateway: 'telegram', conversationId: '123' } })

    // The policy reads this to decide whether the call needs a confirmation.
    expect(routineTool.asksWhen?.({ prompt: 'x', every: '1h' })).toBe(false)
    expect(routineTool.asksWhen?.({ prompt: 'x', every: '1h', allow: ['shell_command'] })).toBe(true)
    expect((await routineTool.execute({ prompt: 'x', every: '1h' }, ctx)).isError).toBeFalsy()
  })

  it('lets an explicit destination win over where the turn came from', async () => {
    const { ctx, added } = harness({ origin: { gateway: 'telegram', conversationId: '123' } })

    await routineTool.execute(
      { prompt: 'x', every: '1h', gateway: 'discord', conversationId: '42' },
      ctx,
    )

    expect(added[0]!.target).toEqual({ gateway: 'discord', conversationId: '42' })
  })

  it('asks which chat when the turn cannot receive one', async () => {
    const { ctx, added } = harness({ origin: { gateway: 'cli', conversationId: 'main' } })

    const result = await routineTool.execute({ prompt: 'x', every: '1h' }, ctx)

    expect(result.isError).toBe(true)
    expect(result.content).toContain('gateway')
    expect(added).toEqual([])
  })

  it('refuses half a destination rather than guessing the other half', async () => {
    const { ctx, added } = harness({ origin: { gateway: 'telegram', conversationId: '123' } })

    const result = await routineTool.execute({ prompt: 'x', every: '1h', gateway: 'discord' }, ctx)

    expect(result.isError).toBe(true)
    expect(added).toEqual([])
  })

  it('refuses a time it cannot read, and says so', async () => {
    const { ctx, added } = harness({ origin: { gateway: 'telegram', conversationId: '123' } })

    const result = await routineTool.execute({ prompt: 'x', at: 'some day' }, ctx)

    expect(result.isError).toBe(true)
    expect(added).toEqual([])
  })

  it('fails cleanly where there is nothing to file a routine in', async () => {
    const ctx: ToolContext = { cwd: process.cwd(), signal: new AbortController().signal }

    const result = await routineTool.execute({ prompt: 'x', every: '1h' }, ctx)

    expect(result.isError).toBe(true)
    expect(result.content).toContain('not available')
  })

  it('surfaces the store refusing, rather than claiming success', async () => {
    const { ctx } = harness({ origin: { gateway: 'telegram', conversationId: '123' } }, 'at most 50')

    const result = await routineTool.execute({ prompt: 'x', every: '1h' }, ctx)

    expect(result.isError).toBe(true)
    expect(result.content).toContain('at most 50')
  })
})

describe('the routine tool changing and dropping one', () => {
  it('lists what is there, with the ids to act on', async () => {
    const { ctx } = harness({}, undefined, [briefing()])

    const result = await routineTool.execute({ action: 'list' }, ctx)

    expect(result.isError).toBeFalsy()
    expect(result.content).toContain('calm-otter-1')
    expect(result.content).toContain('daily briefing')
    expect(result.content).toContain('every 2h')
    expect(result.content).toContain('telegram:123')
  })

  it('says there are none rather than listing nothing', async () => {
    const { ctx } = harness()

    const result = await routineTool.execute({ action: 'list' }, ctx)

    expect(result.content).toBe('No routines yet.')
  })

  it('moves a routine to a new time, named by its id', async () => {
    const { ctx, updated } = harness({}, undefined, [briefing()])

    const result = await routineTool.execute(
      { action: 'update', id: 'calm-otter-1', at: '09:00', days: ['mon-fri'] },
      ctx,
    )

    expect(result.isError).toBeFalsy()
    expect(updated).toEqual([{ id: 'calm-otter-1', patch: { when: at('09:00', [1, 2, 3, 4, 5]) } }])
    expect(result.content).toContain('09:00, mon–fri')
  })

  it('changes only the fields it was given', async () => {
    const { ctx, updated } = harness({}, undefined, [briefing()])

    await routineTool.execute({ action: 'update', id: 'calm-otter-1', enabled: false }, ctx)

    expect(updated[0]!.patch).toEqual({ enabled: false })
  })

  it('restates the schedule whole: days left out are not carried over', async () => {
    const { ctx, updated } = harness({}, undefined, [briefing({ when: at('08:00', [1, 2, 3, 4, 5]) })])

    await routineTool.execute({ action: 'update', id: 'calm-otter-1', at: '09:00' }, ctx)

    expect(updated[0]!.patch).toEqual({ when: at('09:00') })
  })

  it('moves a routine to another chat, or to none at all', async () => {
    const { ctx, updated } = harness({}, undefined, [briefing()])

    await routineTool.execute(
      { action: 'update', id: 'calm-otter-1', gateway: 'discord', conversationId: '42' },
      ctx,
    )
    expect(updated[0]!.patch).toEqual({ target: { gateway: 'discord', conversationId: '42' } })

    await routineTool.execute({ action: 'update', id: 'calm-otter-1', gateway: 'none' }, ctx)
    expect(updated[1]!.patch).toEqual({ target: { gateway: 'none' } })
  })

  it('needs an id, and says how to find one', async () => {
    const { ctx, updated } = harness({}, undefined, [briefing()])

    const result = await routineTool.execute({ action: 'update', enabled: false }, ctx)

    expect(result.isError).toBe(true)
    expect(result.content).toContain('action: "list"')
    expect(updated).toEqual([])
  })

  it('refuses an id it does not have', async () => {
    const { ctx, updated } = harness({}, undefined, [briefing()])

    const result = await routineTool.execute({ action: 'update', id: 'nobody-here-1', enabled: false }, ctx)

    expect(result.isError).toBe(true)
    expect(result.content).toContain('No routine nobody-here-1')
    expect(updated).toEqual([])
  })

  it('refuses half a destination rather than guessing the other half', async () => {
    const { ctx, updated } = harness({}, undefined, [briefing()])

    const result = await routineTool.execute({ action: 'update', id: 'calm-otter-1', gateway: 'discord' }, ctx)

    expect(result.isError).toBe(true)
    expect(updated).toEqual([])
  })

  it('removes the one that was named', async () => {
    const { ctx, removed } = harness({}, undefined, [briefing()])

    const result = await routineTool.execute({ action: 'remove', id: 'calm-otter-1' }, ctx)

    expect(result.isError).toBeFalsy()
    expect(removed).toEqual(['calm-otter-1'])
    expect(result.content).toContain('daily briefing')
  })

  it('asks before it drops one, and never for a read', () => {
    expect(routineTool.asksWhen?.({ action: 'remove', id: 'calm-otter-1' })).toBe(true)
    expect(routineTool.asksWhen?.({ action: 'list' })).toBe(false)
    expect(routineTool.asksWhen?.({ action: 'update', id: 'x', enabled: false })).toBe(false)
    expect(routineTool.asksWhen?.({ action: 'update', id: 'x', allow: ['shell_command'] })).toBe(true)
  })
})
