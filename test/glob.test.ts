import { afterEach, describe, expect, it } from 'vitest'
import { globTool } from '../src/core/tools/glob.js'
import { compileFilePattern, globToRegExp } from '../src/core/tools/walk.js'
import { ctxFor, makeTree, setMtime, type Tree } from './tree.js'

let tree: Tree

afterEach(() => tree?.cleanup())

describe('globToRegExp', () => {
  const matches = (pattern: string, candidate: string) => globToRegExp(pattern).test(candidate)

  it('treats **/ as zero or more segments', () => {
    expect(matches('**/*.ts', 'a.ts')).toBe(true)
    expect(matches('**/*.ts', 'src/a.ts')).toBe(true)
    expect(matches('**/*.ts', 'src/deep/a.ts')).toBe(true)
    expect(matches('**/*.ts', 'a.js')).toBe(false)
  })

  it('keeps * inside one segment', () => {
    expect(matches('src/*.ts', 'src/a.ts')).toBe(true)
    expect(matches('src/*.ts', 'src/util/a.ts')).toBe(false)
  })

  it('matches ? as a single non-slash character', () => {
    expect(matches('a?c.ts', 'abc.ts')).toBe(true)
    expect(matches('a?c.ts', 'a/c.ts')).toBe(false)
  })

  it('expands brace alternatives, including nested ones', () => {
    expect(matches('**/*.{test,spec}.ts', 'src/a.test.ts')).toBe(true)
    expect(matches('**/*.{test,spec}.ts', 'src/b.spec.ts')).toBe(true)
    expect(matches('**/*.{test,spec}.ts', 'src/b.ts')).toBe(false)
    expect(matches('{a,{b,c}}.ts', 'c.ts')).toBe(true)
  })

  it('supports character classes, negated too', () => {
    expect(matches('[a-c].ts', 'b.ts')).toBe(true)
    expect(matches('[a-c].ts', 'd.ts')).toBe(false)
    expect(matches('[!a].ts', 'b.ts')).toBe(true)
    expect(matches('[!a].ts', 'a.ts')).toBe(false)
  })

  it('treats regex metacharacters literally', () => {
    expect(matches('a+b.ts', 'a+b.ts')).toBe(true)
    expect(matches('a+b.ts', 'aab.ts')).toBe(false)
  })

  it('matches a bare pattern at any depth, like a caller means it', () => {
    expect(compileFilePattern('*.ts').test('src/deep/a.ts')).toBe(true)
    expect(compileFilePattern('src/*.ts').test('src/deep/a.ts')).toBe(false)
  })
})

describe('glob', () => {
  it('finds files by pattern, skipping build and dependency directories', async () => {
    tree = makeTree({
      'src/a.ts': 'x\n',
      'src/b.js': 'x\n',
      'src/util/c.ts': 'x\n',
      'notes.md': 'x\n',
      'node_modules/dep/d.ts': 'x\n',
      'dist/out.ts': 'x\n',
    })

    const result = await globTool.execute({ pattern: '**/*.ts' }, ctxFor(tree.root))

    expect(result.content).toContain('src/a.ts')
    expect(result.content).toContain('src/util/c.ts')
    expect(result.content).not.toContain('node_modules')
    expect(result.content).not.toContain('dist/out.ts')
  })

  it('matches a bare pattern at any depth', async () => {
    tree = makeTree({ 'src/deep/a.ts': 'x\n', 'src/b.js': 'x\n' })

    const result = await globTool.execute({ pattern: '*.ts' }, ctxFor(tree.root))

    expect(result.content).toContain('src/deep/a.ts')
    expect(result.content).not.toContain('b.js')
  })

  it('returns the most recently modified first', async () => {
    tree = makeTree({ 'old.ts': 'x\n', 'new.ts': 'x\n' })
    setMtime(tree.root, 'old.ts', 1_600_000_000)
    setMtime(tree.root, 'new.ts', 1_700_000_000)

    const result = await globTool.execute({ pattern: '*.ts' }, ctxFor(tree.root))

    expect(result.content.split('\n')).toEqual(['new.ts', 'old.ts'])
  })

  it('reports truncation with the real total', async () => {
    tree = makeTree({ 'a.ts': 'x\n', 'b.ts': 'x\n', 'c.ts': 'x\n' })

    const result = await globTool.execute({ pattern: '*.ts', limit: 2 }, ctxFor(tree.root))
    const lines = result.content.split('\n')

    expect(lines).toHaveLength(3)
    expect(lines[2]).toContain('3 matched, showing the 2 most recent')
  })

  it('says when nothing matches', async () => {
    tree = makeTree({ 'a.ts': 'x\n' })

    const result = await globTool.execute({ pattern: '**/*.rs' }, ctxFor(tree.root))

    expect(result.isError).toBeFalsy()
    expect(result.content).toContain('No files match')
  })

  it('rejects an invalid pattern', async () => {
    tree = makeTree({ 'a.ts': 'x\n' })

    const result = await globTool.execute({ pattern: '[z-a].ts' }, ctxFor(tree.root))

    expect(result.isError).toBe(true)
    expect(result.content).toContain('Invalid pattern')
  })

  it('rejects a missing directory and a file path', async () => {
    tree = makeTree({ 'a.ts': 'x\n' })

    expect((await globTool.execute({ pattern: '*', path: 'nope' }, ctxFor(tree.root))).isError).toBe(true)
    const file = await globTool.execute({ pattern: '*', path: 'a.ts' }, ctxFor(tree.root))
    expect(file.isError).toBe(true)
    expect(file.content).toContain('is not a directory')
  })

  it('is read-only (never asks for confirmation)', () => {
    expect(globTool.readOnly).toBe(true)
  })

  it('says a cancelled walk was cancelled', async () => {
    tree = makeTree({ 'a.ts': 'x\n' })
    const controller = new AbortController()
    controller.abort()

    const result = await globTool.execute(
      { pattern: '*.ts' },
      { cwd: tree.root, signal: controller.signal },
    )

    // An aborted walk is not the same as a finished one, and the answer says
    // which it was rather than reporting an empty result as a fact.
    expect(result.content).toContain('cancelled')
  })
})
