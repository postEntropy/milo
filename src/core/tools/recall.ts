import { z } from 'zod'
import { ROUTINE_GATEWAY } from '../routines.js'
import { formatWhen } from '../time.js'
import type { SessionSummary } from '../sessions/types.js'
import type { Tool, ToolContext } from './types.js'

const schema = z.object({
  query: z
    .string()
    .describe('Words that describe the earlier session: a topic, a file, a problem, a name.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe('Most sessions to return (default 5).'),
})

export type RecallArgs = z.infer<typeof schema>

export const recallTool: Tool<RecallArgs> = {
  name: 'recall',
  description:
    'Find an earlier session again: which one it was, when it happened and what it was about, in a few bullets. Use it when the user reaches for something from before — "that thing we did last week", "the session where we changed auth" — and you want the session back, not a quote. It ranks saved sessions by how well they match your words, so describe the topic rather than quoting it. It tells you which session: `search_history` with `session` gives the exact turns inside it, and `/resume <id>` opens it again. Each one also names what it is tied to — the routine whose run it was, the project it worked in, the jobs it started — by id, so the context can be followed from one object to the next instead of searched again. It reads this machine\'s own sessions; it does not search the web.',
  schema,
  readOnly: true,
  async execute(args, ctx) {
    if (!ctx.recall) {
      return { content: 'Past sessions are not available in this session.', isError: true }
    }

    const sessions = await ctx.recall(args.query, { limit: args.limit ?? 5 })
    if (sessions.length === 0) {
      return {
        content: `No saved session matches "${args.query}". search_history reads the exact words of every turn, which finds what a recap left out.`,
      }
    }

    return { content: format(sessions, ctx) }
  },
}

/**
 * What a session is tied to, by id: the routine whose run it was, the project it
 * worked in, the jobs it left running. These are the hops the model can take
 * without another search — the routine's schedule, the project's folder, a job's
 * output — so a session is not a dead end in the context it just recalled.
 *
 * Only the names, never their contents: what is behind an id is one call away,
 * and inlining it here would spend the window on four things when one was wanted.
 */
function links(session: SessionSummary, ctx: ToolContext): string[] {
  const out: string[] = []
  if (session.scope?.gateway === ROUTINE_GATEWAY) {
    const id = session.scope.chatId
    const routine = ctx.routine?.list().find((candidate) => candidate.id === id)
    out.push(routine ? `routine ${routine.id} (${routine.name ?? 'unnamed'})` : `routine ${id}`)
  }
  if (session.project) out.push(`project ${session.project}`)
  const jobs = ctx.jobs?.list(session.id) ?? []
  if (jobs.length > 0) {
    const named = jobs.slice(0, 3).map((job) => `${job.id} (${job.state})`)
    const more = jobs.length > named.length ? ` and ${jobs.length - named.length} more` : ''
    out.push(`jobs ${named.join(', ')}${more}`)
  }
  return out
}

function format(sessions: SessionSummary[], ctx: ToolContext): string {
  const blocks = sessions.map((session) => {
    const label = session.title ? `${session.id} — ${session.title}` : session.id
    const head = `${label} · ${session.messageCount} msgs · ${formatWhen(session.updatedAt)}`
    const body = session.recap ?? session.preview
    const lines = body
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .map((line) => `  ${line}`)
    const tied = links(session, ctx)
    return (tied.length > 0 ? [head, `  linked: ${tied.join(' · ')}`, ...lines] : [head, ...lines]).join('\n')
  })

  return [
    ...blocks,
    'Use /resume <id> to open one, or search_history with session "<id>" for the exact turns.',
  ].join('\n\n')
}
