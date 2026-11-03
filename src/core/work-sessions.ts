import type { ProjectView } from './projects.js'
import type { SessionSummary } from './sessions/types.js'

/** The session placement and visibility every client draws for Work. */
export type WorkSessionSummary = SessionSummary & {
  work: boolean
  workInline: boolean
  searchText: string
}

/**
 * Attach Work's shared list decisions to the session data at the daemon boundary.
 * The web app and phone render these facts instead of independently deciding which
 * sessions belong to Work or which ones stay visible in a project's short list.
 */
export function placeWorkSessions(
  sessions: SessionSummary[],
  projects: readonly ProjectView[],
  limit = 3,
): WorkSessionSummary[] {
  const projectIds = new Set(projects.map((project) => project.id))
  const visible = new Set<string>()

  for (const project of projects) {
    const mine = sessions
      .filter((session) => session.project === project.id)
      .sort((a, b) => b.updatedAt - a.updatedAt)
    for (const session of mine.slice(0, limit)) visible.add(session.id)
    for (const session of mine.slice(limit)) {
      if (session.running || session.unread) visible.add(session.id)
    }
  }

  return sessions.map((session) => ({
    ...session,
    work: Boolean(session.project && projectIds.has(session.project)),
    workInline: visible.has(session.id),
    searchText: `${session.title ?? ''} ${session.preview} ${session.id}`.toLowerCase(),
  }))
}
