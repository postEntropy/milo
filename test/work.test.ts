import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WorkNode } from '../src/core/work.js'

// Point the install somewhere throwaway *before* the path module is loaded.
const home = mkdtempSync(path.join(tmpdir(), 'milo-work-'))
process.env.MILO_HOME = home

const { addProject } = await import('../src/core/projects.js')
const { createWorkFolder, workFile, workTree } = await import('../src/core/work.js')
const { projectsFile } = await import('../src/core/config/paths.js')

let counter = 0

/**
 * A project over a folder made of the files given, each written at its own relative path.
 * Every one gets a folder of its own, because the store refuses two projects in one place.
 */
async function project(files: Record<string, string> = {}): Promise<{ id: string; path: string }> {
  counter += 1
  const dir = path.join(home, `p-${counter}`)
  mkdirSync(dir, { recursive: true })
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, body)
  }
  const added = await addProject({ path: dir, name: 'Demo' })
  if (!added.ok) throw new Error(added.error)
  return { id: added.project.id, path: dir }
}

/** The tree's entries, flattened to `rel` strings, so a whole shape can be compared at once. */
function flat(nodes: WorkNode[]): string[] {
  return nodes.flatMap((node) => (node.kind === 'folder' ? [`${node.rel}/`, ...flat(node.children)] : [node.rel]))
}

beforeEach(() => {
  rmSync(projectsFile(), { force: true })
})

afterEach(() => {
  rmSync(projectsFile(), { force: true })
})

describe('workTree', () => {
  it('nests the files by folder, folders first and each by name', async () => {
    const { id } = await project({
      'b.txt': '',
      'a.txt': '',
      'src/z.ts': '',
      'src/a.ts': '',
      'docs/readme.md': '',
    })

    const tree = await workTree(id)
    expect(tree.ok).toBe(true)
    if (!tree.ok) return
    expect(flat(tree.nodes)).toEqual(['docs/', 'docs/readme.md', 'src/', 'src/a.ts', 'src/z.ts', 'a.txt', 'b.txt'])
    expect(tree.files).toBe(5)
    expect(tree.truncated).toBe(false)
  })

  it('draws a folder holding no file, and leaves out what the walk ignores', async () => {
    const { id, path: where } = await project({
      'kept.txt': '',
      'node_modules/dep/index.js': '',
      'dist/bundle.js': '',
      '.git/config': '',
    })
    mkdirSync(path.join(where, 'empty'), { recursive: true })

    const tree = await workTree(id)
    expect(tree.ok && flat(tree.nodes)).toEqual(['empty/', 'kept.txt'])
  })

  it('cuts the tree at its ceiling and says that it did', async () => {
    const files: Record<string, string> = {}
    for (let index = 0; index < 2001; index += 1) files[`f${String(index).padStart(4, '0')}.txt`] = ''
    const { id } = await project(files)

    const tree = await workTree(id)
    expect(tree.ok && tree.files).toBe(2000)
    expect(tree.ok && tree.truncated).toBe(true)
  })

  it('answers the reason when the project is not in the list', async () => {
    expect(await workTree('no-such-1')).toEqual({
      ok: false,
      error: 'the project no-such-1 is not in the list any more',
    })
  })

  it('says the folder is gone rather than walking nothing', async () => {
    const { id, path: where } = await project({ 'a.txt': '' })
    rmSync(where, { recursive: true })

    const tree = await workTree(id)
    expect(tree).toEqual({ ok: false, error: `the folder of Demo is gone (${where})` })
  })
})

describe('createWorkFolder', () => {
  it('makes a folder at the project’s root and answers the tree already holding it', async () => {
    const { id } = await project({ 'a.txt': '' })

    const tree = await createWorkFolder(id, '', 'notes')
    expect(tree.ok && flat(tree.nodes)).toEqual(['notes/', 'a.txt'])
  })

  it('makes one inside a folder, by that folder’s path', async () => {
    const { id } = await project({ 'src/a.ts': '' })

    const tree = await createWorkFolder(id, 'src', 'components')
    expect(tree.ok && flat(tree.nodes)).toEqual(['src/', 'src/components/', 'src/a.ts'])
  })

  it('says a name it cannot use rather than making nothing', async () => {
    const { id } = await project({})

    expect(await createWorkFolder(id, '', '  ')).toEqual({ ok: false, error: 'a folder needs a name' })
    expect(await createWorkFolder(id, '', 'a/b')).toEqual({ ok: false, error: 'a/b is not a folder name.' })
    expect(await createWorkFolder(id, '', '..')).toEqual({ ok: false, error: '.. is not a folder name.' })
  })

  it('refuses a name the tree leaves out, so a made folder is not then hidden', async () => {
    const { id } = await project({})

    expect(await createWorkFolder(id, '', 'node_modules')).toEqual({
      ok: false,
      error: 'node_modules is a folder the file tree leaves out — choose another name.',
    })
  })

  it('says a name already taken, and a parent that is not there', async () => {
    const { id, path: where } = await project({})
    mkdirSync(path.join(where, 'taken'))

    expect(await createWorkFolder(id, '', 'taken')).toEqual({ ok: false, error: 'taken already exists.' })
    const missing = await createWorkFolder(id, 'nope', 'inner')
    expect(missing.ok).toBe(false)
    if (missing.ok) return
    expect(missing.error).toContain('could not read nope:')
  })

  it('refuses a parent that climbs out of the project', async () => {
    const { id } = await project({})

    expect(await createWorkFolder(id, '../outside', 'x')).toEqual({
      ok: false,
      error: '../outside is not inside Demo.',
    })
  })

  it('refuses a parent that leads out through a symlink', async () => {
    const { id, path: where } = await project({})
    symlinkSync('/etc', path.join(where, 'shortcut'))

    expect(await createWorkFolder(id, 'shortcut', 'milo-test')).toEqual({
      ok: false,
      error: 'shortcut is not inside Demo.',
    })
  })
})

