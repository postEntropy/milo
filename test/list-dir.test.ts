import { afterEach, describe, expect, it } from 'vitest'
import { listDirTool } from '../src/core/tools/list-dir.js'
import { ctxFor, makeDir, makeTree, type Tree } from './tree.js'

let tree: Tree

function build(files: Record<string, string | Buffer>): Tree {
  tree = makeTree(files)
  return tree
}

afterEach(() => tree?.cleanup())

describe('list_dir', () => {
  it('lists directories before files, and reports sizes', async () => {
    const { root } = build({
      'src/a.ts': 'const a = 1\n',
      'src/util/c.ts': 'const c = 3\n',
      'notes.md': '# notes\n',
    })

    const result = await listDirTool.execute({}, ctxFor(root))
    const lines = result.content.split('\n')

    expect(result.isError).toBeFalsy()
    expect(lines[0]).toBe('src/')
    expect(result.content).toMatch(/notes\.md\s+8 B/)
    expect(lines[1]).toContain('notes.md')
  })

  it('collapses build and dependency directories to a count', async () => {
    const { root } = build({
      'src/a.ts': 'x\n',
      'node_modules/dep/index.js': 'module.exports = 1\n',
      'dist/out.js': 'x\n',
    })

    const result = await listDirTool.execute({}, ctxFor(root))

    expect(result.content).not.toContain('node_modules/')
    expect(result.content).not.toContain('dist/')
    expect(result.content).toContain('(2 not expanded: dist, node_modules)')
  })

  it('lists a subdirectory', async () => {
    const { root } = build({ 'src/a.ts': 'const a = 1\n', 'src/util/c.ts': 'x\n' })

    const result = await listDirTool.execute({ path: 'src' }, ctxFor(root))

    expect(result.content.split('\n')[0]).toBe('util/')
    expect(result.content).toMatch(/a\.ts\s+12 B/)
  })

  it('says so when a directory is empty', async () => {
    const { root } = build({ 'a.txt': 'x\n' })
    makeDir(root, 'src')

    const result = await listDirTool.execute({ path: 'src' }, ctxFor(root))

    expect(result.content).toContain('(no entries in src)')
  })

  it('fails clearly on a missing directory', async () => {
    const { root } = build({ 'a.txt': 'x\n' })

    const result = await listDirTool.execute({ path: 'nope' }, ctxFor(root))

    expect(result.isError).toBe(true)
    expect(result.content).toContain('Failed to list nope')
  })

  it('fails clearly when the path is a file', async () => {
    const { root } = build({ 'a.txt': 'x\n' })

    const result = await listDirTool.execute({ path: 'a.txt' }, ctxFor(root))

    expect(result.isError).toBe(true)
    expect(result.content).toContain('Failed to list a.txt')
  })

  it('is read-only (never asks for confirmation)', () => {
    expect(listDirTool.readOnly).toBe(true)
  })
})
