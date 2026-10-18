import path from 'node:path'
import { placeProject } from './projects.js'
import { runGit } from './tools/git.js'

/**
 * What a project's folder has changed, from git — the source of truth for a folder
 * that is a repository, and the only one that is: nothing in Milo records what a
 * session wrote, so a folder that is not a repository is answered with that rather
 * than with an empty list that would read as "nothing changed".
 *
 * The core answers **structure** — files, hunks, lines, each with its two numbers —
 * and never the raw diff text: the drawing belongs to the screens, and the phone
 * and the browser draw the same shape instead of parsing their own.
 */

/** One line of a hunk. */
export interface WorkDiffLine {
  kind: 'add' | 'remove' | 'context'
  /** The line's own text, without the diff's leading marker. */
  text: string
  /** The line's number before the change, when the line is in that file. */
  old?: number
  /** The line's number after the change, when the line is in that file. */
  new?: number
}

/** One hunk: where it starts in either file, and what changed there. */
export interface WorkDiffHunk {
  /** The header's own numbers, as git wrote them: `-12,7 +12,9`. */
  header: string
  lines: WorkDiffLine[]
}

export type WorkDiffStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'

/** One changed file, as a screen draws it. */
export interface WorkDiffFile {
  /** Path relative to the project's folder — the new one when it was renamed. */
  path: string
  /** Where it came from, when it was renamed or moved. */
  from?: string
  status: WorkDiffStatus
  additions: number
  deletions: number
  hunks: WorkDiffHunk[]
  /** Why there is nothing to draw — a binary file, or only its mode that changed. */
  note?: string
}

/** A project's changes, or why none can be read: not a repository, or git missing. */
export type WorkDiffOutcome =
  | {
      ok: true
      source: 'git'
      files: WorkDiffFile[]
      truncated: boolean
      /**
       * Whether the repository has a commit to compare against. A repository that has just
       * been started has none — everything in it counts as new, which is why the screen
       * offers to record the first state instead of drawing every file as a change.
       */
      committed: boolean
    }
  | { ok: true; source: 'none'; reason: string }
  | { ok: false; error: string }

/** What recording a folder's first state answered. */
export type WorkTrackOutcome = { ok: true; path: string } | { ok: false; error: string }

/**
 * How many files and how many lines of change are drawn. A working tree can hold a
 * generated file nobody meant to look at, so both are cut and the cut is said rather
 * than answered as the whole of the change.
 */
const MAX_DIFF_FILES = 100
const MAX_DIFF_LINES = 4_000

/** Why an untracked file has no hunks to draw, and where it can be read instead. */
const UNTRACKED_NOTE = 'open it in Files to read what is in it'

/**
 * The working tree of one project, read through its own repository: what changed
 * against the last commit (or, in a repository with no commits yet, against what is
 * staged), untracked files named as such, and binary files said to be binary.
 *
 * Scoped to the project's own folder, so a project pointed at one directory of a
 * monorepo answers about that directory and not about its neighbours.
 */
