import { z } from 'zod'
import {
  INSTRUCTIONS_FILE,
  PREFERENCES_HEADING,
  addRule,
  instructionsPath,
  readWrittenRules,
  removeRule,
} from '../agent/instructions.js'
import { errorMessage } from '../../util/errors.js'
import type { Tool } from './types.js'

const scopeSchema = z
  .enum(['install', 'project'])
  .optional()
  .describe(
    "Where the rule lives: the install's own file (every session) or this project's (only sessions working in this folder). Defaults to the install.",
  )

const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), scope: scopeSchema }),
  z.object({ action: z.literal('add'), text: z.string(), scope: scopeSchema }),
  z.object({ action: z.literal('remove'), text: z.string(), scope: scopeSchema }),
])

export type InstructionsArgs = z.infer<typeof schema>

export const instructionsTool: Tool<InstructionsArgs> = {
  name: 'instructions',
  description:
    'Write, list or remove a standing rule: an instruction the person wants Milo to follow in every turn of every session from now on. It is saved in ' +
    `${INSTRUCTIONS_FILE} — the file the prompt reads each turn — so it is carried, not recalled, and it outlives this conversation. ` +
    'Save only what the person stated as a rule for the future: "from now on", "always", "never", "remember to", or an answer to whether to save it. ' +
    'Never turn your own inference about what they would like into a rule, and never save a fact about the world, the task at hand, or something true only today: a fact is `remember`, which is recalled when it is relevant instead of carried every turn. ' +
    'A rule is one line in their own terms ("keep answers to a few lines"), not a paragraph. ' +
    `It lands under "${PREFERENCES_HEADING}", which is the only part of the file this tool touches. ` +
    '`list` shows every rule there; `remove` takes the exact text of one of them.',
  schema,
  asksWhen: (args) => args.action !== 'list',
  async execute(args, ctx) {
    const scope = args.scope ?? 'install'
    const file = instructionsPath(scope, ctx.confineTo)
    if (!file) {
      return {
        content:
          'This session has no project, so it has no project rules of its own: a rule saved here belongs to the install — leave `scope` out.',
        isError: true,
      }
    }
    const where =
      scope === 'project' ? `this project's ${INSTRUCTIONS_FILE}` : `the install's ~/.milo/${INSTRUCTIONS_FILE}`

    try {
      if (args.action === 'list') {
        const rules = await readWrittenRules(file)
        if (rules.length === 0) return { content: `No rules of its own in ${where} yet.` }
        const list = rules.map((rule, index) => `${index + 1}. ${rule}`).join('\n')
        return { content: `${rules.length} rule(s) in ${where}, carried by the prompt every turn:\n${list}` }
      }

      if (args.action === 'add') {
        const result = await addRule(file, args.text)
        switch (result.kind) {
          case 'written':
            return {
              content: `Saved in ${where}, carried by every turn from now on: "${result.text}"`,
            }
          case 'present':
            return { content: `Already there in ${where}: "${result.text}". Nothing was written.` }
          case 'refused':
            return { content: result.error, isError: true }
        }
      }

      const result = await removeRule(file, args.text)
      switch (result.kind) {
        case 'written':
          return { content: `Removed from ${where}: "${result.text}".` }
        case 'absent':
          return {
            content: `Nothing in ${where} says "${result.text}". Read the list first and take the rule as it reads there.`,
            isError: true,
          }
        case 'refused':
          return { content: result.error, isError: true }
      }
    } catch (error) {
      return { content: `Could not change ${where}: ${errorMessage(error)}`, isError: true }
    }
  },
}
