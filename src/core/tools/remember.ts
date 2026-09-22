import { z } from 'zod'
import type { Tool } from './types.js'

const schema = z.object({
  facts: z
    .array(z.string().min(1))
    .min(1)
    .max(20)
    .describe('One or more standalone facts to keep.'),
  tags: z
    .array(z.string())
    .optional()
    .describe('Optional labels, e.g. ["preference"] or ["project", "conventions"].'),
})

export type RememberArgs = z.infer<typeof schema>

export const rememberTool: Tool<RememberArgs> = {
  name: 'remember',
  description:
    'Save a durable fact that should outlive this conversation — a preference, a convention, a decision, or something about the user or their setup. Facts are later recalled by keyword match against what the user says, so write each as one short standalone sentence in the user\'s own terms. Do not save what is already in the code, in the repository, or in this transcript: recall is keyword-based, and trivia crowds out the facts that matter.',
  schema,
  internal: true,
  async execute(args, ctx) {
    if (!ctx.remember) {
      return { content: 'Memory is not available in this session.', isError: true }
    }

    const facts = args.facts
      .map((text) => text.trim())
      .filter((text) => text.length > 0)
      .map((text) => ({ text, tags: args.tags?.length ? args.tags : ['assistant'] }))

    if (facts.length === 0) return { content: 'Nothing to remember.', isError: true }

    await ctx.remember(facts)
    return { content: `Remembered ${facts.length} fact(s).` }
  },
}