export async function workDiff(id: string): Promise<WorkDiffOutcome> {
  const placement = placeProject(id)
  if (!placement.ok) return { ok: false, error: placement.error }
  const root = placement.project.path

  const toplevel = await runGit(root, ['rev-parse', '--show-toplevel'])
  if ('failed' in toplevel) return { ok: false, error: toplevel.failed }
  if (toplevel.code !== 0) {
    return { ok: true, source: 'none', reason: `${placement.project.name} is not a git repository.` }
  }

  const repo = toplevel.body.split('\n')[0]!.trim() || root
  // A project may be one folder of a repository; `scope` is where it sits inside it,
  // and `--` keeps every read about that folder rather than the whole checkout.
  const scope = toPosix(path.relative(repo, root))
  const paths = scope === '' ? [] : ['--', scope]
  const strip = (file: string): string => (scope === '' ? file : file.startsWith(`${scope}/`) ? file.slice(scope.length + 1) : file)

  const head = await runGit(repo, ['rev-parse', '--verify', '--quiet', 'HEAD'])
  /*
   * A repository with nothing committed has no state to compare against: every file in it
   * would read as new, and a screen drawing that would show the whole folder as one change.
   * So the answer is that there is nothing to read yet — said as `committed: false`, which
   * is also what offers the person the one action that fixes it.
   */
  const hasHead = !('failed' in head) && head.code === 0
  if (!hasHead) return { ok: true, source: 'git', files: [], truncated: false, committed: false }

  // `--untracked-files=all` because the read is about files: git collapses a wholly
  // untracked directory to `dir/`, which is not a file anyone can open or diff.
  const status = await runGit(repo, ['status', '--porcelain', '-z', '--untracked-files=all', ...paths], undefined, { raw: true })
  if ('failed' in status) return { ok: false, error: status.failed }
  if (status.code !== 0) return { ok: false, error: gitReason(status.body) }

  // `--no-prefix` because a path in this read is a path: the `a/`/`b/` prefixes are the
  // machine's own setting (`diff.mnemonicprefix` makes them `c/` and `w/`, one per
  // source), and a parser that assumed them would stop matching the working tree's list.
  const diff = await runGit(repo, ['diff', 'HEAD', '-U3', '--no-prefix', '--no-color', ...paths], undefined, { raw: true })
  if ('failed' in diff) return { ok: false, error: diff.failed }
  if (diff.code !== 0) return { ok: false, error: gitReason(diff.body) }

  const parsed = parseDiff(diff.body)
  const files: WorkDiffFile[] = []
  let lines = 0
  let truncated = false

  for (const entry of parseStatus(status.body)) {
    if (files.length >= MAX_DIFF_FILES || lines >= MAX_DIFF_LINES) {
      truncated = true
      break
    }
    const changes = parsed.get(entry.path)
    const hunks = changes?.hunks ?? []
    lines += hunks.reduce((count, hunk) => count + hunk.lines.length, 0)
    // A file with nothing to draw still says why: git does not track it yet, its
    // difference is binary, or only its permissions changed.
    const note = changes?.note ?? (entry.status === 'untracked' ? UNTRACKED_NOTE : undefined)
    files.push({
      path: strip(entry.path),
      ...(entry.from ? { from: strip(entry.from) } : {}),
      status: entry.status,
      additions: hunks.reduce((count, hunk) => count + hunk.lines.filter((line) => line.kind === 'add').length, 0),
      deletions: hunks.reduce((count, hunk) => count + hunk.lines.filter((line) => line.kind === 'remove').length, 0),
      hunks,
      ...(note ? { note } : {}),
    })
  }

  return { ok: true, source: 'git', files, truncated, committed: true }
}

/**
 * Records what a project's folder holds now as its first state: starts a repository when
 * there is none, and commits everything in it.
 *
 * Why a commit and not just `init`: a repository with nothing committed has no "before",
 * so every file in it is new — a screen reading it would draw the whole folder as one
 * change. One commit is what gives a folder a state to be compared against, and from then
 * on the changes are the changes.
 *
 * The person's own act — it is their folder and their repository, so nothing here asks.
 * It refuses a folder that sits inside someone else's repository (a project pointed at one
 * directory of a larger checkout): recording a first state there would write a commit into
 * a repository this is not about.
 */
