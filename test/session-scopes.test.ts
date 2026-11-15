import { describe, expect, it } from 'vitest'
import { chatSessions } from '../web/src/sessions/scopes.js'
import { placeWorkSessions } from '../src/core/work-sessions.js'
import type { ProjectView } from '../src/core/projects.js'
import type { SessionSummary } from '../web/src/sessions/types.js'

function project(id: string, name = id): ProjectView {
  return { id, name, path: `/tmp/${id}`, createdAt: 0 }
}

function session(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    label: id,
    preview: id,
    searchText: ` ${id}`.toLowerCase(),
    createdAt: 0,
    messageCount: 2,
    updatedAt: 0,
    work: false,
    workInline: false,
    ...overrides,
  }
}

describe('the daemon places sessions for every surface', () => {
  it('marks only sessions whose project is still registered as work', () => {
    const placed = placeWorkSessions([
      session('known', { project: 'p1' }),
      session('removed', { project: 'gone' }),
      session('chat'),
    ], [project('p1')])
    expect(placed.map(({ id, work }) => [id, work])).toEqual([
      ['known', true],
      ['removed', false],
      ['chat', false],
    ])
  })

  it('makes the newest three plus running or unread sessions visible on every client', () => {
    const placed = placeWorkSessions([
      session('newest', { project: 'p1', updatedAt: 50 }),
      session('second', { project: 'p1', updatedAt: 40 }),
      session('third', { project: 'p1', updatedAt: 30 }),
      session('fourth', { project: 'p1', updatedAt: 20 }),
      session('oldest-running', { project: 'p1', updatedAt: 10, running: true }),
    ], [project('p1')])
    expect(placed.filter((entry) => entry.workInline).map((entry) => entry.id)).toEqual([
      'newest', 'second', 'third', 'oldest-running',
    ])
  })
})

describe('the unified Session list', () => {
  it('holds only sessions with words in them, newest first', () => {
    const list = chatSessions(
      [session('old', { updatedAt: 1 }), session('new', { updatedAt: 9 }), session('empty', { messageCount: 0 })],
    )
    expect(list.map((entry) => entry.id)).toEqual(['new', 'old'])
  })

  it('includes folder Sessions and Sessions whose folder was removed', () => {
    const list = chatSessions(
      [
        session('chat', { updatedAt: 1 }),
        session('orphan', { project: 'gone', updatedAt: 2 }),
        session('work', { project: 'p1', work: true, updatedAt: 3 }),
      ],
    )
    expect(list.map((entry) => entry.id)).toEqual(['work', 'orphan', 'chat'])
  })

  it('narrows by the name, the words or the id', () => {
    const list = chatSessions(
      placeWorkSessions([
        session('a', { title: 'Deploy notes' }),
        session('b', { preview: 'Payroll' }),
        session('c'),
      ], []),
      'pay',
    )
    expect(list.map((entry) => entry.id)).toEqual(['b'])
  })
})
