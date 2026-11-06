import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const agents = vi.hoisted(() => ({ list: vi.fn(), hasMarker: vi.fn(), removeMarker: vi.fn(), assertSettled: vi.fn(), write: vi.fn(), order: [] as string[] }))
vi.mock('../src/core/agent-runner.js', () => ({
  ExternalAgents: class { listLocked = agents.list },
  assertProjectAgentsSettled: agents.assertSettled,
  hasAgentMarker: agents.hasMarker,
  removeAgentMarker: agents.removeMarker,
}))
vi.mock('../src/util/fs.js', () => ({ writePrivateFile: agents.write }))

const home = mkdtempSync(path.join(os.tmpdir(), 'milo-project-agents-'))
process.env.MILO_HOME = home
const { addProject, removeProject, updateProject, withProjectPlacement, findProject } = await import('../src/core/projects.js')

beforeEach(() => {
  mkdirSync(home, { recursive: true })
  agents.list.mockReset()
  agents.hasMarker.mockReset()
  agents.removeMarker.mockReset()
  agents.assertSettled.mockReset()
  agents.write.mockReset()
  agents.order.length = 0
  agents.hasMarker.mockReturnValue(true)
  agents.removeMarker.mockImplementation(async () => { agents.order.push('marker') })
  agents.write.mockImplementation(async (file: string, content: string) => {
    if (path.basename(file) === 'projects.json') agents.order.push('projects')
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, content, { mode: 0o600 })
  })
  agents.assertSettled.mockImplementation(async (entry: { id: string }) => {
    if (!agents.hasMarker(entry)) return
    const result = await agents.list(entry)
    if (result.some((run: { state: string }) => run.state === 'live')) throw new Error('Stop this project’s external agents before moving or removing the project.')
  })
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

async function project() {
  const folder = path.join(home, 'project')
  mkdirSync(folder, { recursive: true })
  const result = await addProject({ path: folder })
  if (!result.ok) throw new Error(result.error)
  return result.project
}

describe('projects with external agents', () => {
  it('keeps a stable identity for a project without a stored creation date', () => {
    writeFileSync(path.join(home, 'projects.json'), JSON.stringify([{ id: 'old-fox-1', name: 'Old', path: home }]))
    expect(findProject('old-fox-1')?.createdAt).toBe(0)
    expect(findProject('old-fox-1')?.createdAt).toBe(0)
  })

  it('refuses to remove or move a project while an external agent is open', async () => {
    const entry = await project()
    const next = path.join(home, 'other')
    mkdirSync(next)
    agents.list.mockResolvedValue([{ state: 'live' }])
    await expect(removeProject(entry.id)).rejects.toThrow('Stop this project')
    await expect(updateProject(entry.id, { path: next })).rejects.toThrow('Stop this project')
    expect(findProject(entry.id)?.path).toBe(entry.path)
    expect(agents.removeMarker).not.toHaveBeenCalled()
  })

  it('removes a project once every external agent has stopped', async () => {
    const entry = await project()
    agents.list.mockResolvedValue([{ state: 'finished' }])
    expect(await removeProject(entry.id)).toEqual({ removed: true })
    expect(agents.removeMarker).toHaveBeenCalledWith(entry)
    expect(findProject(entry.id)).toBeUndefined()
  })

  it('commits the project list before deleting its recovery record', async () => {
    const entry = await project()
    agents.list.mockResolvedValue([])
    agents.order.length = 0
    await removeProject(entry.id)
    expect(agents.order).toEqual(['projects', 'marker'])
  })

  it('leaves the marker in place when saving the removal fails', async () => {
    const entry = await project()
    agents.list.mockResolvedValue([])
    agents.write.mockRejectedValueOnce(new Error('disk full'))
    await expect(removeProject(entry.id)).rejects.toThrow('disk full')
    expect(findProject(entry.id)).toBeDefined()
    expect(agents.removeMarker).not.toHaveBeenCalled()
  })

  it('reports marker cleanup failure after the project was committed as removed', async () => {
    const entry = await project()
    agents.list.mockResolvedValue([])
    agents.removeMarker.mockRejectedValueOnce(new Error('permission denied'))
    const result = await removeProject(entry.id)
    expect(result).toMatchObject({ removed: true, warning: expect.stringContaining('cleaned up') })
    expect(findProject(entry.id)).toBeUndefined()
  })

  it('keeps the project when Herdr cannot confirm that its agents stopped', async () => {
    const entry = await project()
    agents.list.mockRejectedValue(new Error('Herdr unavailable'))
    await expect(removeProject(entry.id)).rejects.toThrow('Herdr unavailable')
    expect(findProject(entry.id)).toBeDefined()
  })

  it('does not contact Herdr for a project that never started an external agent', async () => {
    const entry = await project()
    agents.hasMarker.mockReturnValue(false)
    expect(await removeProject(entry.id)).toEqual({ removed: true })
    expect(agents.list).not.toHaveBeenCalled()
  })

  it('does not remove a project while an agent launch holds its project lock', async () => {
    const entry = await project()
    agents.list.mockResolvedValue([{ state: 'live' }])
    let release!: () => void
    let started!: () => void
    const entered = new Promise<void>((resolve) => { started = resolve })
    const hold = new Promise<void>((resolve) => { release = resolve })
    const launch = withProjectPlacement(entry.id, async () => { started(); await hold })
    await entered
    const removal = removeProject(entry.id)
    await new Promise((resolve) => setImmediate(resolve))
    expect(agents.list).not.toHaveBeenCalled()
    release()
    await launch
    await expect(removal).rejects.toThrow('Stop this project')
    expect(findProject(entry.id)).toBeDefined()
  })
})
