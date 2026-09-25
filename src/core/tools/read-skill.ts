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
 *
 * Named `read_skill` and not `skill`: it returns a skill's text, the way
 * `read_file` returns a file's, and a bare noun reads as anything but "call me
 * to see this" — the model reached for `read_file` on the real path instead.
 */
export function createReadSkillTool(skills: Skill[]): Tool<SkillArgs> {
  const byName = new Map(skills.map((skill) => [skill.name, skill]))

  return {
    name: 'read_skill',
    description:
      'Read a skill\'s full instructions by name — the body behind the one-line index in your "## Skills" section. Call it when the task at hand matches a skill, to follow its procedure, and when the user asks what a skill says or contains. Load it before you start, not after.',
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
