import { chmodSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeFileTool } from '../src/core/tools/write-file'
import { ctxFor, makeTree, type Tree } from './tree'

let tree: Tree

function build(files: Record<string, string | Buffer>): Tree {
  tree = makeTree(files)
  return tree
}

afterEach(() => {
  tree?.cleanup()
  vi.unstubAllEnvs()
})

const read = (root: string, rel: string) => readFileSync(path.join(root, rel), 'utf8')

describe('write_file', () => {
  it('creates a file, including its parent directories', async () => {
    const { root } = build({})

    const result = await writeFileTool.execute(
      { path: 'src/deep/a.ts', content: 'const a = 1\n' },
      ctxFor(root),
    )

    expect(result.isError).toBeFalsy()
    expect(result.content).toContain('Created src/deep/a.ts')
    expect(result.content).toContain('1 line(s)')
    expect(read(root, 'src/deep/a.ts')).toBe('const a = 1\n')
  })

  it('replaces an existing file and says so', async () => {
    const { root } = build({ 'a.txt': 'old\n' })

    const result = await writeFileTool.execute({ path: 'a.txt', content: 'new\n' }, ctxFor(root))

    expect(result.content).toContain('Replaced a.txt')
    expect(read(root, 'a.txt')).toBe('new\n')
  })

  it('counts lines without being fooled by the trailing newline', async () => {
    const { root } = build({})

    const result = await writeFileTool.execute(
      { path: 'a.txt', content: 'one\ntwo\nthree\n' },
      ctxFor(root),
    )

    expect(result.content).toContain('3 line(s)')
  })

  it('writes an empty file as zero lines', async () => {
    const { root } = build({})

    const result = await writeFileTool.execute({ path: 'a.txt', content: '' }, ctxFor(root))

    expect(result.content).toContain('0 line(s)')
    expect(read(root, 'a.txt')).toBe('')
  })

  it('expands a leading ~ instead of creating a literal directory', async () => {
    const { root } = build({})
    vi.stubEnv('HOME', root)

    const result = await writeFileTool.execute({ path: '~/a.txt', content: 'x' }, ctxFor(root))

    expect(result.content).toContain('Created a.txt')
    expect(read(root, 'a.txt')).toBe('x')
  })

  it('refuses a directory target', async () => {
    const { root } = build({ 'src/a.ts': 'x\n' })

    const result = await writeFileTool.execute({ path: 'src', content: 'x' }, ctxFor(root))

    expect(result.isError).toBe(true)
    expect(result.content).toContain('is a directory')
  })

  it('is not read-only (it asks for confirmation)', () => {
    expect(writeFileTool.readOnly).toBe(false)
  })

  it('keeps the mode of the file it replaces', async () => {
    const { root } = build({ 'run.sh': '#!/bin/sh\necho old\n' })
    chmodSync(path.join(root, 'run.sh'), 0o755)

    await writeFileTool.execute({ path: 'run.sh', content: '#!/bin/sh\necho new\n' }, ctxFor(root))

    // A rename replaces the inode, so this is the write that would drop the
    // executable bit if the mode were not copied over.
    expect(statSync(path.join(root, 'run.sh')).mode & 0o777).toBe(0o755)
    expect(read(root, 'run.sh')).toContain('echo new')
  })

  it('leaves no temporary file behind', async () => {
    const { root } = build({})

    await writeFileTool.execute({ path: 'a.txt', content: 'x' }, ctxFor(root))

    expect(readdirSync(root)).toEqual(['a.txt'])
  })
})
