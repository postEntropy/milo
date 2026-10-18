import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { browseFolders } from '../src/core/browse.js'

const tree = mkdtempSync(path.join(tmpdir(), 'milo-browse-'))

const folder = (name: string): string => {
  const dir = path.join(tree, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('browseFolders', () => {
  it('lists the folders inside one, by name, and nothing that is a file', () => {
    const dir = folder('work')
    mkdirSync(path.join(dir, 'zeta'))
    mkdirSync(path.join(dir, 'alpha'))
    writeFileSync(path.join(dir, 'notes.txt'), 'x')

    const listing = browseFolders(dir)
    expect(listing.path).toBe(dir)
    expect(listing.name).toBe('work')
    expect(listing.folders.map((entry) => entry.name)).toEqual(['alpha', 'zeta'])
    expect(listing.truncated).toBe(false)
  })

  it('offers the way up, and names it', () => {
    const dir = folder('work')
    expect(browseFolders(dir).parent).toBe(tree)
    // The filesystem root has nowhere to go up to, so the control is not offered there.
    expect(browseFolders('/').parent).toBeUndefined()
    expect(browseFolders('/').name).toBe('/')
  })

  it('keeps a symlink that leads to a folder, and drops one that leads nowhere', () => {
    const dir = folder('links')
    symlinkSync(folder('real'), path.join(dir, 'shortcut'))
    symlinkSync(path.join(dir, 'gone'), path.join(dir, 'dangling'))

    expect(browseFolders(dir).folders.map((entry) => entry.name)).toEqual(['shortcut'])
  })

  it('cuts a folder with too many children, and says it did', () => {
    const dir = folder('many')
    for (let index = 0; index < 201; index += 1) mkdirSync(path.join(dir, `d${String(index).padStart(3, '0')}`))

    const listing = browseFolders(dir)
    expect(listing.folders).toHaveLength(200)
    expect(listing.truncated).toBe(true)
  })

  it('starts at the home Milo runs as, and reads ~ as that home', () => {
    expect(browseFolders().path).toBe(homedir())
    expect(browseFolders('~').path).toBe(homedir())
  })

  it('says which folder it could not read, instead of answering an empty list', () => {
    const missing = path.join(tree, 'nowhere')
    expect(() => browseFolders(missing)).toThrow(`could not read ${missing}`)
  })

  it('reads a relative path from the daemon’s own directory', () => {
    const dir = folder('cwd-test')
    mkdirSync(path.join(dir, 'inner'))
    expect(browseFolders('inner', { cwd: dir }).path).toBe(path.join(dir, 'inner'))
  })

  it('leaves the tree as it found it', () => {
    rmSync(tree, { recursive: true, force: true })
    mkdirSync(tree, { recursive: true })
  })
})
