import { tokenize } from '../memory/local.js'
import type { RecapStore } from './recap.js'
import type { SessionSummary } from './types.js'

/**
 * The recaps joined back onto a listing. A recap is only shown while it matches
 * the transcript it was written from: one left behind by an older transcript
 * describes a conversation that is no longer there.
 */
export async function withRecaps(
  sessions: SessionSummary[],
  recaps: RecapStore,
): Promise<SessionSummary[]> {
  return Promise.all(
    sessions.map(async (session) => {
      const recap = await recaps.read(session.id)
      return recap && recap.sourceUpdatedAt === session.updatedAt
        ? { ...session, recap: recap.text }
        : session
    }),
  )
}

/**
 * The sessions a question is about, best first: keyword overlap over what each
 * one left behind — its recap, its title, its first words — with a recency
 * bonus allowed to reorder but never to qualify. The same rule memory recall
 * follows: a session that shares no word with the question does not come back
 * for being recent, because recall that answers everything with the latest
 * conversation is worse than one that answers nothing.
 */
export function rankSessions(
  sessions: SessionSummary[],
  query: string,
  limit = 5,
): SessionSummary[] {
  const queryTokens = tokenize(query)
  if (queryTokens.size === 0) return []
  const now = Date.now()

  return sessions
    .map((session) => {
      const tokens = tokenize(
        [session.id, session.title ?? '', session.recap ?? '', session.preview].join('\n'),
      )
      let overlap = 0
      for (const token of queryTokens) if (tokens.has(token)) overlap += 1
      const ageDays = Math.max(0, (now - session.updatedAt) / 86_400_000)
      return { session, score: overlap + (1 / (1 + ageDays)) * 0.5 }
    })
    .filter((hit) => hit.score > 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((hit) => hit.session)
}