export async function startTracking(id: string): Promise<WorkTrackOutcome> {
  const placement = placeProject(id)
  if (!placement.ok) return { ok: false, error: placement.error }
  const root = placement.project.path

  const toplevel = await runGit(root, ['rev-parse', '--show-toplevel'])
  if ('failed' in toplevel) return { ok: false, error: toplevel.failed }
  const inside = toplevel.code === 0 ? toplevel.body.split('\n')[0]!.trim() : ''
  if (inside !== '' && inside !== root) {
    return { ok: false, error: `${placement.project.name} is inside the repository at ${inside} — nothing was written there.` }
  }

  if (inside === '') {
    const made = await runGit(root, ['init'])
    if ('failed' in made) return { ok: false, error: made.failed }
    if (made.code !== 0) return { ok: false, error: gitReason(made.body) }
  } else {
    // A repository that already has a state recorded has nothing *first* left to record,
    // and pressing again must never quietly commit whatever happens to be pending.
    const head = await runGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD'])
    if (!('failed' in head) && head.code === 0) {
      return { ok: false, error: `${placement.project.name} already has its first state recorded.` }
    }
  }

  // Everything, deletions included: the first state is the folder as it is.
  const staged = await runGit(root, ['add', '-A'])
  if ('failed' in staged) return { ok: false, error: staged.failed }
  if (staged.code !== 0) return { ok: false, error: gitReason(staged.body) }

  // An empty folder has no first state to record, and says so rather than making a commit
  // that records nothing.
  const anything = await runGit(root, ['diff', '--cached', '--quiet'])
  if (!('failed' in anything) && anything.code === 0) {
    return { ok: false, error: `there is nothing in ${placement.project.name} to record yet` }
  }

  const committed = await runGit(root, ['commit', '-m', FIRST_COMMIT])
  if ('failed' in committed) return { ok: false, error: committed.failed }
  if (committed.code !== 0) {
    // Git's own "who are you" refusal, said as what to do about it — and the folder is
    // left with everything staged, so setting a name and pressing again finishes the job.
    if (/identity unknown|tell me who you are|empty ident name/i.test(committed.body)) {
      return {
        ok: false,
        error: `git has no name to record this as — set one (git config --global user.name "Your Name" and user.email "you@example.com") and press again.`,
      }
    }
    return { ok: false, error: gitReason(committed.body) }
  }
  return { ok: true, path: root }
}

/** The first state, named the way every other tool names it. */
const FIRST_COMMIT = 'Initial commit'

/** One entry of `git status --porcelain -z`: its two letters, its path, and where it came from. */
interface StatusEntry {
  path: string
  from?: string
  status: WorkDiffStatus
}

/**
 * The porcelain output as entries. Its format is two letters, a space, the path and a
 * NUL — and for a rename or a copy, the path it came from as its own NUL-terminated
 * field after it, which is the reason the caller asks for `-z` rather than for lines.
 */
function parseStatus(body: string): StatusEntry[] {
  const fields = body.split('\u0000')
  const entries: StatusEntry[] = []
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!
    if (field.length < 4) continue
    const code = field.slice(0, 2)
    const file = field.slice(3)
    const moved = code.startsWith('R') || code.startsWith('C')
    const from = moved ? fields[index + 1] : undefined
    if (moved) index += 1
    entries.push({
      path: file,
      ...(from ? { from } : {}),
      status: statusOf(code),
    })
  }
  return entries
}

/** The two letters as one word: what happened to the file, in the screen's own terms. */
function statusOf(code: string): WorkDiffStatus {
  if (code === '??') return 'untracked'
  if (code.includes('R')) return 'renamed'
  if (code.includes('A')) return 'added'
  if (code.includes('D')) return 'deleted'
  return 'modified'
}

interface ParsedFile {
  hunks: WorkDiffHunk[]
  note?: string
}

/**
 * A unified diff as hunks per file. Only what a screen draws is kept — the `diff
 * --git` lines, the modes and the `index` lines carry nothing the file list does not
 * already say — and a file whose difference is not text is answered as that instead
 * of as a file with no changes.
 */
