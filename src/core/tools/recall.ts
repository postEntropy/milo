import { z } from 'zod'
import { formatWhen } from '../sessions/index.js'
import type { SessionSummary } from '../sessions/types.js'
import type { Tool } from './types.js'

const schema = z.object({
  query: z
    .string()
    .describe('Words that describe the earlier conversation: a topic, a file, a problem, a name.'),
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
    'Find an earlier conversation again: which session it was, when it happened and what it was about, in a few bullets. Use it when the user reaches for something from before — "that thing we did last week", "the session where we changed auth" — and you want the conversation back, not a quote. It ranks the saved sessions by how well they match your words, so describe the topic rather than quoting it. It tells you which session: `search_history` with `session` gives the exact turns inside it, and `/resume <id>` opens it again. It reads this machine\'s own sessions; it does not search the web.',
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

    return { content: format(sessions) }
  },
}

function format(sessions: SessionSummary[]): string {
  const blocks = sessions.map((session) => {
    const label = session.title ? `${session.id} — ${session.title}` : session.id
    const head = `${label} · ${session.messageCount} msgs · ${formatWhen(session.updatedAt)}`
    const body = session.recap ?? session.preview
    const lines = body
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .map((line) => `  ${line}`)
    return [head, ...lines].join('\n')
  })

  return [
    ...blocks,
    'Use /resume <id> to open one, or search_history with session "<id>" for the exact turns.',
  ].join('\n\n')
}
