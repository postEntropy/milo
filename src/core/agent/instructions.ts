import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { errorMessage } from '../../util/errors.js'
import { humanSize } from '../../util/format.js'
import { MILO_HOME } from '../config/paths.js'
import type { ProjectPlacement } from '../projects.js'

/**
 * The rules a project carries: the `AGENTS.md` at the root of its folder, read as
 * the project is worked in and carried in the system prompt, so a session follows
 * the conventions of the folder it was pointed at rather than only being told
 * where the folder is.
 *
 * Read per turn — a getter, like the skills — so an edit to the file is picked up
 * on the next turn instead of needing a restart. Read-only: writing the file is the
 * person's act in their own editor, or the agent's through its tools.
 *
 * Three outcomes, not two. "There are no instructions" is the common case and not a
 * failure, and "there is one and it could not be read" is not the same thing: the
 * second is carried to the prompt with its reason, so a project whose rules were
 * skipped says so rather than being answered as one with no rules at all.
 */

/** The file a project's own rules live in, at the root of its folder. */
export const INSTRUCTIONS_FILE = 'AGENTS.md'

/**
 * The same rules under the name another agent reads. Tried only when there is no
 * `AGENTS.md`: a folder that carries both has already said which one Milo follows.
 */
export const FALLBACK_INSTRUCTIONS_FILE = 'CLAUDE.md'

/**
 * How much of the file rides along. It is a section of the system prompt, so it is
 * paid for on every request a session with a project makes. A file larger than this
 * is not half-read — half a set of rules is worse than none — it is left out and the
 * reason said.
 */
const MAX_INSTRUCTIONS_BYTES = 16 * 1024

/** A set of rules, or why there are none to carry. */
export type ProjectInstructions =
  | { kind: 'present'; file: string; text: string }
  /** No project, no folder, or no file: nothing to say, and nothing wrong. */
  | { kind: 'absent' }
  /** There is a file and it could not be carried. The reason is for the prompt. */
  | { kind: 'unreadable'; file: string; error: string }

/**
 * Reads one instructions file. The common reader behind both the project's rules
 * and Milo's own: the same size bound, the same three outcomes and the same refusal
 * of a file that cannot say anything useful.
 */
export function readInstructionsFile(file: string): ProjectInstructions {
  const name = path.basename(file)

  let size: number
  try {
    const stats = statSync(file)
    // Something with the file's name that is not a file — a folder, say — is not
    // "no instructions": the person meant to write some, and it should be said.
    if (!stats.isFile()) return { kind: 'unreadable', file: name, error: `${name} is not a file` }
    size = stats.size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' }
    return { kind: 'unreadable', file: name, error: errorMessage(error) }
  }

  // Measured before the read, so a huge file is never pulled into memory to be
  // rejected afterwards.
  if (size > MAX_INSTRUCTIONS_BYTES) {
    return {
      kind: 'unreadable',
      file: name,
      error: `it is ${humanSize(size)}, over the ${humanSize(MAX_INSTRUCTIONS_BYTES)} carried`,
    }
  }

  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    return { kind: 'unreadable', file: name, error: errorMessage(error) }
  }
  // A binary read as UTF-8 is garbage with no complaint; a NUL is the one byte text
  // does not hold — the same rule `work.ts` keeps for a file the person opens.
  if (raw.includes('\u0000')) return { kind: 'unreadable', file: name, error: 'it is not a text file' }

  const text = raw.trim()
  // An empty file says nothing, and a heading over nothing teaches the model to
  // look for rules that are not there.
  if (text === '') return { kind: 'absent' }
  return { kind: 'present', file: name, text }
}

/**
 * Reads the instructions of the session's project. Sync, because it is called while
 * the prompt for the turn is built — the same place, and the same shape, as the
 * skills list.
 *
 * `AGENTS.md` is the file Milo reads; `CLAUDE.md` is the same convention under
 * another agent's name, and is read only when there is no `AGENTS.md`. An
 * `AGENTS.md` that exists but could not be read does not fall through: the person
 * put it there, and silently following a different file would hide the problem.
 */
export function readProjectInstructions(placement: ProjectPlacement | undefined): ProjectInstructions {
  // No project, or one whose folder is gone: there is nothing to read, and the
  // environment line already says the session is working somewhere else.
  if (!placement?.ok) return { kind: 'absent' }

  const root = placement.project.path
  const ownFile = path.join(root, INSTRUCTIONS_FILE)
  const own = readInstructionsFile(ownFile)
  if (own.kind !== 'absent') return own
  // An empty `AGENTS.md` is this folder saying it has no rules; it is not an
  // invitation to follow another agent's file instead.
  if (existsSync(ownFile)) return own
  return readInstructionsFile(path.join(root, FALLBACK_INSTRUCTIONS_FILE))
}

/**
 * The rules of this install itself: the `AGENTS.md` in Milo's own directory,
 * carried above every project's. Read per turn like the project's, so an edit
 * lands on the next one.
 */
export function readOwnInstructions(dir: string = MILO_HOME): ProjectInstructions {
  return readInstructionsFile(path.join(dir, INSTRUCTIONS_FILE))
}

/**
 * Whether a project carries rules, without the text — what a screen draws and what
 * the CLI's list says. The file's own words never travel to a surface: a screen says
 * that the rules are there, it does not read them out.
 */
export type ProjectRules =
  | { kind: 'present'; file: string }
  | { kind: 'absent' }
  | { kind: 'unreadable'; file: string; error: string }

/** The status of a read, with the file's text dropped. */
export function rulesOf(instructions: ProjectInstructions): ProjectRules {
  if (instructions.kind === 'present') return { kind: 'present', file: instructions.file }
  if (instructions.kind === 'unreadable') {
    return { kind: 'unreadable', file: instructions.file, error: instructions.error }
  }
  return { kind: 'absent' }
}

/**
 * What the agent is told when the person asks it to write the folder's rules. The
 * text lives here, once, and each surface hands it over as it is — the web and the
 * phone cannot share a constant across Swift and TypeScript, so they are served this.
 */
export const PROJECT_RULES_PROMPT = `Write or improve the \`${INSTRUCTIONS_FILE}\` at the root of this project's folder: the file that tells a session started here how this project is worked in.

Read the folder before you write. Get the truth from what is actually there — the build, test and lint commands the project already uses, where its code lives, the conventions its own files show — and write only what you found. Do not invent a command, a script or a directory: if you did not see it, it is not a rule.

Keep it short and specific to this project: what someone joining it would need and could not guess from the file names alone. Commands first, then the structure and the conventions that are not obvious from the outside.

If an \`${INSTRUCTIONS_FILE}\` is already there, improve it where it stands: keep what is still true, correct what is not, add what is missing, and say in your reply what you changed. Do not rewrite it from scratch, and do not pad it.`
