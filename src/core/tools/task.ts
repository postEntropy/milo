import { z } from 'zod'
import type { Tool } from './types.js'

const schema = z.object({
  description: z
    .string()
    .describe('A short label (a few words) naming the subtask, shown on its activity line.'),
  prompt: z
    .string()
    .describe(
      'The full instructions for the subagent. It starts with an empty context, cannot see this session and cannot ask you anything, so give it everything it needs: the goal, the relevant paths, and what its report should contain.',
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
  'Delegate a subtask to a subagent that runs in its own context and returns only its final report — for a broad search, a read through many files, or a long investigation, whose intermediate steps would otherwise crowd this session. Use it only when the user has explicitly asked for a subagent or for the work to be delegated; do not delegate on your own initiative — do the work yourself with the tools you already have. The subagent does not see this session and cannot ask questions, so the prompt must stand on its own. It runs the same tools you do, though it cannot delegate again, and anything it needs confirmed is put to the user the same way yours would be.'

const TASK_DESCRIPTION_IN_PROJECT =
  'Delegate a subtask to a subagent that runs in its own context and returns only its final report — for a broad search, a read through many files, or a long investigation, whose intermediate steps would otherwise crowd this session. In a project, use it on your own initiative when the work is self-contained and reading it here would crowd this session; do not hand it a decision that needs this session. The subagent does not see this session and cannot ask questions, so the prompt must stand on its own. It runs the same tools you do, though it cannot delegate again, and anything it needs confirmed is put to the user the same way yours would be.'

/** The description the catalog carries: whether the turn works in a project changes it. */
export function taskDescription(project: boolean): string {
  return project ? TASK_DESCRIPTION_IN_PROJECT : TASK_DESCRIPTION
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
