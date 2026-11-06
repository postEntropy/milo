import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const home = mkdtempSync(path.join(os.tmpdir(), 'milo-agent-state-'))
process.env.MILO_HOME = home
const { addProject } = await import('../src/core/projects.js')
const { ExternalAgents } = await import('../src/core/agent-runner.js')

let projectPath: string
let project: { id: string; path: string; createdAt: number; incarnation?: string }

beforeEach(async () => {
  mkdirSync(home, { recursive: true })
  projectPath = path.join(home, 'project')
  mkdirSync(projectPath, { recursive: true })
  const result = await addProject({ path: projectPath })
  if (!result.ok) throw new Error(result.error)
  project = result.project
})

afterEach(() => rmSync(home, { recursive: true, force: true }))

function markerPaths(entry = project) {
  const key = createHash('sha256').update(JSON.stringify([entry.id, entry.incarnation])).digest('hex')
  const legacyKey = createHash('sha256').update(JSON.stringify([entry.id, entry.createdAt])).digest('hex')
  const dir = path.join(home, 'agent-projects')
  return { dir, file: path.join(dir, `${key}.json`), legacy: path.join(dir, legacyKey) }
}

function terminal(labels: Record<string, string>, state = 'live') {
  return { address: 't1', state, created_ms: 20, cwd: projectPath, labels, exit_code: null, reason: null }
}

