import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '../src/core/sessions/types.js'
import { sessionsTool } from '../src/core/tools/index.js'
import type { SessionAdmin } from '../src/core/tools/types.js'

function summary(id: string, extra: Partial<SessionSummary> = {}): SessionSummary {
  // The name a row would show, by the rule the daemon composes it with.
  const label = extra.title ?? extra.preview ?? extra.recap ?? 'New session'
  return { id, createdAt: 1, updatedAt: 1, messageCount: 2, preview: '', label, ...extra }
}

/** A store holding two sessions, recording what was actually removed. */
function fake(overrides: Partial<SessionAdmin> = {}): SessionAdmin & { removed: string[] } {
  const removed: string[] = []
  const sessions = [
    summary('calm-otter-7', { preview: 'the auth work' }),
    summary('brave-fox-2', { recap: '- styled the settings screen' }),
  ]
  return {
    current: 'calm-otter-7',
    removed,
    list: async () => sessions,
    remove: async (id) => {
      const hit = sessions.some((session) => session.id === id)
      if (hit) removed.push(id)
      return hit
    },
    ...overrides,
  }
}

const ctx = (sessionAdmin?: SessionAdmin) => ({
  cwd: process.cwd(),
  signal: new AbortController().signal,
  ...(sessionAdmin ? { sessionAdmin } : {}),
})

describe('sessions tool', () => {
  it('lists the saved sessions with what each was about', async () => {
    const result = await sessionsTool.execute({ action: 'list' }, ctx(fake()))

    expect(result.content).toContain('calm-otter-7')
    expect(result.content).toContain('brave-fox-2')
    expect(result.content).toContain('styled the settings screen')
  })

  it('reads the list when no action is given', async () => {
    const result = await sessionsTool.execute({}, ctx(fake()))
    expect(result.content).toContain('Sessions (')
  })

  it('removes a named session and says so', async () => {
    const admin = fake()
    const result = await sessionsTool.execute({ action: 'remove', id: 'brave-fox-2' }, ctx(admin))

    expect(admin.removed).toEqual(['brave-fox-2'])
    expect(result.content).toContain('Removed brave-fox-2')
    expect(result.isError).toBeFalsy()
  })

  it('refuses to remove the session it is running in', async () => {
    const admin = fake()
    const result = await sessionsTool.execute({ action: 'remove', id: 'calm-otter-7' }, ctx(admin))

    expect(admin.removed).toEqual([])
    expect(result.content).toContain('the session I am in')
  })

  it('answers an unknown id instead of failing', async () => {
    const admin = fake()
    const result = await sessionsTool.execute({ action: 'remove', id: 'ghost-9' }, ctx(admin))

    expect(admin.removed).toEqual([])
    expect(result.content).toContain('No session "ghost-9"')
    expect(result.isError).toBeFalsy()
  })

  it('answers the valid ids when remove is given none', async () => {
    const result = await sessionsTool.execute({ action: 'remove' }, ctx(fake()))
    expect(result.content).toContain('Which one?')
  })

  it('says so when nothing is saved', async () => {
    const admin = fake({ list: async () => [] })
    const result = await sessionsTool.execute({ action: 'list' }, ctx(admin))
    expect(result.content).toBe('No saved sessions yet.')
  })

  it('fails cleanly where sessions are not available', async () => {
    const result = await sessionsTool.execute({ action: 'list' }, ctx())
    expect(result.isError).toBe(true)
  })
})
