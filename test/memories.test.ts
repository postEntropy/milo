import { describe, expect, it } from 'vitest'
import { DEFAULT_LIST_LIMIT } from '../src/core/memory/index.js'
import type { MemoryItem } from '../src/core/memory/types.js'
import { memoriesTool } from '../src/core/tools/memories.js'
import { DefaultPermissionPolicy } from '../src/core/tools/permission.js'
import type { ToolContext } from '../src/core/tools/types.js'

const notes: MemoryItem[] = [
  { id: 'a1b2c3d4-0000-0000-0000-000000000000', text: 'meu editor é o Neovim', createdAt: 1_700_000_000_000 },
  { id: 'e5f6a7b8-1111-1111-1111-111111111111', text: 'uso Omarchy no Linux', createdAt: 1_600_000_000_000 },
]

function contextWithStore(
  stored: MemoryItem[] = notes,
  dropFor: (id: string) => boolean = (id) => stored.some((note) => note.id.startsWith(id)),
): { ctx: ToolContext; asked: string[][] } {
  const asked: string[][] = []
  return {
    asked,
    ctx: {
      cwd: process.cwd(),
      signal: new AbortController().signal,
      memories: {
        list: async (opts) => {
          const offset = opts?.offset ?? 0
          return stored.slice(offset, offset + (opts?.limit ?? DEFAULT_LIST_LIMIT))
        },
        forget: async (ids) => {
          asked.push(ids)
          return { forgotten: ids.filter(dropFor), unknown: ids.filter((id) => !dropFor(id)) }
        },
      },
    },
  }
}

describe('memories', () => {
  it('lists what is kept, each note with the front of its id', async () => {
    const { ctx } = contextWithStore()

    const result = await memoriesTool.execute({}, ctx)

    expect(result.isError).toBeFalsy()
    expect(result.content).toContain('Notes I keep (2 shown, offset 0, most recent first)')
    expect(result.content).toContain('- a1b2c3d4  ')
    expect(result.content).toContain('meu editor é o Neovim')
    expect(result.content).toContain('uso Omarchy no Linux')
    expect(result.content).toContain('That is the end of the list (2 note(s)).')
  })

  it('pages: a full page points at the offset for the next one', async () => {
    const three: MemoryItem[] = [
      { id: 'aaaaaaaa-0000', text: 'um', createdAt: 3 },
      { id: 'bbbbbbbb-0000', text: 'dois', createdAt: 2 },
      { id: 'cccccccc-0000', text: 'tres', createdAt: 1 },
    ]
    const { ctx } = contextWithStore(three)

    const first = await memoriesTool.execute({ limit: 2 }, ctx)
    expect(first.content).toContain('2 shown, offset 0')
    expect(first.content).toContain('read the next page with offset 2')
    expect(first.content).not.toContain('tres')

    const second = await memoriesTool.execute({ limit: 2, offset: 2 }, ctx)
    expect(second.content).toContain('1 shown, offset 2')
    expect(second.content).toContain('tres')
    expect(second.content).toContain('That is the end of the list (3 note(s))')
  })

  it('says there is nothing past the offset', async () => {
    const { ctx } = contextWithStore()

    const result = await memoriesTool.execute({ offset: 5 }, ctx)

    expect(result.content).toBe('No notes at offset 5 — that is the end.')
  })

  it('says nothing is remembered rather than an empty list', async () => {
    const { ctx } = contextWithStore([])

    const result = await memoriesTool.execute({ action: 'list' }, ctx)

    expect(result.content).toBe('Nothing is remembered yet.')
  })

  it('forgets the notes whose ids it is given', async () => {
    const { ctx, asked } = contextWithStore()

    const result = await memoriesTool.execute(
      { action: 'forget', ids: ['a1b2c3d4', 'e5f6a7b8'] },
      ctx,
    )

    expect(result.content).toBe('Forgot 2 note(s).')
    expect(asked).toEqual([['a1b2c3d4', 'e5f6a7b8']])
  })

  it('says which ids matched nothing instead of claiming the deletion', async () => {
    const { ctx } = contextWithStore()

    const result = await memoriesTool.execute({ action: 'forget', ids: ['a1b2c3d4', 'deadbeef'] }, ctx)

    expect(result.content).toContain('Forgot 1 note(s)')
    expect(result.content).toContain('deadbeef')
  })

  it('fails when no id matched at all', async () => {
    const { ctx } = contextWithStore()

    const result = await memoriesTool.execute({ action: 'forget', ids: ['deadbeef'] }, ctx)

    expect(result.isError).toBe(true)
    expect(result.content).toContain('No note matched')
  })

  it('asks which one when a forget names no id', async () => {
    const { ctx, asked } = contextWithStore()

    const result = await memoriesTool.execute({ action: 'forget' }, ctx)

    expect(result.isError).toBe(true)
    expect(result.content).toContain('Which one?')
    expect(asked).toEqual([])
  })

  it('fails cleanly on a context with no memory behind it', async () => {
    const ctx: ToolContext = { cwd: process.cwd(), signal: new AbortController().signal }

    const result = await memoriesTool.execute({}, ctx)

    expect(result.isError).toBe(true)
    expect(result.content).toContain('Memory is not available')
  })

  it('asks before a note is dropped, but not before the list is read', async () => {
    const policy = new DefaultPermissionPolicy()

    expect(memoriesTool.readOnly).toBeFalsy()
    expect(await policy.decide(memoriesTool, { action: 'list' })).toBe('allow')
    expect(await policy.decide(memoriesTool, {})).toBe('allow')
    expect(await policy.decide(memoriesTool, { action: 'forget', ids: ['x'] })).toBe('ask')
  })

  it('keeps itself apart from `recall`, which looks up a conversation', () => {
    // The two are one word apart in the catalog and answer different questions;
    // the description has to say which is which or the wrong one gets called.
    expect(memoriesTool.description).toMatch(/recall/)
  })
})
