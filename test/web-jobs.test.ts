import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// Point the app at a throwaway home *before* the modules that read it load.
const home = mkdtempSync(path.join(os.tmpdir(), 'milo-web-jobs-'))
process.env.MILO_HOME = home

const { WebHub } = await import('../src/gateways/web/hub.js')
const { AgentRuntime } = await import('../src/core/runtime.js')
const { JobManager } = await import('../src/core/jobs/index.js')

const CHAT = '11111111-2222-3333-4444-555555555555'

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
})

/** A runtime with a job manager behind it and nothing to answer with. */
function build(jobs: InstanceType<typeof JobManager>): InstanceType<typeof AgentRuntime> {
  return new AgentRuntime({
    provider: { id: 'test', stream: async function* () { yield { type: 'done', finishReason: 'stop' } } } as never,
    model: 'test-model',
    system: '',
    registry: { specs: () => [] } as never,
    memory: {
      remember: async () => undefined,
      recall: async () => [],
      list: async () => [],
      forget: async () => false,
    } as never,
    jobs,
    cwd: home,
  })
}

/** The frames a page would draw from, as much of each as these tests read. */
interface Frame {
  type: string
  sessionId?: string
  jobs?: Array<{ id: string }>
  message?: string
}

function client(frames: Frame[]): { send(frame: unknown): void } {
  return { send: (frame: unknown) => void frames.push(frame as Frame) }
}

describe('the jobs strip', () => {
  it('draws only the jobs of the session the conversation is bound to', async () => {
    const jobs = new JobManager()
    const hub = new WebHub(build(jobs))
    const frames: Frame[] = []
    await hub.connect(client(frames), CHAT)
    const sessionId = frames.find((frame) => frame.type === 'ready')?.sessionId
    expect(sessionId).toEqual(expect.any(String))

    // One job this session started, and one another session did. The change broadcast
    // is what draws the strip, so both going out is what puts the rule under test.
    const mine = jobs.start({
      command: 'sleep 30',
      cwd: home,
      origin: { gateway: 'web', chatId: CHAT },
      sessionId,
    })
    jobs.start({
      command: 'sleep 30',
      cwd: home,
      origin: { gateway: 'web', chatId: 'another-conversation' },
      sessionId: 'another-session',
    })
    expect(mine.ok).toBe(true)

    const strip = frames.filter((frame) => frame.type === 'jobs').at(-1)
    expect(strip?.jobs?.map((job) => job.id)).toEqual(mine.ok ? [mine.job.id] : [])
    await jobs.close()
  })

  it('refuses to stop a job another session started', async () => {
    const jobs = new JobManager()
    const hub = new WebHub(build(jobs))
    const elsewhere = jobs.start({
      command: 'sleep 30',
      cwd: home,
      origin: { gateway: 'web', chatId: 'another-conversation' },
      sessionId: 'another-session',
    })
    expect(elsewhere.ok).toBe(true)
    if (!elsewhere.ok) return

    const frames: Frame[] = []
    const page = client(frames)
    await hub.connect(page, CHAT)
    hub.handle(page, { type: 'job-kill', id: elsewhere.job.id }, CHAT)

    // The job is still running: this conversation did not start it.
    expect(jobs.get(elsewhere.job.id)?.state).toBe('running')
    expect(frames.some((frame) => frame.type === 'error')).toBe(true)

    // Its own session may stop it.
    expect(jobs.kill(elsewhere.job.id, 'another-session')).toBe(true)
    await jobs.close()
  })
})
