import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

let home: string
let previous: string | undefined
let addProject: typeof import('../src/core/projects.js').addProject
let removeProject: typeof import('../src/core/projects.js').removeProject
let updateProject: typeof import('../src/core/projects.js').updateProject
let FileSessionStore: typeof import('../src/core/sessions/file-store.js').FileSessionStore

beforeEach(async () => {
  previous = process.env.MILO_HOME
  home = mkdtempSync(path.join(os.tmpdir(), 'milo-command-code-project-'))
  process.env.MILO_HOME = home
  ;({ addProject, removeProject, updateProject } = await import('../src/core/projects.js'))
  ;({ FileSessionStore } = await import('../src/core/sessions/file-store.js'))
})

afterEach(() => {
  if (previous === undefined) delete process.env.MILO_HOME
  else process.env.MILO_HOME = previous
  rmSync(home, { recursive: true, force: true })
})

describe('projects linked to native Command Code Sessions', () => {
  it('blocks moving or removing a project until its Milo Session link is removed', async () => {
    const originalPath = path.join(home, 'project')
    const movedPath = path.join(home, 'moved-project')
    mkdirSync(originalPath)
    mkdirSync(movedPath)
    const result = await addProject({ path: originalPath, name: 'Project' })
    if (!result.ok) throw new Error(result.error)
    const project = result.project
    const store = new FileSessionStore({ dir: path.join(home, 'sessions') })
    const record = await store.create({ gateway: 'web', chatId: 'chat-1' }, project.id)
    record.backend = {
      kind: 'command-code',
      state: 'ready',
      requestId: 'web:chat-1',
      nativeTitle: `Milo Session ${record.id}`,
      nativeSessionId: '8dbd4e1e-aef7-4e3e-9c16-7299fb337e49',
      workingDirectory: originalPath,
      projectIncarnation: project.incarnation,
    }
    await store.save(record, record.version)

    await expect(updateProject(project.id, { path: movedPath })).rejects.toThrow('Command Code Session')
    await expect(removeProject(project.id)).rejects.toThrow('Command Code Session')
    expect((await import('../src/core/projects.js')).findProject(project.id)?.path).toBe(originalPath)

    await store.remove(record.id)
    await expect(updateProject(project.id, { path: movedPath })).resolves.toMatchObject({ ok: true, project: { path: movedPath } })
  })

  it('leaves the Command Code native transcript untouched when a project is unlinked', async () => {
    const projectPath = path.join(home, 'project')
    mkdirSync(projectPath)
    const result = await addProject({ path: projectPath, name: 'Project' })
    if (!result.ok) throw new Error(result.error)
    const project = result.project
    const store = new FileSessionStore({ dir: path.join(home, 'sessions') })
    const record = await store.create({ gateway: 'web', chatId: 'chat-2' }, project.id)
    record.backend = {
      kind: 'command-code',
      state: 'ready',
      requestId: 'web:chat-2',
      nativeTitle: `Milo Session ${record.id}`,
      nativeSessionId: 'b34d2ea3-6a20-4d93-b1fb-f177881a6417',
      workingDirectory: projectPath,
      projectIncarnation: project.incarnation,
    }
    await store.save(record, record.version)
    const nativeHistory = path.join(home, 'command-code', 'session.jsonl')
    mkdirSync(path.dirname(nativeHistory), { recursive: true })
    writeFileSync(nativeHistory, '{"native":"history"}\n')

    await store.remove(record.id)

    expect(readFileSync(nativeHistory, 'utf8')).toBe('{"native":"history"}\n')
  })
})
