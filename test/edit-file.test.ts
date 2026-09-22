import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { editFileTool } from '../src/core/tools/edit-file'
import { ctxFor, makeTree, type Tree } from './tree'

let tree: Tree

function build(files: Record<string, string | Buffer>): Tree {
  tree = makeTree(files)
  return tree
}

afterEach(() => tree?.cleanup())

const read = (root: string, rel: string) => readFileSync(path.join(root, rel), 'utf8')

describe('edit_file', () => {
  it('replaces a unique string and leaves the rest of the file alone', async () => {
    const { root } = build({ 'a.ts': 'const a = 1\nconst b = 2\n' })

    const result = await editFileTool.execute(
      { path: 'a.ts', old_string: 'const b = 2', new_string: 'const b = 3' },
      ctxFor(root),
    )

    expect(result.isError).toBeFalsy()
    expect(result.content).toContain('Edited a.ts')
    expect(read(root, 'a.ts')).toBe('const a = 1\nconst b = 3\n')
  })

  it('reports the line the replacement landed on', async () => {
    const { root } = build({ 'a.ts': 'one\ntwo\nTARGET\nfour\n' })

    const result = await editFileTool.execute(
      { path: 'a.ts', old_string: 'TARGET', new_string: 'hit' },
      ctxFor(root),
    )

    expect(result.content).toContain('at line 3')
  })

  it('fails when the string is absent, rather than writing anything', async () => {
    const { root } = build({ 'a.ts': 'const a = 1\n' })

    const result = await editFileTool.execute(
      { path: 'a.ts', old_string: 'const z = 9', new_string: 'x' },
      ctxFor(root),
    )

    expect(result.isError).toBe(true)
    expect(result.content).toContain('was not found in a.ts')
    expect(read(root, 'a.ts')).toBe('const a = 1\n')
  })

  it('refuses an ambiguous string and names the count', async () => {
    const { root } = build({ 'a.ts': 'const a = 1\nconst a = 1\n' })

    const result = await editFileTool.execute(
      { path: 'a.ts', old_string: 'const a = 1', new_string: 'const a = 2' },
      ctxFor(root),
    )

    expect(result.isError).toBe(true)
    expect(result.content).toContain('appears 2 times')
    expect(read(root, 'a.ts')).toBe('const a = 1\nconst a = 1\n')
  })

  it('replaces every occurrence when asked', async () => {
    const { root } = build({ 'a.ts': 'const a = 1\nconst a = 1\n' })

    const result = await editFileTool.execute(
      { path: 'a.ts', old_string: 'const a = 1', new_string: 'const a = 2', replace_all: true },
      ctxFor(root),
    )

    expect(result.content).toContain('replaced 2 occurrence(s)')
    expect(read(root, 'a.ts')).toBe('const a = 2\nconst a = 2\n')
  })

  it('treats $& and $1 in the replacement as literal text', async () => {
    const { root } = build({ 'a.ts': 'const value = OLD\n' })

    await editFileTool.execute(
      { path: 'a.ts', old_string: 'OLD', new_string: '$& and $1 and $`' },
      ctxFor(root),
    )

    expect(read(root, 'a.ts')).toBe('const value = $& and $1 and $`\n')
  })

  it('rejects an empty old_string', async () => {
    const { root } = build({ 'a.ts': 'x\n' })

    const result = await editFileTool.execute(
      { path: 'a.ts', old_string: '', new_string: 'x' },
      ctxFor(root),
    )

    expect(result.isError).toBe(true)
    expect(result.content).toContain('must not be empty')
  })

  it('points at write_file when the file does not exist', async () => {
    const { root } = build({})

    const result = await editFileTool.execute(
      { path: 'nope.ts', old_string: 'a', new_string: 'b' },
      ctxFor(root),
    )

    expect(result.isError).toBe(true)
    expect(result.content).toContain('use write_file')
  })

  it('is not read-only (it asks for confirmation)', () => {
    expect(editFileTool.readOnly).toBe(false)
  })
})
