import { describe, expect, it } from 'vitest'
import type { MemoryInput } from '../src/core/memory/types'
import { DefaultPermissionPolicy } from '../src/core/tools/permission'
import { rememberTool } from '../src/core/tools/remember'
import type { ToolContext } from '../src/core/tools/types'

function contextWithSink(): { ctx: ToolContext; saved: MemoryInput[] } {
  const saved: MemoryInput[] = []
  return {
    saved,
    ctx: {
      cwd: process.cwd(),
      signal: new AbortController().signal,
      remember: async (items) => {
        saved.push(...items)
      },
    },
  }
}

describe('remember', () => {
  it('hands the facts to the memory behind the session', async () => {
    const { ctx, saved } = contextWithSink()

    const result = await rememberTool.execute(
      { facts: ['Renato prefers tabs over spaces'] },
      ctx,
    )

    expect(result.isError).toBeFalsy()
    expect(result.content).toBe('Remembered 1 fact(s).')
    expect(saved).toEqual([{ text: 'Renato prefers tabs over spaces', tags: ['assistant'] }])
  })

  it('saves a batch in one call', async () => {
    const { ctx, saved } = contextWithSink()

    await rememberTool.execute({ facts: ['a', 'b', 'c'], tags: ['project'] }, ctx)

    expect(saved).toHaveLength(3)
    expect(saved[0]?.tags).toEqual(['project'])
  })

  it('trims each fact and drops the empty ones', async () => {
    const { ctx, saved } = contextWithSink()

    const result = await rememberTool.execute({ facts: ['  spaced  ', '   '] }, ctx)

    expect(saved.map((item) => item.text)).toEqual(['spaced'])
    expect(result.content).toBe('Remembered 1 fact(s).')
  })

  it('refuses when every fact is blank', async () => {
    const { ctx, saved } = contextWithSink()

    const result = await rememberTool.execute({ facts: ['   '] }, ctx)

    expect(result.isError).toBe(true)
    expect(result.content).toContain('Nothing to remember')
    expect(saved).toEqual([])
  })

  it('fails cleanly on a context with no memory behind it', async () => {
    const ctx: ToolContext = { cwd: process.cwd(), signal: new AbortController().signal }

    const result = await rememberTool.execute({ facts: ['x'] }, ctx)

    expect(result.isError).toBe(true)
    expect(result.content).toContain('Memory is not available')
  })

  it('never asks for confirmation', async () => {
    expect(rememberTool.readOnly).toBeFalsy()
    expect(rememberTool.internal).toBe(true)
    expect(await new DefaultPermissionPolicy().decide(rememberTool, { facts: ['x'] })).toBe('allow')
  })
})