function parseDiff(body: string): Map<string, ParsedFile> {
  const files = new Map<string, ParsedFile>()
  let current: ParsedFile | null = null
  let hunk: WorkDiffHunk | null = null
  let oldLine = 0
  let newLine = 0

  const open = (file: string): ParsedFile => {
    const known = files.get(file)
    if (known) return known
    const made: ParsedFile = { hunks: [] }
    files.set(file, made)
    return made
  }

  // One trailing newline ends the diff; dropping it here keeps a blank line *inside*
  // a hunk meaningful, which is what `diff.suppressBlankEmpty` writes for one.
  const lines = body.endsWith('\n') ? body.slice(0, -1).split('\n') : body.split('\n')

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      hunk = null
      const paths = diffGitPaths(line)
      // The new path is where the changes belong; a deletion's is the last of the two.
      const last = paths[paths.length - 1]
      current = last === undefined || last === '/dev/null' ? null : open(last)
      continue
    }
    if (line.startsWith('--- ')) {
      // The old path is where a deleted file's hunks belong; an added file's is
      // `/dev/null`, and its hunks are opened by the `+++` line below.
      const file = unquotePath(line.slice(4))
      if (file !== '/dev/null') current = open(file)
      continue
    }
    if (line.startsWith('+++ ')) {
      const file = unquotePath(line.slice(4))
      if (file !== '/dev/null') current = open(file)
      continue
    }
    // A file whose difference is binary, or whose mode alone changed: both are said,
    // because a listed file with no hunk drawn would otherwise look like no change.
    if (line.startsWith('Binary files ')) {
      if (current) current.note = 'binary — the change is not drawn here'
      continue
    }
    if (line.startsWith('old mode ') || line.startsWith('new mode ')) {
      if (current && !current.note) current.note = 'permissions only — the file’s contents did not change'
      continue
    }
    if (line.startsWith('@@')) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
      if (!match || !current) {
        hunk = null
        continue
      }
      oldLine = Number(match[1])
      newLine = Number(match[2])
      hunk = { header: line.slice(3, line.indexOf('@@', 3)).trim(), lines: [] }
      current.hunks.push(hunk)
      continue
    }
    if (!current || !hunk) continue
    if (line.startsWith('\\')) continue
    // An empty line inside a hunk is a context line either way: git writes it as a
    // lone space, and with `diff.suppressBlankEmpty` as nothing at all.
    if (line === '') {
      hunk.lines.push({ kind: 'context', text: '', old: oldLine, new: newLine })
      oldLine += 1
      newLine += 1
      continue
    }
    const marker = line[0]
    if (marker === ' ') {
      hunk.lines.push({ kind: 'context', text: line.slice(1), old: oldLine, new: newLine })
      oldLine += 1
      newLine += 1
    } else if (marker === '-') {
      hunk.lines.push({ kind: 'remove', text: line.slice(1), old: oldLine })
      oldLine += 1
    } else if (marker === '+') {
      hunk.lines.push({ kind: 'add', text: line.slice(1), new: newLine })
      newLine += 1
    }
  }

  return files
}

/**
 * The two paths of a `diff --git` line. It is read with `--no-prefix`, so they arrive
 * as `x` and `x` — or `old new` for a rename — and a name holding a space comes quoted,
 * which is what makes splitting on the single space safe.
 */
function diffGitPaths(line: string): string[] {
  const rest = line.slice('diff --git '.length)
  if (rest.startsWith('"')) {
    const quoted = rest.match(/"(?:\\.|[^"\\])*"/g) ?? []
    return quoted.map((token) => unquotePath(token))
  }
  return rest.split(' ').map((token) => unquotePath(token))
}

/** A path as git wrote it: quoted and escaped when it holds anything awkward, raw otherwise. */
function unquotePath(raw: string): string {
  const value = raw.trim()
  if (!value.startsWith('"')) return value
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'string' ? parsed : value
  } catch {
    return value
  }
}

/** What git said when a read failed, as one line. */
function gitReason(body: string): string {
  const line = body.split('\n').find((candidate) => candidate.trim() !== '')
  return line?.trim() ?? 'git could not read this repository.'
}

function toPosix(file: string): string {
  return path.sep === '/' ? file : file.split(path.sep).join('/')
}
