import { z } from 'zod'
import type { Tool } from './types.js'

const schema = z.object({
  name: z.string().min(1).optional().describe('A short name for the bot. Give a name when creating a Crew bot.'),
  botId: z.string().optional().describe('The id of an existing bot to reuse for this assignment.'),
  model: z.string().min(1).optional().describe('A model id available from the chosen provider. Omit to use the current model; do not guess a model id.'),
  provider: z.string().min(1).optional().describe('An already configured provider id. Supply its model id too; omit both to use the current provider and model.'),
  description: z
    .string()
    .describe('A short label (a few words) naming the subtask, shown on its activity line.'),
  prompt: z
    .string()
    .describe(
      'The full instructions for the subagent. It starts with an empty context, cannot see this session and cannot ask you anything, so give it everything it needs: the goal, the relevant context and paths, what its report should contain (including the full chronology up to the latest available record when tracing history or changes), and every relevant constraint from the conversation or session (including privacy, secrecy, and directory or scope limits).',
    ),
})

export type TaskArgs = z.infer<typeof schema>

/**
 * The default: a subagent is a thing the person asks for, not a decision the
 * model makes on its own. A session in a project lifts that — a long read is
 * exactly the work that crowds a code session — and the description the
 * catalog carries is where the two differ.
 */
const TASK_DESCRIPTION =
  'Delegate a self-contained subtask to a Crew bot when that helps the work, or do it yourself when delegation would not help. Give the bot a short name and a complete mission: it has its own context and cannot see this session. Include the goal, needed context, expected output (such as the full chronology up to the latest available record when investigating history or state changes), and every relevant constraint from the conversation or session rules — especially privacy, secrecy, and scope limits. To choose a different model or provider, first discover the available ids with the crew tool. It returns a report, runs the same tools as you, cannot delegate again, and anything it needs confirmed is put to the user the same way yours would be. Before building a parallel solution from the report, weigh its findings and limitations — especially if it points to an existing mechanism that may already solve the problem — and build something new only when a real gap remains.'

/** The description the catalog carries. */
export function taskDescription(_project: boolean): string {
  return TASK_DESCRIPTION
}

export const taskTool: Tool<TaskArgs> = {
  name: 'task',
  description: TASK_DESCRIPTION,
  schema,
  delegates: true,
  async execute(args, ctx) {
    if (!ctx.task) {
      return { content: 'Subagents are not available in this session.', isError: true }
    }
    return ctx.task(args)
  },
}
