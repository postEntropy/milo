import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// Point the install somewhere throwaway *before* the path module is loaded.
const home = mkdtempSync(path.join(tmpdir(), 'milo-projects-cli-'))
process.env.MILO_HOME = home

const { runProjects } = await import('../src/bin/projects.js')
const { readProjects } = await import('../src/core/projects.js')
const { projectIconNames } = await import('../src/core/project-icons.js')
const { FileSessionStore } = await import('../src/core/sessions/index.js')
const { sessionsDir } = await import('../src/core/config/paths.js')

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
    rmSync(sessionsDir(), { recursive: true, force: true })
  })

  afterEach(() => {
    rmSync(path.join(home, 'projects.json'), { force: true })
    rmSync(sessionsDir(), { recursive: true, force: true })
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

  it('lists the project worked in most recently first', async () => {
    await run('add', folder('older'), '--name', 'Older')
    await run('add', folder('newer'), '--name', 'Newer')
    const [older, newer] = readProjects()
    const store = new FileSessionStore({ dir: sessionsDir() })
    for (const [project, updatedAt] of [[older!.id, 10], [newer!.id, 20]] as const) {
      const record = await store.create({ gateway: 'cli', chatId: project }, project)
      record.updatedAt = updatedAt
      record.messages.push({ role: 'user', content: [{ type: 'text', text: 'hi' }] })
      await store.save(record, record.version)
    }

    const { lines } = await run('list')
    expect(lines[0]).toContain('Newer')
    expect(lines[2]).toContain('Older')
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

  it('chooses the mark a project wears, and lists the ones there are', async () => {
    const where = folder('milo')
    await run('add', where, '--name', 'Milo', '--icon', 'code')
    expect(readProjects()[0]!.icon).toBe('code')

    const listed = await run('icon')
    expect(listed.code).toBe(1)
    expect(listed.errors[1]).toBe(`Icons: ${projectIconNames()}`)

    const changed = await run('icon', 'Milo', 'terminal')
    expect(changed.code).toBe(0)
    expect(changed.lines[0]).toContain('now wears terminal')
    expect(readProjects()[0]!.icon).toBe('terminal')
  })

  it('refuses a mark outside the catalog, naming the ones there are', async () => {
    await run('add', folder('milo'), '--name', 'Milo')
    const { errors, code } = await run('icon', 'Milo', 'unicorn')
    expect(code).toBe(1)
    expect(errors[0]).toContain('no icon called "unicorn"')
    expect(errors[0]).toContain('use one of: folder, code')
    expect(readProjects()[0]!.icon).toBeUndefined()
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

  it('names the folder that carries rules of its own, and is silent when it does not', async () => {
    const withRules = folder('milo')
    writeFileSync(path.join(withRules, 'AGENTS.md'), 'Run the suite before you call it done.\n')
    await run('add', withRules, '--name', 'Milo')
    await run('add', folder('plain'), '--name', 'Plain')

    const { lines } = await run('list')
    // One line, and only where there is something to say: a folder with no rules of its
    // own is the ordinary case, not a warning printed on every entry.
    expect(lines.filter((line) => line.includes('rules:'))).toEqual(['     rules: AGENTS.md'])
  })

  it('says a rules file it cannot read, rather than staying quiet', async () => {
    const where = folder('milo')
    writeFileSync(path.join(where, 'AGENTS.md'), 'x'.repeat(17 * 1024))
    await run('add', where, '--name', 'Milo')

    const { lines } = await run('list')
    const rules = lines.find((line) => line.includes('rules:')) ?? ''
    expect(rules).toContain('rules: AGENTS.md — ')
    expect(rules).toContain('over the')
  })

  it('answers an unknown subcommand with the valid ones', async () => {
    const { errors, code } = await run('frobnicate')
    expect(code).toBe(1)
    expect(errors[0]).toBe('Unknown: milo projects frobnicate')
    expect(errors[1]).toContain('Usage:')
  })
})
