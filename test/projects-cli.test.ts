import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// Point the install somewhere throwaway *before* the path module is loaded.
const home = mkdtempSync(path.join(tmpdir(), 'milo-projects-cli-'))
process.env.MILO_HOME = home

const { runProjects } = await import('../src/bin/projects.js')
const { readProjects } = await import('../src/core/projects.js')

interface Ran {
  lines: string[]
  errors: string[]
  code: number
}

async function run(...args: string[]): Promise<Ran> {
  const lines: string[] = []
  const errors: string[] = []
  const code = await runProjects(['projects', ...args], {
    out: (line) => lines.push(line),
    err: (line) => errors.push(line),
  })
  return { lines, errors, code }
}

/** A folder that is there, for a project to point at. */
const folder = (name: string): string => {
  const dir = path.join(home, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('milo projects', () => {
  beforeEach(() => {
    // Every test starts from an empty list; the file itself is the state.
    rmSync(path.join(home, 'projects.json'), { force: true })
  })

  afterEach(() => {
    rmSync(path.join(home, 'projects.json'), { force: true })
  })

  it('says there are none, and how to add one', async () => {
    const { lines, code } = await run('list')
    expect(code).toBe(0)
    expect(lines[0]).toBe('No projects.')
    expect(lines[1]).toContain('milo projects add')
  })

  it('adds a folder and lists it by name, id and path', async () => {
    const where = folder('milo')
    const added = await run('add', where, '--name', 'Milo')
    expect(added.code).toBe(0)
    expect(added.lines[0]).toContain('Added Milo')

    const listed = await run('list')
    expect(listed.lines[0]).toContain('Milo')
    expect(listed.lines[1]).toContain(where)
  })

  it('names a project after its folder when no name is given', async () => {
    const where = folder('apps')
    const { lines } = await run('add', where)
    expect(lines[0]).toBe(`Added apps (${readProjects()[0]!.id}) at ${where}.`)
  })

  it('says which folder is not there, instead of registering it', async () => {
    const missing = path.join(home, 'nowhere')
    const { errors, code } = await run('add', missing)
    expect(code).toBe(1)
    expect(errors[0]).toBe(`there is no folder at ${missing}`)
  })

  it('answers an unknown project with the ones it knows', async () => {
    await run('add', folder('milo'), '--name', 'Milo')

    const { errors, code } = await run('remove', 'other')
    expect(code).toBe(1)
    expect(errors[0]).toContain('No project "other".')
    expect(errors[0]).toContain('Milo')
  })

  it('renames and moves by name, and says what each came to', async () => {
    await run('add', folder('milo'), '--name', 'Milo')

    const renamed = await run('rename', 'Milo', '--name', 'Milo Work')
    expect(renamed.lines[0]).toContain('Milo Work')

    const moved = await run('move', 'Milo Work', folder('other'))
    expect(moved.lines[0]).toContain(path.join(home, 'other'))
    expect(readProjects()[0]!.path).toBe(path.join(home, 'other'))
  })

  it('refuses a rename with nothing to rename it to', async () => {
    await run('add', folder('milo'))

    const { errors, code } = await run('rename', 'milo')
    expect(code).toBe(1)
    expect(errors[0]).toContain('rename needs --name')
  })

  it('says a name that matches two projects rather than picking one', async () => {
    await run('add', folder('one'), '--name', 'apps')
    await run('add', folder('two'), '--name', 'apps')

    const { errors, code } = await run('remove', 'apps')
    expect(code).toBe(1)
    expect(errors[0]).toContain('2 projects are called apps')
  })

  it('drops a project, and says the sessions are not dropped with it', async () => {
    await run('add', folder('milo'), '--name', 'Milo')

    const { lines, code } = await run('remove', 'Milo')
    expect(code).toBe(0)
    expect(lines[0]).toContain('Sessions that ran there stay')
    expect(readProjects()).toEqual([])
  })

  it('flags a project whose folder is gone', async () => {
    const where = folder('milo')
    await run('add', where, '--name', 'Milo')
    rmSync(where, { recursive: true })

    const { lines } = await run('list')
    expect(lines[1]).toContain('is gone')
  })

  it('answers an unknown subcommand with the valid ones', async () => {
    const { errors, code } = await run('frobnicate')
    expect(code).toBe(1)
    expect(errors[0]).toBe('Unknown: milo projects frobnicate')
    expect(errors[1]).toContain('Usage:')
  })
})
