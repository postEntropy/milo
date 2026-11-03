import { describe, expect, it } from 'vitest'
import { chatSessions, isWorkSession, workGroups } from '../web/src/sessions/scopes.js'
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
    expect(isWorkSession(placed[0]!)).toBe(true)
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

describe('the Chat list', () => {
  it('holds only sessions with words in them, newest first', () => {
    const list = chatSessions(
      [session('old', { updatedAt: 1 }), session('new', { updatedAt: 9 }), session('empty', { messageCount: 0 })],
    )
    expect(list.map((entry) => entry.id)).toEqual(['new', 'old'])
  })

  it('takes a session whose project is gone, and leaves the projects’ own on the other side', () => {
    const list = chatSessions(
      [
        session('chat', { updatedAt: 1 }),
        session('orphan', { project: 'gone', updatedAt: 2 }),
        session('work', { project: 'p1', work: true, updatedAt: 3 }),
      ],
    )
    expect(list.map((entry) => entry.id)).toEqual(['orphan', 'chat'])
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

describe('the Work list', () => {
  const projects = [project('p1', 'Alpha'), project('p2', 'Beta')]

  it('draws a project’s newest three, and anything running behind them', () => {
    const mine = placeWorkSessions([
      session('newest', { project: 'p1', updatedAt: 50 }),
      session('second', { project: 'p1', updatedAt: 40 }),
      session('third', { project: 'p1', updatedAt: 30 }),
      session('fourth', { project: 'p1', updatedAt: 20 }),
      session('oldest-running', { project: 'p1', updatedAt: 10, running: true }),
    ], projects)
    const [group] = workGroups(mine, projects)
    expect(group?.sessions.map((entry) => entry.id)).toEqual(['newest', 'second', 'third', 'oldest-running'])
    expect(group?.total).toBe(5)
  })

  it('keeps a project with no sessions, so its page is still one press away', () => {
    const groups = workGroups([], projects)
    expect(groups.map((group) => [group.project.id, group.sessions.length, group.total])).toEqual([
      ['p1', 0, 0],
      ['p2', 0, 0],
    ])
  })

  it('shows every session that matches a search, even outside the short list', () => {
    const mine = placeWorkSessions([
      session('a', { project: 'p1', title: 'Deploy one', updatedAt: 5 }),
      session('b', { project: 'p1', title: 'Deploy two', updatedAt: 4 }),
      session('c', { project: 'p1', title: 'Deploy three', updatedAt: 3 }),
      session('d', { project: 'p1', title: 'Deploy four', updatedAt: 2 }),
      session('e', { project: 'p1', title: 'Unrelated', updatedAt: 1 }),
    ], projects)
    const [group] = workGroups(mine, projects, 'deploy')
    expect(group?.project.id).toBe('p1')
    expect(group?.sessions.map((entry) => entry.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('shows every session when the project name itself matches', () => {
    const mine = placeWorkSessions([
      session('newest', { project: 'p1', updatedAt: 3 }),
      session('middle', { project: 'p1', updatedAt: 2 }),
      session('oldest', { project: 'p1', updatedAt: 1 }),
    ], projects)
    const [group] = workGroups(mine, projects, 'alpha')
    expect(group?.sessions.map((entry) => entry.id)).toEqual(['newest', 'middle', 'oldest'])
  })

  it('keeps only the projects whose sessions carry the search', () => {
    const mine = placeWorkSessions([
      session('deploy', { project: 'p1', title: 'Deploy today' }),
      session('payroll', { project: 'p2', title: 'Payroll' }),
    ], projects)
    const groups = workGroups(mine, projects, 'deploy')
    expect(groups.map((group) => [group.project.id, group.sessions.map((entry) => entry.id)])).toEqual([
      ['p1', ['deploy']],
    ])
  })

  it('finds an older matching session even when it is outside the unfiltered short list', () => {
    const mine = placeWorkSessions([
      session('latest', { project: 'p1', title: 'Today', updatedAt: 50 }),
      session('second', { project: 'p1', title: 'Yesterday', updatedAt: 40 }),
      session('third', { project: 'p1', title: 'Last week', updatedAt: 30 }),
      session('older-match', { project: 'p1', title: 'Deploy notes', updatedAt: 10 }),
    ], projects)
    const [group] = workGroups(mine, projects, 'deploy')
    expect(group?.sessions.map((entry) => entry.id)).toEqual(['older-match'])
  })

  it('answers nothing until the projects have been read', () => {
    expect(workGroups([session('a', { project: 'p1' })], null)).toEqual([])
  })
})
