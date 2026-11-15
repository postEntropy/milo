import type { SessionSummary } from './types.js'

/** What a row is found by: the same three fields the drawer's search has always read. */
function matches(session: SessionSummary, query: string): boolean {
  return session.searchText?.includes(query) === true
}

/**
 * All Sessions, with or without a folder, newest first.
 */
export function chatSessions(
  sessions: SessionSummary[],
  query = '',
): SessionSummary[] {
  const asked = query.trim().toLowerCase()
  return sessions
    .filter((session) => (session.messageCount > 0 || session.backend?.kind === 'command-code'))
    .filter((session) => asked === '' || matches(session, asked))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}