describe('external-agent recovery records', () => {
  it('writes a private pending intent before dispatching a launch', async () => {
    let intent: Record<string, unknown> | undefined
    const agents = new ExternalAgents(async (method, params) => {
      if (method === 'terminal.list') return { terminals: [] }
      const { dir, file } = markerPaths()
      expect(statSync(dir).mode & 0o7777).toBe(0o700)
      expect(statSync(file).mode & 0o7777).toBe(0o600)
      intent = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      const labels = params.labels as Record<string, string>
      expect(intent.pending).toEqual([labels['milo-run']])
      throw new Error('connection lost after dispatch')
    })

    await expect(agents.start(project.id, 'Create a file', true)).rejects.toThrow('may have started')
    if (!intent) throw new Error('The pending intent was not written before dispatch.')
    expect(intent.legacyScan).toBe('complete')
    expect((intent.pending as string[]).length).toBe(1)
    expect((await agents.recovery(project.id)).pending).toEqual(intent.pending)
  })

  it('persists an incarnation when a legacy project first uses external agents', async () => {
    const projectsFile = path.join(home, 'projects.json')
    const saved = JSON.parse(readFileSync(projectsFile, 'utf8')) as Array<Record<string, unknown>>
    delete saved[0]!.incarnation
    writeFileSync(projectsFile, JSON.stringify(saved))
    const agents = new ExternalAgents(async (method, params) => {
      if (method === 'terminal.list') return { terminals: [] }
      if (method === 'terminal.run') return terminal(params.labels as Record<string, string>)
      throw new Error(`Unexpected ${method}`)
    })
    await agents.start(project.id, 'Create a file', true)
    const migrated = JSON.parse(readFileSync(projectsFile, 'utf8')) as Array<{ incarnation?: string }>
    expect(migrated[0]?.incarnation).toEqual(expect.any(String))
    expect(migrated[0]?.incarnation).not.toBe('')
  })

  it('blocks another launch while an earlier start is unresolved', async () => {
    const agents = new ExternalAgents(async (method) => {
      if (method === 'terminal.list') return { terminals: [] }
      throw new Error('response lost')
    })
    await expect(agents.start(project.id, 'First task', true)).rejects.toThrow('may have started')
    await expect(agents.start(project.id, 'Second task', true)).rejects.toThrow('pending external agent runs')
    const restored = new ExternalAgents(async () => ({ terminals: [] }))
    expect((await restored.recovery(project.id)).pending).toHaveLength(1)
  })

  it('keeps an empty prior marker pending until Herdr completes the legacy scan', async () => {
    const { dir, legacy } = markerPaths()
    mkdirSync(dir, { recursive: true })
    writeFileSync(legacy, '')
    const old = terminal({ 'milo-agent': 'command-code', 'milo-project': project.id })
    const agents = new ExternalAgents(async (method) => {
      if (method === 'terminal.list') return { terminals: [old] }
      throw new Error(`Unexpected ${method}`)
    })

    const result = await agents.list(project.id)
    expect(result.legacyScan).toBe('complete')
    expect(result.legacy).toEqual([{ address: 't1', cwd: projectPath, createdAt: 20, state: 'live', released: false }])
    expect(JSON.parse(readFileSync(markerPaths().file, 'utf8')).legacy).toHaveLength(1)
  })

  it('keeps a failed legacy scan recoverable and supports only an explicit release', async () => {
    const agents = new ExternalAgents(async () => { throw new Error('Herdr unavailable') })
    await expect(agents.list(project.id)).rejects.toThrow('Herdr unavailable')
    expect((await agents.recovery(project.id)).legacyScan).toBe('pending')
    await expect(agents.releaseLegacyScan(project.id, false)).rejects.toThrow('Confirm')
    await agents.releaseLegacyScan(project.id, true)
    expect((await agents.recovery(project.id)).legacyScan).toBe('released')
  })

  it('resolves a pending intent only when its uniquely labelled terminal appears', async () => {
    let accepted: Record<string, string> | undefined
    let visible = false
    const agents = new ExternalAgents(async (method, params) => {
      if (method === 'terminal.list') return { terminals: visible && accepted ? [terminal(accepted)] : [] }
      if (method === 'terminal.run') {
        accepted = params.labels as Record<string, string>
        throw new Error('response lost')
      }
      throw new Error(`Unexpected ${method}`)
    })
    await expect(agents.start(project.id, 'Create a file', true)).rejects.toThrow('may have started')
    const runId = (await agents.recovery(project.id)).pending[0]!
    expect(await agents.list(project.id)).toMatchObject({ runs: [], pending: [runId] })
    visible = true
    expect(await agents.list(project.id)).toMatchObject({ runs: [{ runId }], pending: [] })
  })

  it('keeps a launch pending when multiple terminals claim its UUID', async () => {
    let labels: Record<string, string> | undefined
    const agents = new ExternalAgents(async (method, params) => {
      if (method === 'terminal.list') return { terminals: labels ? [terminal(labels), { ...terminal(labels), address: 't2' }] : [] }
      if (method === 'terminal.run') {
        labels = params.labels as Record<string, string>
        throw new Error('response lost')
      }
      throw new Error(`Unexpected ${method}`)
    })
    await expect(agents.start(project.id, 'Create a file', true)).rejects.toThrow('may have started')
    const runId = (await agents.recovery(project.id)).pending[0]!
    expect((await agents.list(project.id)).pending).toEqual([runId])
  })

  it('stops an old terminal only after the user explicitly confirms it', async () => {
    const { dir, legacy } = markerPaths()
    mkdirSync(dir, { recursive: true })
    writeFileSync(legacy, '')
    const old = terminal({ 'milo-agent': 'command-code', 'milo-project': project.id })
    const calls: string[] = []
    let oldState = 'live'
    const agents = new ExternalAgents(async (method) => {
      calls.push(method)
      if (method === 'terminal.list') return { terminals: [{ ...old, state: oldState }] }
      if (method === 'terminal.get') return { ...old, state: oldState }
      if (method === 'terminal.read') return { text: 'old terminal screen', complete: true }
      if (method === 'terminal.kill') { oldState = 'finished'; return {} }
      throw new Error(`Unexpected ${method}`)
    })
    await agents.list(project.id)
    expect((await agents.readLegacy(project.id, old.address)).text).toBe('old terminal screen')
    await expect(agents.stopLegacy(project.id, old.address, false)).rejects.toThrow('Confirm')
    expect(calls).toEqual(['terminal.list', 'terminal.get', 'terminal.read'])
    await agents.stopLegacy(project.id, old.address, true)
    expect(calls).toEqual(['terminal.list', 'terminal.get', 'terminal.read', 'terminal.get', 'terminal.kill', 'terminal.list'])
    expect((await agents.recovery(project.id)).legacy[0]?.state).toBe('finished')
  })

  it('does not resolve a launch while Herdr reports spawn_pending', async () => {
    let labels: Record<string, string> | undefined
    const agents = new ExternalAgents(async (method, params) => {
      if (method === 'terminal.list') return { terminals: [] }
      if (method === 'terminal.run') {
        labels = params.labels as Record<string, string>
        return { ...terminal(labels), reason: 'spawn_pending' }
      }
      throw new Error(`Unexpected ${method}`)
    })
    const started = await agents.start(project.id, 'Create a file', true)
    expect(started.reason).toBe('spawn_pending')
    expect((await agents.recovery(project.id)).pending).toEqual([labels?.['milo-run']])
  })
})
