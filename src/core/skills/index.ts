import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { skillsDir } from '../config/paths.js'
import { logWarn } from '../../util/log.js'

/**
 * What the system prompt indexes: enough for the model to decide whether a
 * skill is worth loading. The instructions are deliberately not here — putting
 * every skill's body in every request is what progressive disclosure avoids.
 */
export interface SkillSummary {
  name: string
  description: string
}

/** A skill with its instructions loaded. */
export interface Skill extends SkillSummary {
  /** The instructions, with the frontmatter stripped. */
  body: string
  /** The `SKILL.md` it was read from, so the body can be re-read per call. */
  path: string
}

const SKILL_FILE = 'SKILL.md'

/**
 * Makes sure Milo's skills directory exists, so there is somewhere to drop a
 * `SKILL.md`. An empty directory nobody knows about is the same as no feature —
 * which is why this runs at startup and when setup opens, not only on the first
 * write.
 */
export function ensureSkillsDir(): void {
  try {
    mkdirSync(skillsDir(), { recursive: true })
  } catch (error) {
    // A directory that cannot be made is worth saying out loud, but it is not a
    // reason to fail a start.
    logWarn(`could not create ${skillsDir()}: ${error instanceof Error ? error.message : error}`)
  }
}

/**
 * Reads the frontmatter and body out of one `SKILL.md`.
 *
 * The frontmatter is the market convention — `---`, two scalar keys, `---` — and
 * it is read with a few lines rather than a YAML dependency: pulling a parser in
 * for `name` and `description` would be more machinery than the format.
 */
export function parseSkill(
  markdown: string,
  options: { fallbackName: string; path: string },
): Skill | null {
  const { frontmatter, body } = splitFrontmatter(markdown)
  const meta = parseFrontmatter(frontmatter)
  const name = meta.name?.trim() || options.fallbackName.trim()
  const description = meta.description?.trim()
  // Without a description the skill cannot be indexed — the model would have a
  // name and no way to tell whether it applies — so it is not a skill yet.
  if (!name || !description) return null
  return { name, description, body: body.trim(), path: options.path }
}

/**
 * One skill as it sits on disk: what was parsed, and the directory it came from.
 * The directory is what a caller needs to find the skill's sidecar or to replace
 * the file, and `SKILL.md` is the only name either of them knows.
 */
export interface FoundSkill {
  skill: Skill
  folder: string
}

/**
 * Finds the skills in a directory, one level deep (`<dir>/<name>/SKILL.md`). A
 * directory that does not exist is not an error (most installs have no skills),
 * and a file that cannot be parsed is skipped with a warning rather than failing
 * the boot.
 *
 * The one walk over the skills directory: what is *installed* (with the sidecar a
 * `milo skills add` leaves behind) and what is *indexed* (name and description)
 * are two projections of this, not two readers that can drift apart.
 */
export function readSkillFolders(dir: string): FoundSkill[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    // A missing skills directory is the normal case, not a failure.
    return []
  }

  const found: FoundSkill[] = []
  for (const entry of entries) {
    const folder = path.join(dir, entry)
    const file = path.join(folder, SKILL_FILE)
    let markdown: string
    try {
      markdown = readFileSync(file, 'utf8')
    } catch {
      // Not a skill directory (no SKILL.md, or not a directory at all).
      continue
    }
    const skill = parseSkill(markdown, { fallbackName: entry, path: file })
    if (!skill) {
      logWarn(`${file} has no description, so it was skipped — a skill needs one to be indexed.`)
      continue
    }
    found.push({ skill, folder })
  }
  return found
}

export function discoverSkills(dir: string): Skill[] {
  return readSkillFolders(dir)
    .map((found) => found.skill)
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * The skills this process is serving: the index the system prompt carries and the
 * list `read_skill` answers from.
 *
 * Both ask *this*, so there is one answer to what is installed and a skill added
 * while Milo is running joins the index on the next turn instead of waiting for a
 * restart. The directory is watched by the mtime of each entry, which is a
 * handful of stats — the `SKILL.md` files themselves are re-read only when that
 * says something moved. Bodies are never held here: `read_skill` re-reads the one
 * it is asked for, so an edit lands without a restart either way.
 */
export class SkillLibrary {
  private found: Skill[] = []
  private stamp: string | null = null

  constructor(private readonly dir: string) {
    this.list()
  }

  /** The skills installed now. */
  list(): Skill[] {
    const stamp = directoryStamp(this.dir)
    if (stamp !== this.stamp) {
      this.found = discoverSkills(this.dir)
      this.stamp = stamp
    }
    return this.found
  }

  /** One skill by the name the prompt and the person use. */
  find(name: string): Skill | undefined {
    return this.list().find((skill) => skill.name === name)
  }
}

/**
 * What the skills directory looks like right now: each entry and when it last
 * moved, or null when there is no directory. Cheap enough to check on every read
 * — adding, removing, renaming or replacing a skill all move it — and different
 * from the previous answer exactly when the parsed index needs to be rebuilt.
 */
function directoryStamp(dir: string): string | null {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return null
  }
  const parts: string[] = []
  for (const entry of entries) {
    try {
      parts.push(`${entry}:${statSync(path.join(dir, entry)).mtimeMs}`)
    } catch {
      // Gone between the listing and the stat: the next read sees it missing.
    }
  }
  return parts.sort().join('|')
}

/** Re-reads a discovered skill from disk, so an edit takes effect without a restart. */
export function reloadSkill(skill: Skill): Skill | null {
  let markdown: string
  try {
    markdown = readFileSync(skill.path, 'utf8')
  } catch {
    return null
  }
  return parseSkill(markdown, { fallbackName: skill.name, path: skill.path })
}

/** The list `/skills` prints. */
export function formatSkillList(skills: SkillSummary[]): string {
  if (skills.length === 0) {
    return [
      'No skills found.',
      'Add one at ~/.milo/skills/<name>/SKILL.md, with a `name` and a `description` in the frontmatter.',
      'Restart to pick it up.',
    ].join('\n')
  }
  const lines = skills.map((skill) => `- ${skill.name} — ${skill.description}`)
  return ['Skills:', ...lines].join('\n')
}

/**
 * Splits a leading `---` frontmatter block off the markdown. Text with no
 * frontmatter is all body, and an opening `---` with no closing one is treated
 * the same way rather than swallowing the file.
 */
function splitFrontmatter(markdown: string): { frontmatter: string; body: string } {
  const text = markdown.replace(/^\uFEFF/, '')
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return { frontmatter: '', body: text }

  let end = -1
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]?.trim() === '---') {
      end = i
      break
    }
  }
  if (end === -1) return { frontmatter: '', body: text }

  return {
    frontmatter: lines.slice(1, end).join('\n'),
    body: lines.slice(end + 1).join('\n'),
  }
}

/** A minimal `key: value` reader: the two scalar keys the format uses. */
function parseFrontmatter(frontmatter: string): Record<string, string> {
  const meta: Record<string, string> = {}
  for (const line of frontmatter.split('\n')) {
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim())
    if (!match) continue
    meta[match[1]!.toLowerCase()] = unquote(match[2]!.trim())
  }
  return meta
}

function unquote(value: string): string {
  const quoted =
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  return quoted && value.length >= 2 ? value.slice(1, -1) : value
}
