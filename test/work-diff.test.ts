import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WorkDiffFile } from '../src/core/work-diff.js'

// Point the install somewhere throwaway *before* the path module is loaded.
const home = mkdtempSync(path.join(tmpdir(), 'milo-diff-'))
process.env.MILO_HOME = home
// The machine's own git config — a signing key, a hook, a template — must not decide
// whether the suite passes, and the reader under test inherits this environment. What is
// left is the one thing a commit cannot do without: a name and an address.
const gitHome = mkdtempSync(path.join(tmpdir(), 'milo-gitcfg-'))
writeFileSync(path.join(gitHome, 'config'), '[user]\n\tname = Milo Test\n\temail = test@example.com\n')
process.env.GIT_CONFIG_GLOBAL = path.join(gitHome, 'config')
process.env.GIT_CONFIG_SYSTEM = '/dev/null'

const { addProject } = await import('../src/core/projects.js')
const { startTracking, workDiff } = await import('../src/core/work-diff.js')
const { projectsFile } = await import('../src/core/config/paths.js')

let counter = 0

/** A folder of its own, with the files given written into it at their own paths. */
function folder(files: Record<string, string> = {}): string {
  counter += 1
  const dir = path.join(home, `d-${counter}`)
  mkdirSync(dir, { recursive: true })
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, body)
  }
  return dir
}

/** A project over the folder, registered the way the Work screen registers one. */
async function project(dir: string): Promise<string> {
  const added = await addProject({ path: dir, name: 'Demo' })
  if (!added.ok) throw new Error(added.error)
  return added.project.id
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

/** A repository at `dir` with one commit, and the identity the tests commit as. */
function repository(dir: string, files: Record<string, string> = { 'a.txt': 'first\nsecond\nthird\n' }): void {
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Milo Test')
  git(dir, 'config', 'commit.gpgsign', 'false')
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, body)
  }
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'first commit')
}

/** The one file of an outcome that is a repository's, so a test can read it without narrowing twice. */
function only(files: WorkDiffFile[], where = 0): WorkDiffFile {
  const file = files[where]
  if (!file) throw new Error(`no file at ${where}`)
  return file
}

beforeEach(() => {
  rmSync(projectsFile(), { force: true })
})

afterEach(() => {
  rmSync(projectsFile(), { force: true })
})

