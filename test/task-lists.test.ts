import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const previousHome = process.env.MILO_HOME
const home = mkdtempSync(path.join(tmpdir(), 'milo-task-lists-'))
process.env.MILO_HOME = home
const { manageTaskLists, readTaskLists } = await import('../src/core/task-lists.js')

afterAll(() => {
  if (previousHome === undefined) delete process.env.MILO_HOME
  else process.env.MILO_HOME = previousHome
})

describe('persistent task lists', () => {
  it('creates multiple named lists and finds names without case sensitivity', async () => {
    expect(await manageTaskLists({ action: 'create', name: 'Milo' })).toBe('Created list "Milo".')
    expect(await manageTaskLists({ action: 'create', name: 'Home' })).toBe('Created list "Home".')
    expect(await manageTaskLists({ action: 'create', name: 'milo' })).toContain('already exists')
    expect(await manageTaskLists({ action: 'list' })).toBe('Milo (0 open)\nHome (0 open)')
  })

  it('adds, shows, completes and removes tasks in the selected list', async () => {
    const added = await manageTaskLists({ action: 'add', name: 'mIlO', item: 'Ship task lists' })
    const id = added.match(/\[([a-f0-9-]{8})\]/)?.[1]
    expect(id).toBeTruthy()
    expect(await manageTaskLists({ action: 'show', name: 'Milo' })).toContain('☐')
    expect(await manageTaskLists({ action: 'complete', name: 'Milo', itemId: id! })).toContain('Completed')
    expect(await manageTaskLists({ action: 'list' })).toContain('Milo (0 open)')
    expect(await manageTaskLists({ action: 'remove', name: 'Milo', itemId: id! })).toContain('Removed')
    expect(readTaskLists()[0]?.items).toEqual([])
  })

  it('names available lists when a requested list does not exist', async () => {
    expect(await manageTaskLists({ action: 'show', name: 'Work' })).toContain('Milo, Home')
  })

  it('renames lists and persists them for a later read', async () => {
    expect(await manageTaskLists({ action: 'rename', name: 'Home', newName: 'Household' })).toContain('Renamed')
    expect(readTaskLists().map((list) => list.name)).toEqual(['Milo', 'Household'])
  })
})
