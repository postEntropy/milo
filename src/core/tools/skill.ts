import { z } from 'zod'
import { reloadSkill, type Skill } from '../skills/index.js'
import type { Tool } from './types.js'

const schema = z.object({
  name: z
    .string()
    .describe('The name of the skill to load, exactly as it appears in the "## Skills" section.'),
})

export type SkillArgs = z.infer<typeof schema>

/**
 * Built over the skills found at startup. The index reaches the model through
 * the system prompt; this is what hands over the full instructions, which is
 * what keeps a skill's body out of every request until it is actually needed.
 */
export function createSkillTool(skills: Skill[]): Tool<SkillArgs> {
  const byName = new Map(skills.map((skill) => [skill.name, skill]))

  return {
    name: 'skill',
    description:
      'Load the full instructions of a skill by name. The skills available to you are indexed in the "## Skills" section of your context, one line each — call this when the task at hand matches one, to get the procedure to follow. Load it before you start, not after.',
    schema,
    readOnly: true,
    async execute(args) {
      const skill = byName.get(args.name)
      if (!skill) {
        const available = [...byName.keys()]
        return {
          content: available.length
            ? `No skill named "${args.name}". Available: ${available.join(', ')}.`
            : `No skill named "${args.name}". No skills are installed.`,
          isError: true,
        }
      }
      // Re-read from disk, so editing a skill takes effect without a restart.
      const fresh = reloadSkill(skill) ?? skill
      return { content: `# ${fresh.name}\n\n${fresh.body}` }
    },
  }
}