describe('workDiff', () => {
  it('says a folder that is not a repository is not one', async () => {
    const id = await project(folder({ 'a.txt': 'x' }))

    expect(await workDiff(id)).toEqual({
      ok: true,
      source: 'none',
      reason: 'Demo is not a git repository.',
    })
  })

  it('answers the reason when the project is not in the list, or its folder is gone', async () => {
    expect(await workDiff('no-such-1')).toEqual({
      ok: false,
      error: 'the project no-such-1 is not in the list any more',
    })

    const dir = folder({ 'a.txt': 'x' })
    const id = await project(dir)
    rmSync(dir, { recursive: true })
    expect(await workDiff(id)).toEqual({ ok: false, error: `the folder of Demo is gone (${dir})` })
  })

  it('reads a change as its file, its hunks and both line numbers', async () => {
    const dir = folder()
    repository(dir)
    const id = await project(dir)
    writeFileSync(path.join(dir, 'a.txt'), 'first\nchanged\nthird\n')

    const diff = await workDiff(id)
    expect(diff.ok && diff.source).toBe('git')
    if (!diff.ok || diff.source !== 'git') return
    expect(diff.truncated).toBe(false)

    const file = only(diff.files)
    expect(file.path).toBe('a.txt')
    expect(file.status).toBe('modified')
    expect(file.additions).toBe(1)
    expect(file.deletions).toBe(1)
    expect(file.hunks).toHaveLength(1)
    expect(file.hunks[0]!.lines).toEqual([
      { kind: 'context', text: 'first', old: 1, new: 1 },
      { kind: 'remove', text: 'second', old: 2 },
      { kind: 'add', text: 'changed', new: 2 },
      { kind: 'context', text: 'third', old: 3, new: 3 },
    ])
  })

  it('names a file that is new, one that is gone, and one git does not track yet', async () => {
    const dir = folder()
    repository(dir)
    const id = await project(dir)

    writeFileSync(path.join(dir, 'added.txt'), 'brand new\n')
    rmSync(path.join(dir, 'a.txt'))
    writeFileSync(path.join(dir, 'untracked.txt'), 'never added\n')
    git(dir, 'add', 'added.txt')
    git(dir, 'rm', '-q', '--cached', 'a.txt')

    const diff = await workDiff(id)
    if (!diff.ok || diff.source !== 'git') throw new Error('expected a repository')
    const byPath = new Map(diff.files.map((file) => [file.path, file]))
    expect(byPath.get('added.txt')?.status).toBe('added')
    expect(byPath.get('added.txt')?.hunks[0]?.lines).toEqual([{ kind: 'add', text: 'brand new', new: 1 }])
    expect(byPath.get('a.txt')?.status).toBe('deleted')
    expect(byPath.get('a.txt')?.hunks[0]?.lines).toEqual([
      { kind: 'remove', text: 'first', old: 1 },
      { kind: 'remove', text: 'second', old: 2 },
      { kind: 'remove', text: 'third', old: 3 },
    ])
    expect(byPath.get('untracked.txt')?.status).toBe('untracked')
    expect(byPath.get('untracked.txt')?.hunks).toEqual([])
  })

  it('carries a rename with the path it came from', async () => {
    const dir = folder()
    repository(dir)
    const id = await project(dir)
    git(dir, 'mv', 'a.txt', 'moved.txt')

    const diff = await workDiff(id)
    if (!diff.ok || diff.source !== 'git') throw new Error('expected a repository')
    const file = only(diff.files)
    expect(file.status).toBe('renamed')
    expect(file.path).toBe('moved.txt')
    expect(file.from).toBe('a.txt')
  })

  it('says a binary change instead of drawing it', async () => {
    const dir = folder()
    repository(dir, { 'a.txt': 'text\n', 'blob.bin': 'PNG\u0000first' })
    const id = await project(dir)
    writeFileSync(path.join(dir, 'blob.bin'), 'PNG\u0000second')

    const diff = await workDiff(id)
    if (!diff.ok || diff.source !== 'git') throw new Error('expected a repository')
    const file = only(diff.files)
    expect(file.path).toBe('blob.bin')
    expect(file.hunks).toEqual([])
    expect(file.note).toBe('binary — the change is not drawn here')
  })

  it('answers a change in a folder of a repository, and only that folder', async () => {
    const repo = folder()
    mkdirSync(path.join(repo, 'one'), { recursive: true })
    mkdirSync(path.join(repo, 'two'), { recursive: true })
    repository(repo, { 'one/a.txt': 'first\n', 'two/b.txt': 'other\n' })
    const id = await project(path.join(repo, 'one'))

    writeFileSync(path.join(repo, 'one', 'a.txt'), 'changed\n')
    writeFileSync(path.join(repo, 'two', 'b.txt'), 'touched\n')

    const diff = await workDiff(id)
    if (!diff.ok || diff.source !== 'git') throw new Error('expected a repository')
    expect(diff.files.map((file) => file.path)).toEqual(['a.txt'])
  })

  it('reads what is staged in a repository that has no commits yet', async () => {
    const dir = folder({ 'a.txt': 'the first thing\n' })
    git(dir, 'init', '-q')
    git(dir, 'config', 'user.email', 'test@example.com')
    git(dir, 'config', 'user.name', 'Milo Test')
    git(dir, 'add', 'a.txt')
    const id = await project(dir)

    // Nothing committed means nothing to compare against: the answer is that there is no
    // change to read, not every file in the folder drawn as one.
    expect(await workDiff(id)).toEqual({ ok: true, source: 'git', files: [], truncated: false, committed: false })
  })

  it('answers a clean working tree with no files at all', async () => {
    const dir = folder()
    repository(dir)
    const id = await project(dir)

    expect(await workDiff(id)).toEqual({ ok: true, source: 'git', files: [], truncated: false, committed: true })
  })

  it('reads a change the way the machine’s own git config writes it', async () => {
    // `diff.mnemonicprefix` renames the `a/`/`b/` prefixes to one per source (`c/` and
    // `w/`), and `diff.suppressBlankEmpty` writes a blank context line as nothing at
    // all. Neither may cost the reader a hunk or a line in it.
    const dir = folder()
    repository(dir, { 'a.txt': 'first\n\nthird\n' })
    const id = await project(dir)
    git(dir, 'config', 'diff.mnemonicprefix', 'true')
    git(dir, 'config', 'diff.suppressBlankEmpty', 'true')
    writeFileSync(path.join(dir, 'a.txt'), 'first\n\nchanged\n')

    const diff = await workDiff(id)
    if (!diff.ok || diff.source !== 'git') throw new Error('expected a repository')
    const file = only(diff.files)
    expect(file.path).toBe('a.txt')
    expect(file.hunks[0]?.lines).toEqual([
      { kind: 'context', text: 'first', old: 1, new: 1 },
      { kind: 'context', text: '', old: 2, new: 2 },
      { kind: 'remove', text: 'third', old: 3 },
      { kind: 'add', text: 'changed', new: 3 },
    ])
  })
})

