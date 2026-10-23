import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { errorMessage } from '../../util/errors.js'
import { humanSize } from '../../util/format.js'
import { writeFileAtomic } from '../../util/fs.js'
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

/**
 * The heading the rules a turn writes for itself sit under.
 *
 * The file is the person's: it may hold anything, under any headings. So the tool
 * that writes keeps to one section it can find again — a rule it cannot find is a
 * rule it cannot take back — and everything else in the file is left as it was.
 */
export const PREFERENCES_HEADING = '## Preferences'

/**
 * How long one written rule may be.
 *
 * A rule is carried by every request of every session, before anything was asked.
 * A paragraph would be paid for every turn and read as noise by the turn it was
 * meant to steer, so it is refused rather than saved and regretted.
 */
export const MAX_RULE_LENGTH = 240

/** What writing one rule came to. */
export type RuleAdd =
  | { kind: 'written'; text: string }
  /** The file already says it, so nothing was written. */
  | { kind: 'present'; text: string }
  | { kind: 'refused'; error: string }

/** What dropping one came to. */
export type RuleRemove =
  | { kind: 'written'; text: string }
  /** Nothing in the file says this, so nothing was dropped. */
  | { kind: 'absent'; text: string }
  | { kind: 'refused'; error: string }

/**
 * Where a rule goes: this install's own `AGENTS.md`, or the project's — the same two
 * files the prompt is read from, so a rule written now is carried from the next turn
 * without anything else having to be told about it.
 *
 * Undefined for a project scope in a session that has none: there is no project file
 * to write, and the install's is the one that answers.
 */
export function instructionsPath(
  scope: 'install' | 'project',
  projectRoot?: string,
  home: string = MILO_HOME,
): string | undefined {
  if (scope === 'install') return path.join(home, INSTRUCTIONS_FILE)
  return projectRoot ? path.join(projectRoot, INSTRUCTIONS_FILE) : undefined
}

/** The rules written under the heading, in the order the file reads them. */
export function writtenRules(text: string): string[] {
  const lines = text.split('\n')
  const section = sectionOf(lines)
  if (!section) return []
  return lines
    .slice(section.start + 1, section.end)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
    .filter(Boolean)
}

/** The same, read off a file. No file is no rules, not a failure. */
export async function readWrittenRules(file: string): Promise<string[]> {
  const text = await readText(file)
  return text === null ? [] : writtenRules(text)
}

/**
 * Adds one rule under the heading, making the heading when the file has none.
 *
 * The same rule twice is not written twice: the person said it once, and a prompt
 * that repeats it pays for it on every turn. A rule is a single line, and a file
 * past what the prompt carries is refused — an `AGENTS.md` over that bound is
 * dropped whole, which would cost every other rule for this one.
 */
export async function addRule(file: string, raw: string): Promise<RuleAdd> {
  const text = oneLine(raw)
  if (text === null) {
    return { kind: 'refused', error: 'A rule is one line: this one is empty or carries a line break.' }
  }
  if (text.length > MAX_RULE_LENGTH) {
    return {
      kind: 'refused',
      error: `A rule is at most ${MAX_RULE_LENGTH} characters; this one is ${text.length}. Say the part that matters.`,
    }
  }

  const existing = (await readText(file)) ?? ''
  if (writtenRules(existing).includes(text)) return { kind: 'present', text }

  const next = `${placing(existing, `- ${text}`)}\n`
  if (Buffer.byteLength(next, 'utf8') > MAX_INSTRUCTIONS_BYTES) {
    return {
      kind: 'refused',
      error: `${INSTRUCTIONS_FILE} would pass the ${humanSize(MAX_INSTRUCTIONS_BYTES)} the prompt carries, which drops every rule in it. Remove one first.`,
    }
  }
  await mkdir(path.dirname(file), { recursive: true })
  await writeFileAtomic(file, next)
  return { kind: 'written', text }
}

/**
 * Drops the one rule the file carries as this text.
 *
 * The heading goes with the last rule it held: a section over nothing is a heading
 * that teaches the next turn to look for rules that are not there.
 */
export async function removeRule(file: string, raw: string): Promise<RuleRemove> {
  const text = oneLine(raw)
  if (text === null) {
    return { kind: 'refused', error: 'A rule is one line: this one is empty or carries a line break.' }
  }

  const existing = await readText(file)
  if (existing === null) return { kind: 'absent', text }

  const lines = existing.split('\n')
  const section = sectionOf(lines)
  if (!section) return { kind: 'absent', text }

  const at = lines.findIndex(
    (line, index) => index > section.start && index < section.end && line.trim() === `- ${text}`,
  )
  if (at < 0) return { kind: 'absent', text }

  lines.splice(at, 1)
  await writeFileAtomic(file, withoutEmptySection(lines))
  return { kind: 'written', text }
}

/**
 * The rule as the file carries it: trimmed, without the bullet the model may have
 * written itself. Null when it is not one line — a rule is a line, so a paragraph
 * is refused rather than flattened into one nobody wrote.
 */
function oneLine(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed === '' || /[\r\n]/.test(trimmed)) return null
  const text = trimmed.startsWith('- ') ? trimmed.slice(2).trim() : trimmed
  return text === '' ? null : text
}

/** The heading's lines: where it starts, and where the next heading takes over. */
function sectionOf(lines: string[]): { start: number; end: number } | null {
  const start = lines.findIndex((line) => line.trim() === PREFERENCES_HEADING)
  if (start < 0) return null
  const next = lines.findIndex((line, index) => index > start && /^#{1,6}\s/.test(line.trim()))
  return { start, end: next < 0 ? lines.length : next }
}

/**
 * The file with one bullet added under the heading.
 *
 * The bullet joins the section's last line, not the blank lines between it and
 * whatever heading comes next, and it is followed by exactly one blank line when
 * something follows it. A file with no heading of its own gets one at the end, so
 * nothing the person wrote is ever written through.
 */
function placing(existing: string, bullet: string): string {
  const body = existing.replace(/\s+$/, '')
  if (body === '') return `${PREFERENCES_HEADING}\n${bullet}`

  const lines = body.split('\n')
  const section = sectionOf(lines)
  if (!section) return `${body}\n\n${PREFERENCES_HEADING}\n${bullet}`

  let at = section.end
  while (at > section.start + 1 && (lines[at - 1] ?? '').trim() === '') at -= 1
  const head = lines.slice(0, at)
  const rest = lines.slice(section.end)
  return [...head, bullet, ...(rest.length > 0 ? ['', ...rest] : [])].join('\n')
}

/** The file without its heading, once the last rule it held is gone. */
function withoutEmptySection(lines: string[]): string {
  const section = sectionOf(lines)
  if (section !== null) {
    const holdsNothing = lines
      .slice(section.start + 1, section.end)
      .every((line) => line.trim() === '')
    if (holdsNothing) {
      const head = lines.slice(0, section.start)
      while (head.length > 0 && (head[head.length - 1] ?? '').trim() === '') head.pop()
      const rest = lines.slice(section.end)
      lines = [...head, ...(head.length > 0 && rest.length > 0 ? ['', ...rest] : rest)]
    }
  }
  const text = lines.join('\n').replace(/\s+$/, '')
  return text === '' ? '' : `${text}\n`
}

/** A file's text, or null when it is not there. Every other failure is the caller's. */
async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
