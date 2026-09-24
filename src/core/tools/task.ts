import { z } from 'zod'
import type { Tool } from './types.js'

const schema = z.object({
  description: z
    .string()
    .describe('A short label (a few words) naming the subtask, shown on its activity line.'),
  prompt: z
    .string()
    .describe(
      'The full instructions for the subagent. It starts with an empty context, cannot see this conversation and cannot ask you anything, so give it everything it needs: the goal, the relevant paths, and what its report should contain.',
    ),
})

export type TaskArgs = z.infer<typeof schema>

export const taskTool: Tool<TaskArgs> = {
  name: 'task',
  description:
    'Delegate a subtask to a subagent that runs in its own context and returns only its final report — for a broad search, a read through many files, or a long investigation, whose intermediate steps would otherwise crowd this conversation. Use it only when the user has explicitly asked for a subagent or for the work to be delegated; do not delegate on your own initiative — do the work yourself with the tools you already have. The subagent does not see this conversation and cannot ask questions, so the prompt must stand on its own. It runs the same tools you do, though it cannot delegate again, and anything it needs confirmed is put to the user the same way yours would be.',
  schema,
  delegates: true,
  async execute(args, ctx) {
    if (!ctx.task) {
      return { content: 'Subagents are not available in this session.', isError: true }
    }
    return ctx.task(args)
  },
}
