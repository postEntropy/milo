import type { ProjectView } from '../../../src/core/projects.js'
import type { SessionSummary } from './types.js'
import { inlineSessions } from '../work/sessions.js'

/**
 * Whether a session is work. It is the project it names that decides — not the
 * presence of an id: a project removed from the list leaves its sessions bound to
 * an id nothing answers to any more, and those are sessions with no project to be
 * in. Counting them as work would take them out of both lists, which is a session
 * disappearing.
 *
 * While the projects have not been read yet, anything naming one is treated as
 * work: it may be, and showing it under the wrong roof is worse than a beat of
 * nothing. The Work side says it is still reading.
 */
export function isWorkSession(session: SessionSummary, projects: ProjectView[] | null): boolean {
  if (!session.project) return false
  if (projects === null) return true
  return projects.some((project) => project.id === session.project)
}

/** What a row is found by: the same three fields the drawer's search has always read. */
function matches(session: SessionSummary, query: string): boolean {
  return `${session.title ?? ''} ${session.preview} ${session.id}`.toLowerCase().includes(query)
}

/**
 * The Chat side of the list: sessions working in Milo's own folder, with something
 * said in them, newest first. The projects' sessions live on the other side.
 */
export function chatSessions(
  sessions: SessionSummary[],
  projects: ProjectView[] | null,
  query = '',
): SessionSummary[] {
  const asked = query.trim().toLowerCase()
  return sessions
    .filter((session) => session.messageCount > 0 && !isWorkSession(session, projects))
    .filter((session) => asked === '' || matches(session, asked))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/** One project of the Work side: its newest sessions, and how many it holds in all. */
type WorkGroup = {
  project: ProjectView
  /** The rows drawn: three at most, plus anything running or unread. */
  sessions: SessionSummary[]
  /** Every session the project holds, drawn or folded — what "All N sessions" answers. */
  total: number
}

/**
 * The Work side of the list: every project, in the daemon's own order, with its
 * newest sessions under it. A project with nothing in it is its own row alone, and
 * a project whose folder is gone still lists — the row says why.
 *
 * A search keeps a project when its own name carries the query (and then shows its
 * sessions whole, since the project is what was asked for) or when any of its
 * sessions do.
 */
export function workGroups(
  sessions: SessionSummary[],
  projects: ProjectView[] | null,
  query = '',
): WorkGroup[] {
  if (projects === null) return []
  const asked = query.trim().toLowerCase()
  const groups: WorkGroup[] = []
  for (const project of projects) {
    const mine = sessions
      .filter((session) => session.project === project.id)
      .sort((a, b) => b.updatedAt - a.updatedAt)
    const named = asked !== '' && project.name.toLowerCase().includes(asked)
    const matching = asked === '' || named ? mine : mine.filter((session) => matches(session, asked))
    if (asked !== '' && !named && matching.length === 0) continue
    groups.push({ project, sessions: inlineSessions(matching), total: mine.length })
  }
  return groups
}
