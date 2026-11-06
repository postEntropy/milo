import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ExternalAgents } from '../src/core/agent-runner.js'
import { findProject, placeProject } from '../src/core/projects.js'
import { readOwnInstructions, readProjectInstructions } from '../src/core/agent/instructions.js'

vi.mock('../src/core/projects.js', () => {
  const placeProject = vi.fn()
  return { findProject: vi.fn(), placeProject, withProjectPlacement: async (id: string, work: (placement: unknown, assertLock: () => void) => Promise<unknown>) => work(placeProject(id), () => {}) }
})
vi.mock('../src/util/fs.js', () => ({ ensurePrivateDir: vi.fn(), writePrivateFile: vi.fn(async () => {}) }))
vi.mock('../src/core/agent/instructions.js', () => ({
  readOwnInstructions: vi.fn(),
  readProjectInstructions: vi.fn(),
}))

const labels = {
  'milo-agent': 'command-code', 'milo-project': 'calm-otter-7',
  'milo-project-created': '1', 'milo-project-incarnation': 'project-incarnation',
}
const item = { address: 't1', state: 'live', created_ms: 12, cwd: '/project', labels, exit_code: null, reason: null }

beforeEach(() => {
  vi.mocked(findProject).mockReturnValue({ id: 'calm-otter-7', name: 'Project', path: '/project', createdAt: 1, incarnation: 'project-incarnation' })
  vi.mocked(placeProject).mockReturnValue({
    ok: true,
    project: { id: 'calm-otter-7', name: 'Project', path: '/project', createdAt: 1, incarnation: 'project-incarnation' },
  })
  vi.mocked(readOwnInstructions).mockReturnValue({ kind: 'present', file: 'AGENTS.md', text: 'Install rules' })
  vi.mocked(readProjectInstructions).mockReturnValue({ kind: 'present', file: 'AGENTS.md', text: 'Project rules' })
})

describe('external agents', () => {
  it('requires explicit approval before starting an agent with write and shell access', async () => {
    const call = vi.fn(async (): Promise<unknown> => item)
    const agents = new ExternalAgents(call)
    await expect(agents.start('calm-otter-7', 'Do the work', false)).rejects.toThrow('Confirm')
    expect(call).not.toHaveBeenCalled()
  })

  it('starts Command Code in the project and carries the current rules', async () => {
    const call = vi.fn(async (method: string, params: Record<string, unknown>): Promise<unknown> =>
      method === 'terminal.list' ? { terminals: [] } : { ...item, labels: params.labels })
    const agents = new ExternalAgents(call)
    expect(await agents.start('calm-otter-7', 'Fix the bug; do not run git push', true)).toEqual({
      address: 't1', state: 'live', createdAt: 12, cwd: '/project', runId: expect.any(String), exitCode: null, reason: null,
    })
    expect(call).toHaveBeenCalledWith('terminal.run', {
      argv: ['cmd', '--yolo', '--skip-onboarding', 'Instructions from AGENTS.md:\nInstall rules\n\nInstructions from AGENTS.md:\nProject rules\n\nTask:\nFix the bug; do not run git push'],
      cwd: '/project', labels: { ...labels, 'milo-run': expect.any(String) }, no_parent: true, outlive_parent: true,
    })
  })

  it('refuses to start when project rules could not be read', async () => {
    vi.mocked(readProjectInstructions).mockReturnValue({ kind: 'unreadable', file: 'AGENTS.md', error: 'denied' })
    const call = vi.fn(async (method: string): Promise<unknown> => method === 'terminal.list' ? { terminals: [] } : item)
    await expect(new ExternalAgents(call).start('calm-otter-7', 'Fix it', true)).rejects.toThrow('denied')
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('lists only terminals marked for the project', async () => {
    const call = vi.fn(async (): Promise<unknown> => ({ terminals: [item, { ...item, address: 't2', labels: { ...labels, 'milo-project': 'other' } }] }))
    const agents = new ExternalAgents(call)
    expect((await agents.list('calm-otter-7')).runs).toHaveLength(1)
    expect(call).toHaveBeenCalledWith('terminal.list', { all: true, labels: { 'milo-agent': 'command-code', 'milo-project': 'calm-otter-7' } })
  })

  it('refuses to read, send to or stop another project’s terminal', async () => {
    const call = vi.fn(async (_method: string): Promise<unknown> => ({ ...item, labels: { ...labels, 'milo-project': 'other' } }))
    const agents = new ExternalAgents(call)
    await expect(agents.read('calm-otter-7', 't1')).rejects.toThrow('does not belong')
    await expect(agents.send('calm-otter-7', 't1', 'hello')).rejects.toThrow('does not belong')
    await expect(agents.stop('calm-otter-7', 't1')).rejects.toThrow('does not belong')
    expect(call.mock.calls.every(([method]) => method === 'terminal.get')).toBe(true)
  })

  it('does not attach an old run to a new project that reused its id', async () => {
    vi.mocked(findProject).mockReturnValue({ id: 'calm-otter-7', name: 'New', path: '/new', createdAt: 1, incarnation: 'new-incarnation' })
    const call = vi.fn(async (): Promise<unknown> => item)
    await expect(new ExternalAgents(call).read('calm-otter-7', 't1')).rejects.toThrow('does not belong')
  })

  it('reports an uncertain launch without claiming it did not start', async () => {
    const call = vi.fn(async (method: string): Promise<unknown> => {
      if (method === 'terminal.list') return { terminals: [] }
      throw new Error('connection lost')
    })
    await expect(new ExternalAgents(call).start('calm-otter-7', 'Fix it', true)).rejects.toThrow('may have started')
  })

  it('reads the screen and keeps Herdr’s completeness flag', async () => {
    const call = vi.fn(async (method: string): Promise<unknown> => method === 'terminal.get'
      ? item : { text: 'agent output', complete: false })
    const screen = await new ExternalAgents(call).read('calm-otter-7', 't1')
    expect(screen.text).toBe('agent output')
    expect(screen.complete).toBe(false)
  })

  it('sends a message and stops a live terminal after checking ownership', async () => {
    const call = vi.fn(async (method: string): Promise<unknown> => method === 'terminal.get' ? item : {})
    const agents = new ExternalAgents(call)
    await agents.send('calm-otter-7', 't1', '  Continue  ')
    await agents.stop('calm-otter-7', 't1')
    expect(call).toHaveBeenCalledWith('terminal.send', { terminal: 't1', text: 'Continue' })
    expect(call).toHaveBeenCalledWith('terminal.kill', { terminal: 't1' })
  })

  it('rejects input to a finished terminal', async () => {
    const call = vi.fn(async (): Promise<unknown> => ({ ...item, state: 'finished' }))
    const agents = new ExternalAgents(call)
    await expect(agents.send('calm-otter-7', 't1', 'hello')).rejects.toThrow('stopped')
    await expect(agents.stop('calm-otter-7', 't1')).rejects.toThrow('stopped')
  })

  it('rejects malformed responses and terminal addresses', async () => {
    const call = vi.fn(async (): Promise<unknown> => ({ terminals: 'invalid' }))
    const agents = new ExternalAgents(call)
    await expect(agents.list('calm-otter-7')).rejects.toThrow('invalid terminal list')
    await expect(agents.read('calm-otter-7', '../other')).rejects.toThrow('Invalid agent terminal')
    expect(call).toHaveBeenCalledTimes(1)
  })
})
