import { z } from 'zod'
import { formatWhen } from '../sessions/index.js'
import type { SessionSummary } from '../sessions/types.js'
import type { SessionAdmin, Tool } from './types.js'

const schema = z.object({
  action: z
    .enum(['list', 'remove'])
    .optional()
    .describe(
      '"list" reads every saved session with what it was about; "remove" drops one by id. Absent: "list".',
    ),
  id: z
    .string()
    .optional()
    .describe('For "remove": which session to delete, an id from "list".'),
})

export type SessionsArgs = z.infer<typeof schema>

export const sessionsTool: Tool<SessionsArgs> = {
  name: 'sessions',
  description:
    'The conversations saved on this machine — the same list `/sessions` shows the person. Reach for it to get a session id back, to answer "what was I working on", or to clean up: list them, then remove the ones worth dropping (a leftover nothing was ever said in, one the person is done with). Removing asks before it happens and cannot be undone, and it will not remove the session you are in. It reads this machine\'s own sessions; it is not the web and not another install. `recall` finds one by what it was about; this lists them all and prunes.',
  schema,
  readOnly: false,
  // Listing is a read the person would not want to approve; removing is not. The
  // args say which this call is, the way the `routine` tool tells a read of the
  // list from a change to a standing instruction.
  asksWhen: (args) => args.action === 'remove',
  async execute(args, ctx) {
    const admin = ctx.sessionAdmin
    if (!admin) {
      return { content: 'Sessions are not available in this session.', isError: true }
    }
    return (args.action ?? 'list') === 'remove' ? removeOne(args.id, admin) : listAll(admin)
  },
}

/** One line per session, as the model reads it: which it was, how big, when, and what about. */
async function listAll(admin: SessionAdmin): Promise<{ content: string }> {
  const sessions = await admin.list()
  if (sessions.length === 0) {
    return { content: 'No saved sessions yet.' }
  }
  const name = (session: SessionSummary): string =>
    session.title ? `${session.id} — ${session.title}` : session.id

  return {
    content: [
      `Sessions (${sessions.length}, most recent first):`,
      ...sessions.map((session) => {
        const head = `${name(session)} · ${session.messageCount} msgs · ${formatWhen(session.updatedAt)}`
        const body = session.recap ?? session.preview
        const lines = body
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line !== '')
          .map((line) => `  ${line}`)
        return [head, ...lines].join('\n')
      }),
      `The session you are in: ${admin.current}.`,
      'Remove one with action "remove" and its id.',
    ].join('\n\n'),
  }
}

async function removeOne(id: string | undefined, admin: SessionAdmin): Promise<{ content: string }> {
  const target = id?.trim()
  if (!target) {
    return {
      content:
        'Which one? Give the id from action "list": sessions { "action": "remove", "id": "<id>" }.',
    }
  }
  if (target === admin.current) {
    return {
      content: `That is the session I am in (${admin.current}) — I will not remove it. Switch to another first (/new or /resume).`,
    }
  }
  return (await admin.remove(target))
    ? { content: `Removed ${target}.` }
    : { content: `No session "${target}".` }
}
