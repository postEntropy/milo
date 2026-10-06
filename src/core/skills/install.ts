import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from '../../util/fs.js'
import { readSkillFolders } from './index.js'

/** The file a skill directory carries its provenance in. Discovery skips files. */
export const SOURCE_FILE = '.milo.json'

/**
 * A skill name becomes a directory name, so it is checked before it is used as
 * one: a name carrying a separator or a `..` would write outside the skills
 * directory, and that is the whole of the path handling this needs.
 */
export function isSafeSkillName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes('..')
}

export interface InstalledSkill {
  name: string
  description: string
  /** The skill's own directory. */
  dir: string
  /** Where it was installed from, when `milo skills` put it there. */
  origin?: string
  installedAt?: string
}

/** What an install needs: the text to write, and where it came from. */
export interface SkillToInstall {
  name: string
  /** The source's own bytes, written whole — its frontmatter fields are not ours to drop. */
  markdown: string
  origin: string
}

/**
 * Writes a skill into the skills directory.
 *
 * Both files go through a temporary neighbour, so an install that is killed
 * mid-write leaves nothing half-formed where the index reads it.
 */
export async function installSkill(
  skill: SkillToInstall,
  dir: string,
): Promise<{ file: string; replaced: boolean }> {
  if (!isSafeSkillName(skill.name)) {
    throw new Error(`"${skill.name}" is not a usable skill name.`)
  }

  const target = path.join(dir, skill.name)
  const file = path.join(target, 'SKILL.md')
  const replaced = existsSync(file)

  mkdirSync(target, { recursive: true })
  await writeFileAtomic(file, skill.markdown)
  await writeFileAtomic(
    path.join(target, SOURCE_FILE),
    `${JSON.stringify({ source: skill.origin, installedAt: new Date().toISOString() }, null, 2)}\n`,
  )
  return { file, replaced }
}

/** Deletes a skill's directory — its sidecar goes with it. */
export function removeSkill(name: string, dir: string): boolean {
  if (!isSafeSkillName(name)) return false
  const target = path.join(dir, name)
  if (!existsSync(target)) return false
  rmSync(target, { recursive: true, force: true })
  return true
}

/**
 * What is installed in a directory. Read from the `SKILL.md` files themselves,
 * so a skill dropped in by hand is listed like any other — with no origin, since
 * nothing recorded one.
 */
export function listInstalled(dir: string): InstalledSkill[] {
  // The same walk that feeds the index, projected with the provenance a
  // `milo skills add` leaves in the sidecar — one reader, two shapes.
  return readSkillFolders(dir)
    .map(({ skill, folder }) => {
      const sourced = readSource(path.join(folder, SOURCE_FILE))
      return {
        name: skill.name,
        description: skill.description,
        dir: folder,
        origin: sourced?.source,
        installedAt: sourced?.installedAt,
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

function readSource(file: string): { source?: string; installedAt?: string } | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as { source?: string; installedAt?: string }
  } catch {
    return null
  }
}
