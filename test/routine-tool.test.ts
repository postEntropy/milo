import { describe, expect, it } from 'vitest'
import type { NewRoutine, Routine } from '../src/core/routines.js'
import { routineTool } from '../src/core/tools/routine.js'
import type { ToolContext } from '../src/core/tools/types.js'

interface Harness {
  ctx: ToolContext
  added: NewRoutine[]
}

function harness(over: Partial<ToolContext> = {}, fail?: string): Harness {
  const added: NewRoutine[] = []
  const ctx: ToolContext = {
    cwd: process.cwd(),
    signal: new AbortController().signal,
    routine: async (input) => {
      if (fail) throw new Error(fail)
      added.push(input)
      return { ...input, id: 'calm-otter-9', createdAt: 0 } as Routine
    },
    ...over,
  }
  return { ctx, added }
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
