import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { gitCommitTool, gitTool } from '../src/core/tools/git.js'

const signal = new AbortController().signal

/**
 * A repository of the test's own, configured from the environment rather than
 * the machine's: the developer's global git config — a signing key, a commit
 * hook, a template — must not decide whether the suite passes.
 */
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

describe('git', () => {
  let dir: string

  function git(...args: string[]): string {
    return execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    })
  }

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'milo-git-'))
    assert(dir, 'no temp directory')
    git('init', '-q')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Milo Test')
    git('config', 'commit.gpgsign', 'false')
    await writeFile(path.join(dir, 'a.txt'), 'first\n')
    git('add', 'a.txt')
    git('commit', '-q', '-m', 'first commit')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const ctx = () => ({ cwd: dir, signal })

  it('reports the working tree with status', async () => {
    await writeFile(path.join(dir, 'a.txt'), 'changed\n')
    const result = await gitTool.execute({ action: 'status' }, ctx())
    expect(result.isError).toBeFalsy()
    expect(result.content).toContain('a.txt')
  })

  it('shows unstaged changes with diff', async () => {
    await writeFile(path.join(dir, 'a.txt'), 'changed\n')
    const result = await gitTool.execute({ action: 'diff' }, ctx())
    expect(result.content).toContain('-first')
    expect(result.content).toContain('+changed')
  })

  it('shows staged changes only when asked', async () => {
    await writeFile(path.join(dir, 'a.txt'), 'staged\n')
    git('add', 'a.txt')
    const result = await gitTool.execute({ action: 'diff', staged: true }, ctx())
    expect(result.content).toContain('+staged')
  })

  it('lists history with log', async () => {
    const result = await gitTool.execute({ action: 'log' }, ctx())
    expect(result.content).toContain('first commit')
  })

  it('shows a commit with show', async () => {
    const result = await gitTool.execute({ action: 'show', ref: 'HEAD' }, ctx())
    expect(result.content).toContain('first commit')
  })

  it('does not interpret a revision argument as a Git option', async () => {
    const output = path.join(dir, 'option-output.txt')
    const result = await gitTool.execute({ action: 'show', ref: `--output=${output}` }, ctx())
    expect(result.isError).toBe(true)
    expect(existsSync(output)).toBe(false)
  })

  it('names the author of a line with blame', async () => {
    const result = await gitTool.execute({ action: 'blame', path: 'a.txt' }, ctx())
    expect(result.content).toContain('Milo Test')
  })

  it('refuses an argument the action does not take, naming the ones it does', async () => {
    const result = await gitTool.execute({ action: 'status', ref: 'main' }, ctx())
    expect(result.isError).toBe(true)
    expect(result.content).toContain('status')
    expect(result.content).toContain('ref')
    expect(result.content).toContain('path')
  })

  it('refuses blame without a path', async () => {
    const result = await gitTool.execute({ action: 'blame' }, ctx())
    expect(result.isError).toBe(true)
    expect(result.content).toContain('path')
  })

  it('reports a directory that is not a repository rather than pretending', async () => {
    const plain = await mkdtemp(path.join(tmpdir(), 'milo-nogit-'))
    try {
      const result = await gitTool.execute({ action: 'status' }, { cwd: plain, signal })
      expect(result.isError).toBe(true)
      expect(result.content).toContain('exit 128')
    } finally {
      await rm(plain, { recursive: true, force: true })
    }
  })

  it('is read-only and never asks', () => {
    expect(gitTool.readOnly).toBe(true)
    expect(gitTool.asksWhen).toBeUndefined()
  })
})

describe('git_commit', () => {
  let dir: string

  function git(...args: string[]): string {
    return execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    })
  }

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'milo-gitc-'))
    git('init', '-q')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Milo Test')
    git('config', 'commit.gpgsign', 'false')
    await writeFile(path.join(dir, 'a.txt'), 'first\n')
    git('add', 'a.txt')
    git('commit', '-q', '-m', 'first commit')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const ctx = () => ({ cwd: dir, signal })
  const log = () =>
    execFileSync('git', ['log', '--oneline'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    })

  it('stages the named files and commits them', async () => {
    await writeFile(path.join(dir, 'a.txt'), 'second\n')
    const result = await gitCommitTool.execute({ message: 'second commit', files: ['a.txt'] }, ctx())
    expect(result.isError).toBeFalsy()
    expect(log()).toContain('second commit')
  })

  it('stages every tracked change with all', async () => {
    await writeFile(path.join(dir, 'a.txt'), 'third\n')
    const result = await gitCommitTool.execute({ message: 'third commit', all: true }, ctx())
    expect(result.isError).toBeFalsy()
    expect(log()).toContain('third commit')
  })

  it('refuses a commit with no message', async () => {
    const result = await gitCommitTool.execute({ message: '   ' }, ctx())
    expect(result.isError).toBe(true)
    expect(result.content).toContain('message')
  })

  it('refuses naming files and all at once', async () => {
    const result = await gitCommitTool.execute({ message: 'x', files: ['a.txt'], all: true }, ctx())
    expect(result.isError).toBe(true)
    expect(result.content).toContain('either')
  })

  it('is not read-only, so the policy asks before it runs', () => {
    expect(gitCommitTool.readOnly).toBe(false)
  })
})
