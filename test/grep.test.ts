import { afterEach, describe, expect, it } from 'vitest'
import { grepTool } from '../src/core/tools/grep'
import { ctxFor, makeTree, type Tree } from './tree'

let tree: Tree

function build(files: Record<string, string | Buffer>): Tree {
  tree = makeTree(files)
  return tree
}

afterEach(() => tree?.cleanup())

const STANDARD = {
  'src/a.ts': 'const alpha = 1\nexport const beta = 2\n',
  'src/b.ts': 'const ALPHA = 3\n',
  'src/util/c.ts': 'alpha again\n',
  'notes.md': 'alpha in notes\n',
  'node_modules/dep/index.js': 'alpha in dep\n',
  'dist/out.js': 'alpha in dist\n',
}

describe('grep', () => {
  it('finds matches across files and skips build and dependency directories', async () => {
    const { root } = build(STANDARD)

    const result = await grepTool.execute({ pattern: 'alpha' }, ctxFor(root))

    expect(result.content).toContain('src/a.ts:1: const alpha = 1')
    expect(result.content).toContain('src/util/c.ts:1: alpha again')
    expect(result.content).toContain('notes.md:1: alpha in notes')
    expect(result.content).not.toContain('node_modules')
    expect(result.content).not.toContain('dist/out.js')
  })

  it('skips binary files and says how many', async () => {
    const { root } = build({
      'a.txt': 'alpha\n',
      'blob.bin': Buffer.from('alpha\0binary', 'utf8'),
    })

    const result = await grepTool.execute({ pattern: 'alpha' }, ctxFor(root))

    expect(result.content).toContain('a.txt:1: alpha')
    expect(result.content).not.toContain('blob.bin')
    expect(result.content).toContain('1 binary or large file(s) skipped')
  })

  it('ignores case on request', async () => {
    const { root } = build(STANDARD)

    const result = await grepTool.execute({ pattern: 'alpha', ignoreCase: true }, ctxFor(root))

    expect(result.content).toContain('src/b.ts:1: const ALPHA = 3')
  })

  it('filters files with a glob', async () => {
    const { root } = build(STANDARD)

    const result = await grepTool.execute({ pattern: 'alpha', glob: '*.ts' }, ctxFor(root))

    expect(result.content).toContain('src/a.ts')
    expect(result.content).not.toContain('notes.md')
  })

  it('shows context lines around a match', async () => {
    const { root } = build(STANDARD)

    const result = await grepTool.execute({ pattern: 'beta', context: 1 }, ctxFor(root))

    expect(result.content).toContain('src/a.ts-1- const alpha = 1')
    expect(result.content).toContain('src/a.ts:2: export const beta = 2')
  })

  it('stops at the limit and says so', async () => {
    const { root } = build(STANDARD)

    const result = await grepTool.execute({ pattern: 'alpha', limit: 2 }, ctxFor(root))
    const matches = result.content.split('\n').filter((line) => /:\d+: /.test(line))

    expect(matches).toHaveLength(2)
    expect(result.content).toContain('stopped at 2 matches')
  })

  it('searches a single file', async () => {
    const { root } = build(STANDARD)

    const result = await grepTool.execute({ pattern: 'ALPHA', path: 'src/b.ts' }, ctxFor(root))

    expect(result.content).toBe('src/b.ts:1: const ALPHA = 3')
  })

  it('says when nothing matches', async () => {
    const { root } = build(STANDARD)

    const result = await grepTool.execute({ pattern: 'zzz' }, ctxFor(root))

    expect(result.isError).toBeFalsy()
    expect(result.content).toContain('No matches for /zzz/')
  })

  it('rejects an invalid pattern', async () => {
    const { root } = build(STANDARD)

    const result = await grepTool.execute({ pattern: 'a(' }, ctxFor(root))

    expect(result.isError).toBe(true)
    expect(result.content).toContain('Invalid pattern')
  })

  it('rejects a missing path', async () => {
    const { root } = build(STANDARD)

    const result = await grepTool.execute({ pattern: 'alpha', path: 'nope' }, ctxFor(root))

    expect(result.isError).toBe(true)
    expect(result.content).toContain('No such file or directory')
  })

  it('is read-only (never asks for confirmation)', () => {
    expect(grepTool.readOnly).toBe(true)
  })
})