describe('startTracking', () => {
  it('records the folder’s first state, and the changes are read from then on', async () => {
    const dir = folder({ 'a.txt': 'hello\n' })
    const id = await project(dir)
    expect(await workDiff(id)).toMatchObject({ ok: true, source: 'none' })

    expect(await startTracking(id)).toEqual({ ok: true, path: dir })

    // Everything in the folder is the state it was recorded in, so nothing has changed —
    // which is the whole point of pressing it.
    expect(await workDiff(id)).toEqual({ ok: true, source: 'git', files: [], truncated: false, committed: true })

    writeFileSync(path.join(dir, 'a.txt'), 'goodbye\n')
    const after = await workDiff(id)
    if (!after.ok || after.source !== 'git') throw new Error('expected a repository')
    expect(only(after.files).path).toBe('a.txt')
    expect(only(after.files).status).toBe('modified')
  })

  it('records the first state of a repository somebody started and never committed', async () => {
    const dir = folder({ 'a.txt': 'hello\n' })
    git(dir, 'init', '-q')
    const id = await project(dir)
    expect(await workDiff(id)).toMatchObject({ source: 'git', committed: false })

    expect(await startTracking(id)).toEqual({ ok: true, path: dir })
    expect(await workDiff(id)).toEqual({ ok: true, source: 'git', files: [], truncated: false, committed: true })
  })

  it('refuses a folder that sits inside someone else’s repository', async () => {
    const repo = folder()
    mkdirSync(path.join(repo, 'one'), { recursive: true })
    repository(repo, { 'one/a.txt': 'first\n' })
    const id = await project(path.join(repo, 'one'))

    expect(await startTracking(id)).toEqual({
      ok: false,
      error: `Demo is inside the repository at ${repo} — nothing was written there.`,
    })
  })

  it('answers an empty folder, and a repository that already has its first state, in its own words', async () => {
    const empty = folder()
    const emptyId = await project(empty)
    expect(await startTracking(emptyId)).toEqual({ ok: false, error: 'there is nothing in Demo to record yet' })

    const dir = folder({ 'a.txt': 'hello\n' })
    const id = await project(dir)
    expect(await startTracking(id)).toEqual({ ok: true, path: dir })
    // A second press must never quietly commit whatever happens to be pending.
    writeFileSync(path.join(dir, 'a.txt'), 'changed\n')
    expect(await startTracking(id)).toEqual({
      ok: false,
      error: 'Demo already has its first state recorded.',
    })
  })

  it('says what to set when git has no name to record the commit as', async () => {
    const dir = folder({ 'a.txt': 'hello\n' })
    const id = await project(dir)
    // The one way to ask a machine with no identity: take the global config away for this
    // call. Nothing is half-recorded — everything is staged, so the next press finishes it.
    const global = process.env.GIT_CONFIG_GLOBAL
    process.env.GIT_CONFIG_GLOBAL = '/dev/null'
    try {
      const outcome = await startTracking(id)
      expect(outcome.ok).toBe(false)
      if (outcome.ok) return
      expect(outcome.error).toContain('no name to record this as')
    } finally {
      if (global === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = global
    }

    expect(await startTracking(id)).toEqual({ ok: true, path: dir })
  })

  it('answers the reason when the project is not in the list, or its folder is gone', async () => {
    expect(await startTracking('no-such-1')).toEqual({
      ok: false,
      error: 'the project no-such-1 is not in the list any more',
    })

    const dir = folder({ 'a.txt': 'x' })
    const id = await project(dir)
    rmSync(dir, { recursive: true })
    expect(await startTracking(id)).toEqual({ ok: false, error: `the folder of Demo is gone (${dir})` })
  })
})
