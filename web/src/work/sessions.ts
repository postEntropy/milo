import type { SessionSummary } from '../sessions/types.js'

/** How many of a project's sessions the index and the drawer draw before the rest. */
const SESSIONS_SHOWN = 3

/**
 * The newest few, plus any session still running or still unread: work in flight
 * and work waiting to be read are never hidden behind a count, however long either
 * has been going. The list is sorted here so the cut is the newest whatever order
 * the caller carried.
 */
export function inlineSessions(sessions: SessionSummary[], limit = SESSIONS_SHOWN): SessionSummary[] {
  const newest = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)
  const shown = newest.slice(0, limit)
  const waiting = newest.slice(limit).filter((session) => session.running || session.unread)
  return [...shown, ...waiting].sort((a, b) => b.updatedAt - a.updatedAt)
}
