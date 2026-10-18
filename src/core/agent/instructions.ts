import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { errorMessage } from '../../util/errors.js'
import { humanSize } from '../../util/format.js'
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
 * How much of the file rides along. It is a section of the system prompt, so it is
 * paid for on every request a session with a project makes. A file larger than this
 * is not half-read — half a set of rules is worse than none — it is left out and the
 * reason said.
 */
const MAX_INSTRUCTIONS_BYTES = 16 * 1024

/** A project's instructions, or why there are none to carry. */
export type ProjectInstructions =
  | { kind: 'present'; text: string }
  /** No project, no folder, or no file: nothing to say, and nothing wrong. */
  | { kind: 'absent' }
  /** There is a file and it could not be carried. The reason is for the prompt. */
  | { kind: 'unreadable'; error: string }

/**
 * Reads the instructions of the session's project. Sync, because it is called while
 * the prompt for the turn is built — the same place, and the same shape, as the
 * skills list.
 */
export function readProjectInstructions(placement: ProjectPlacement | undefined): ProjectInstructions {
  // No project, or one whose folder is gone: there is nothing to read, and the
  // environment line already says the session is working somewhere else.
  if (!placement?.ok) return { kind: 'absent' }

  const file = path.join(placement.project.path, INSTRUCTIONS_FILE)

  let size: number
  try {
    const stats = statSync(file)
    // Something with the file's name that is not a file — a folder, say — is not
    // "no instructions": the person meant to write some, and it should be said.
    if (!stats.isFile()) return { kind: 'unreadable', error: `${INSTRUCTIONS_FILE} is not a file` }
    size = stats.size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' }
    return { kind: 'unreadable', error: errorMessage(error) }
  }

  // Measured before the read, so a huge file is never pulled into memory to be
  // rejected afterwards.
  if (size > MAX_INSTRUCTIONS_BYTES) {
    return {
      kind: 'unreadable',
      error: `it is ${humanSize(size)}, over the ${humanSize(MAX_INSTRUCTIONS_BYTES)} carried`,
    }
  }

  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    return { kind: 'unreadable', error: errorMessage(error) }
  }
  // A binary read as UTF-8 is garbage with no complaint; a NUL is the one byte text
  // does not hold — the same rule `work.ts` keeps for a file the person opens.
  if (raw.includes('\u0000')) return { kind: 'unreadable', error: 'it is not a text file' }

  const text = raw.trim()
  // An empty file says nothing, and a heading over nothing teaches the model to
  // look for rules that are not there.
  if (text === '') return { kind: 'absent' }
  return { kind: 'present', text }
}
