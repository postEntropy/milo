import type { ResolvedSkill } from './sources.js'

/**
 * A `SKILL.md` built from its parts. The frontmatter is two scalar keys and the
 * descriptions below carry no colon, so they need no quoting.
 */
function builtin(name: string, description: string, body: string): ResolvedSkill {
  return {
    name,
    description,
    markdown: `---\nname: ${name}\ndescription: ${description}\n---\n\n${body.trim()}\n`,
    origin: 'builtin',
  }
}

const SKILL_CREATOR = `# Writing a skill

A skill is a procedure Milo loads on demand, and its \`description\` is the whole
mechanism: it is the only thing the model sees until it decides to load the body. So the
description has to say **when** to reach for the skill, not just what it contains.

## Rules

- One skill, one job. If the description needs an "and", it is two skills.
- Write it in the words someone would actually ask in. It is matched by judgement, not by
  keywords, but a word that never appears in the request is a word that never matches.
- Keep the body procedural: steps, commands, paths. Facts that live in the repository do
  not belong here.
- Do not restate what a tool already gives you. The model can read a file; what it needs
  is the part that is not in the files.

## Shape

    ---
    name: my-skill
    description: What this does and when to use it
    ---

    1. First, do this.
    2. Then, that.

## Where it goes

\`~/.milo/skills/<name>/SKILL.md\`. The body is re-read every time the skill is loaded, so
an edit lands without a restart.`

const RELEASE_NOTES = `# Release notes from git history

Turn the commits since the last tag into notes a person would read.

1. Find the range: \`git describe --tags --abbrev=0\` is the last tag, so the range is
   \`<tag>..HEAD\`. If there is no tag, use the first commit.
2. Read the commits as prose, not as a list:
   \`git log --no-merges --pretty='%s%n%b' <range>\`.
3. Group by what changed *for the user*: added, changed, fixed. A refactor nobody can see
   does not get a line.
4. Put anything that breaks under its own heading, with what to do about it. A breaking
   change buried in "changed" is a bug in the notes.
5. Name the version and the date at the top, and link the compare view.

Do not paste commit subjects. A subject describes a change to the code; a note describes
it to someone who has not read the diff.`

/**
 * The curated set that ships in the bundle. They are not written anywhere until
 * one is installed, so every one of them is off by default — there is no flag,
 * because "not installed" is what off means everywhere else here.
 */
export const BUILTIN_SKILLS: ResolvedSkill[] = [
  builtin(
    'skill-creator',
    'How to write a skill for Milo — the shape, the rule that the description decides everything, and where the file goes',
    SKILL_CREATOR,
  ),
  builtin(
    'release-notes',
    'Turn the commits since the last tag into release notes a person would read, grouped by what changed for the user',
    RELEASE_NOTES,
  ),
]

export interface SuggestedSource {
  name: string
  /** Where `milo skills add` should be pointed. */
  source: string
  note: string
}

/**
 * Third-party suggestions, addresses only. Nothing here is fetched, reviewed or
 * vouched for by Milo — the ecosystem says outright that it cannot guarantee
 * what a listed skill does, and a skill is instructions, not data.
 *
 * `milo skills find` reads the live ranking from the directory instead; this
 * short list is what is left to say when the network is not there.
 */
export const SUGGESTED_SOURCES: SuggestedSource[] = [
  {
    name: 'vercel-labs/agent-skills',
    source: 'vercel-labs/agent-skills',
    note: 'the collection the skills CLI is built around',
  },
]
