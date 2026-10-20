import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// Point the install somewhere throwaway *before* the path module is loaded.
const home = mkdtempSync(path.join(tmpdir(), 'milo-projects-'))
process.env.MILO_HOME = home

const {
  addProject,
  byRecentUse,
  findProject,
  MAX_PROJECTS,
  placedProject,
  placeProject,
  readProjects,
  removeProject,
  updateProject,
} = await import('../src/core/projects.js')
const { projectsFile } = await import('../src/core/config/paths.js')

/** A folder that is there, for a project to point at. */
const folder = (name: string): string => {
  const dir = path.join(home, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

const writeList = (value: unknown) => {
  writeFileSync(projectsFile(), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`)
}

beforeEach(() => {
  rmSync(projectsFile(), { force: true })
})

afterEach(() => {
  rmSync(projectsFile(), { force: true })
})

describe('addProject', () => {
  it('registers a folder and names it after the folder', async () => {
    const where = folder('milo')
    const outcome = await addProject({ path: where })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.project.name).toBe('milo')
    expect(outcome.project.path).toBe(where)
    expect(outcome.project.id).toMatch(/^[a-z]+-[a-z]+-\d+$/)
    expect(readProjects()).toHaveLength(1)
  })

  it('keeps the name it was given', async () => {
    const outcome = await addProject({ path: folder('milo'), name: '  Milo  ' })
    expect(outcome.ok && outcome.project.name).toBe('Milo')
  })

  it('reads a folder that is not there as a refusal, and says which one', async () => {
    const outcome = await addProject({ path: path.join(home, 'nowhere') })
    expect(outcome).toEqual({ ok: false, error: `there is no folder at ${path.join(home, 'nowhere')}` })
  })

  it('refuses a project with no folder named', async () => {
    expect(await addProject({ path: '   ' })).toEqual({ ok: false, error: 'a project needs a folder' })
  })

  it('refuses a folder another project already is', async () => {
    const where = folder('milo')
    await addProject({ path: where, name: 'Milo' })
    expect(await addProject({ path: where })).toEqual({
      ok: false,
      error: `${where} is already the project Milo`,
    })
  })

  it('stops at the ceiling', async () => {
    writeList(
      Array.from({ length: MAX_PROJECTS }, (_, index) => ({
        id: `calm-otter-${index + 1}`,
        name: `p${index}`,
        path: `/tmp/p${index}`,
        createdAt: 1,
      })),
    )
    const outcome = await addProject({ path: folder('one-too-many') })
    expect(outcome).toEqual({ ok: false, error: `at most ${MAX_PROJECTS} projects — remove one first` })
  })

  it('refuses to write over a list it could not read', async () => {
    writeList('{ this is not json')
    await expect(addProject({ path: folder('milo') })).rejects.toThrow(/not valid JSON/)
    expect(readFileSync(projectsFile(), 'utf8')).toBe('{ this is not json')
  })
})

describe('updateProject', () => {
  it('renames a project', async () => {
    const added = await addProject({ path: folder('milo') })
    if (!added.ok) throw new Error('the project was not added')
    const outcome = await updateProject(added.project.id, { name: 'Milo Work' })
    expect(outcome.ok && outcome.project.name).toBe('Milo Work')
    expect(outcome.ok && outcome.project.path).toBe(added.project.path)
  })

  it('falls back to the folder name when the name is cleared', async () => {
    const where = folder('milo')
    const added = await addProject({ path: where, name: 'Named' })
    if (!added.ok) throw new Error('the project was not added')
    const outcome = await updateProject(added.project.id, { name: '  ' })
    expect(outcome.ok && outcome.project.name).toBe('milo')
  })

  it('moves a project to another folder', async () => {
    const added = await addProject({ path: folder('one') })
    if (!added.ok) throw new Error('the project was not added')
    const moved = folder('two')
    const outcome = await updateProject(added.project.id, { path: moved })
    expect(outcome.ok && outcome.project.path).toBe(moved)
  })

  it('refuses a folder another project already is', async () => {
    const first = await addProject({ path: folder('one'), name: 'One' })
    const second = await addProject({ path: folder('two') })
    if (!first.ok || !second.ok) throw new Error('the projects were not added')
    const outcome = await updateProject(second.project.id, { path: first.project.path })
    expect(outcome).toEqual({ ok: false, error: `${first.project.path} is already the project One` })
  })

  it('answers when no project has that id', async () => {
    expect(await updateProject('no-such-1', { name: 'x' })).toEqual({
      ok: false,
      error: 'no project with the id no-such-1',
    })
  })
})

describe('removeProject', () => {
  it('drops one and leaves the rest', async () => {
    const first = await addProject({ path: folder('one') })
    const second = await addProject({ path: folder('two') })
    if (!first.ok || !second.ok) throw new Error('the projects were not added')
    expect(await removeProject(first.project.id)).toBe(true)
    expect(readProjects().map((project) => project.id)).toEqual([second.project.id])
  })

  it('answers that there was nothing to drop', async () => {
    expect(await removeProject('no-such-1')).toBe(false)
  })
})

describe('placeProject', () => {
  it('answers where the folder is', async () => {
    const where = folder('milo')
    const added = await addProject({ path: where, name: 'Milo' })
    if (!added.ok) throw new Error('the project was not added')
    const placement = placeProject(added.project.id)
    expect(placement.ok && placement.project.path).toBe(where)
    expect(findProject(added.project.id)?.name).toBe('Milo')
  })

  it('says the folder is gone rather than handing out a path that is not one', async () => {
    const where = folder('milo')
    const added = await addProject({ path: where, name: 'Milo' })
    if (!added.ok) throw new Error('the project was not added')
    rmSync(where, { recursive: true })
    const placement = placeProject(added.project.id)
    expect(placement.ok).toBe(false)
    if (placement.ok) throw new Error('a folder that is gone cannot be a placement')
    expect(placement.error).toBe(`the folder of Milo is gone (${where})`)
    // The record rides along with the refusal, so a bar can say *which* project it is
    // that cannot be worked in rather than only that one cannot.
    expect(placement.project?.name).toBe('Milo')
  })

  it('says when the project is not in the list', () => {
    expect(placeProject('no-such-1')).toEqual({
      ok: false,
      id: 'no-such-1',
      error: 'the project no-such-1 is not in the list any more',
    })
  })
})

describe('byRecentUse', () => {
  const list = () => [
    { id: 'calm-otter-1', name: 'A', path: '/tmp/a', createdAt: 1 },
    { id: 'calm-otter-2', name: 'B', path: '/tmp/b', createdAt: 2 },
  ]

  it('puts the project whose session moved last at the top', () => {
    const ordered = byRecentUse(list(), [
      { project: 'calm-otter-1', updatedAt: 10 },
      { project: 'calm-otter-2', updatedAt: 20 },
    ])
    expect(ordered.map((project) => project.id)).toEqual(['calm-otter-2', 'calm-otter-1'])
  })

  it('reads a project by its newest session, not by one that came later in the list', () => {
    const ordered = byRecentUse(list(), [
      { project: 'calm-otter-1', updatedAt: 50 },
      { project: 'calm-otter-1', updatedAt: 10 },
      { project: 'calm-otter-2', updatedAt: 20 },
    ])
    expect(ordered.map((project) => project.id)).toEqual(['calm-otter-1', 'calm-otter-2'])
  })

  it('keeps a project no session ran in beneath the ones that did, in file order', () => {
    const projects = [...list(), { id: 'calm-otter-3', name: 'C', path: '/tmp/c', createdAt: 3 }]
    const ordered = byRecentUse(projects, [{ project: 'calm-otter-2', updatedAt: 20 }])
    expect(ordered.map((project) => project.id)).toEqual(['calm-otter-2', 'calm-otter-1', 'calm-otter-3'])
  })

  it('leaves a session with no project out of the order', () => {
    const ordered = byRecentUse(list(), [{ updatedAt: 99 }])
    expect(ordered.map((project) => project.id)).toEqual(['calm-otter-1', 'calm-otter-2'])
  })
})

describe('readProjects', () => {
  it('answers nothing for a file it cannot parse, without taking anything down', () => {
    writeList('{ not json')
    expect(readProjects()).toEqual([])
  })

  it('drops an entry that is not a project', () => {
    writeList([{ id: 'a-1', name: 'x' }, { id: 'kept-1', name: 'Kept', path: '/tmp/kept', createdAt: 1 }])
    expect(readProjects().map((project) => project.id)).toEqual(['kept-1'])
  })
})

describe('placedProject', () => {
  it('hands over the project itself when the folder is there', async () => {
    const where = folder('milo')
    const added = await addProject({ path: where, name: 'Milo' })
    if (!added.ok) throw new Error('the project was not added')
    expect(placedProject(placeProject(added.project.id))?.path).toBe(where)
  })

  it('keeps the name and says why when the folder has gone', async () => {
    const where = folder('milo')
    const added = await addProject({ path: where, name: 'Milo' })
    if (!added.ok) throw new Error('the project was not added')
    rmSync(where, { recursive: true })
    const read = placedProject(placeProject(added.project.id))
    expect(read?.name).toBe('Milo')
    expect(read?.error).toBe(`the folder of Milo is gone (${where})`)
  })

  it('answers nothing when the record is gone altogether', () => {
    expect(placedProject(placeProject('no-such-1'))).toBeUndefined()
  })
})