describe('workFile', () => {
  it('reads a file as the same numbered page the agent is handed', async () => {
    const { id } = await project({ 'a.txt': 'one\ntwo\n' })

    const page = await workFile(id, 'a.txt')
    expect(page.ok).toBe(true)
    if (!page.ok) return
    expect(page.text).toBe('1\tone\n2\ttwo')
    expect(page.from).toBe(1)
    expect(page.total).toBe(2)
    expect(page.next).toBeUndefined()
    expect(page.name).toBe('a.txt')
  })

  it('continues at the line the page named, and stops without one on the last', async () => {
    const lines = Array.from({ length: 500 }, (_, index) => `line ${index + 1}`).join('\n')
    const { id } = await project({ 'long.txt': `${lines}\n` })

    const first = await workFile(id, 'long.txt')
    expect(first.ok && first.text.split('\n')).toHaveLength(400)
    expect(first.ok && first.next).toBe(401)

    const next = await workFile(id, 'long.txt', { offset: 401 })
    expect(next.ok && next.from).toBe(401)
    expect(next.ok && next.text.split('\n')).toHaveLength(100)
    expect(next.ok && next.text.startsWith('401\tline 401')).toBe(true)
    expect(next.ok && next.next).toBeUndefined()
  })

  it('reads a file of a subfolder, from the project’s own root', async () => {
    const { id } = await project({ 'src/deep/a.ts': 'export const a = 1\n' })

    const page = await workFile(id, 'src/deep/a.ts')
    expect(page.ok && page.text).toBe('1\texport const a = 1')
  })

  it('says an empty file is empty rather than a line past its end', async () => {
    const { id } = await project({ 'empty.txt': '' })

    const page = await workFile(id, 'empty.txt')
    expect(page).toEqual({
      ok: true,
      rel: 'empty.txt',
      name: 'empty.txt',
      size: 0,
      text: '',
      from: 1,
      total: 0,
    })
  })

  it('names the line when it is past the end of the file', async () => {
    const { id } = await project({ 'a.txt': 'one\ntwo\n' })

    expect(await workFile(id, 'a.txt', { offset: 99 })).toEqual({
      ok: false,
      error: 'line 99 is past the end of a.txt — it has 2 line(s).',
    })
  })

  it('refuses a path that climbs out of the project', async () => {
    const { id } = await project({ 'a.txt': 'here', '..od.dots': 'kept' })

    expect(await workFile(id, '../outside.txt')).toEqual({ ok: false, error: '../outside.txt is not inside Demo.' })
    expect(await workFile(id, '/etc/hosts')).toEqual({ ok: false, error: '/etc/hosts is not inside Demo.' })
    // A file whose name only starts with the dots is inside the project like any other.
    expect((await workFile(id, '..od.dots')).ok).toBe(true)
  })

  it('refuses a path that leads out through a symlink', async () => {
    const { id, path: where } = await project({ 'a.txt': 'here' })
    symlinkSync('/etc/hosts', path.join(where, 'shortcut'))

    expect(await workFile(id, 'shortcut')).toEqual({ ok: false, error: 'shortcut is not inside Demo.' })
  })

  it('says a folder is not a file, and says a missing one in its own words', async () => {
    const { id, path: where } = await project({ 'src/a.ts': 'x' })
    mkdirSync(path.join(where, 'empty'), { recursive: true })

    expect(await workFile(id, 'src')).toEqual({ ok: false, error: 'src is not a file.' })
    const missing = await workFile(id, 'nope.txt')
    expect(missing.ok).toBe(false)
    if (missing.ok) return
    expect(missing.error).toContain('could not read nope.txt:')
  })

  it('refuses a binary as not text, rather than drawing garbage', async () => {
    const { id } = await project({ 'blob.bin': 'PNG\u0000\u0001\u0002' })

    expect(await workFile(id, 'blob.bin')).toEqual({ ok: false, error: 'blob.bin is not a text file.' })
  })

  it('says a file too big to read here instead of reading it into memory', async () => {
    const { id } = await project({ 'huge.log': 'x'.repeat(8 * 1024 * 1024 + 1) })

    expect(await workFile(id, 'huge.log')).toEqual({
      ok: false,
      error: 'huge.log is 8 MB — this reads files up to 8 MB.',
    })
  })

  it('answers a file with no path, and one whose project is gone', async () => {
    const { id, path: where } = await project({ 'a.txt': 'x' })
    expect(await workFile(id, '   ')).toEqual({ ok: false, error: 'a file needs a path' })

    rmSync(where, { recursive: true })
    expect(await workFile(id, 'a.txt')).toEqual({ ok: false, error: `the folder of Demo is gone (${where})` })
  })
})
