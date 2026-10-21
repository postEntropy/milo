import { describe, expect, it } from 'vitest'
import { chatSessions, isWorkSession, workGroups } from '../web/src/sessions/scopes.js'
import type { ProjectView } from '../src/core/projects.js'
import type { SessionSummary } from '../web/src/sessions/types.js'

function project(id: string, name = id): ProjectView {
  return { id, name, path: `/tmp/${id}`, createdAt: 0 }
}

function session(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return { id, preview: id, messageCount: 2, updatedAt: 0, ...overrides }
}

describe('a session belongs to the list its project does', () => {
  it('counts one whose project is in the list as work', () => {
    expect(isWorkSession(session('a', { project: 'p1' }), [project('p1')])).toBe(true)
  })

  it('counts one whose project was removed as a chat, so it cannot vanish', () => {
    // `removeProject` leaves the id on every session that ran there; nothing answers to
    // it any more, which is the same thing as a session with no project.
    expect(isWorkSession(session('a', { project: 'gone' }), [project('p1')])).toBe(false)
  })

  it('counts one naming a project as work until the projects have been read', () => {
    expect(isWorkSession(session('a', { project: 'p1' }), null)).toBe(true)
  })

  it('counts one with no project as a chat', () => {
    expect(isWorkSession(session('a'), [project('p1')])).toBe(false)
  })
})

describe('the Chat list', () => {
  it('holds only sessions with words in them, newest first', () => {
    const list = chatSessions(
      [session('old', { updatedAt: 1 }), session('new', { updatedAt: 9 }), session('empty', { messageCount: 0 })],
      [],
    )
    expect(list.map((entry) => entry.id)).toEqual(['new', 'old'])
  })

  it('takes a session whose project is gone, and leaves the projects’ own on the other side', () => {
    const list = chatSessions(
      [
        session('chat', { updatedAt: 1 }),
        session('orphan', { project: 'gone', updatedAt: 2 }),
        session('work', { project: 'p1', updatedAt: 3 }),
      ],
      [project('p1')],
    )
    expect(list.map((entry) => entry.id)).toEqual(['orphan', 'chat'])
  })

  it('narrows by the name, the words or the id', () => {
    const list = chatSessions(
      [session('a', { title: 'Deploy notes' }), session('b', { preview: 'Payroll' }), session('c')],
      [],
      'pay',
    )
    expect(list.map((entry) => entry.id)).toEqual(['b'])
  })
})

describe('the Work list', () => {
  const projects = [project('p1', 'Alpha'), project('p2', 'Beta')]

  it('draws a project’s newest three, and anything running behind them', () => {
    const mine = [
      session('newest', { project: 'p1', updatedAt: 50 }),
      session('second', { project: 'p1', updatedAt: 40 }),
      session('third', { project: 'p1', updatedAt: 30 }),
      session('fourth', { project: 'p1', updatedAt: 20 }),
      session('oldest-running', { project: 'p1', updatedAt: 10, running: true }),
    ]
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

  it('shows a project’s sessions whole when the project is what was searched for', () => {
    const mine = [
      session('a', { project: 'p1', title: 'One' }),
      session('b', { project: 'p1', title: 'Two' }),
    ]
    const [group] = workGroups(mine, projects, 'alph')
    expect(group?.project.id).toBe('p1')
    expect(group?.sessions.map((entry) => entry.id)).toEqual(['a', 'b'])
  })

  it('keeps only the projects whose sessions carry the search', () => {
    const mine = [
      session('deploy', { project: 'p1', title: 'Deploy today' }),
      session('payroll', { project: 'p2', title: 'Payroll' }),
    ]
    const groups = workGroups(mine, projects, 'deploy')
    expect(groups.map((group) => [group.project.id, group.sessions.map((entry) => entry.id)])).toEqual([
      ['p1', ['deploy']],
    ])
  })

  it('answers nothing until the projects have been read', () => {
    expect(workGroups([session('a', { project: 'p1' })], null)).toEqual([])
  })
})
