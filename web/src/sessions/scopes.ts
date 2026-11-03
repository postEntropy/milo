import type { ProjectView } from '../../../src/core/projects.js'
import type { SessionSummary } from './types.js'

/**
 * The daemon decides which side owns a session.
 */
export function isWorkSession(session: SessionSummary): boolean {
  return session.work === true
}

/** What a row is found by: the same three fields the drawer's search has always read. */
function matches(session: SessionSummary, query: string): boolean {
  return session.searchText?.includes(query) === true
}

/**
 * The Chat side of the list: sessions working in Milo's own folder, with something
 * said in them, newest first. The projects' sessions live on the other side.
 */
export function chatSessions(
  sessions: SessionSummary[],
  query = '',
): SessionSummary[] {
  const asked = query.trim().toLowerCase()
  return sessions
    .filter((session) => session.messageCount > 0 && !isWorkSession(session))
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
    const shown = asked ? matching : matching.filter((session) => session.workInline)
    groups.push({ project, sessions: shown, total: mine.length })
  }
  return groups
}
