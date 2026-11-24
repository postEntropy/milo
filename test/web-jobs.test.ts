import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatRequest, Provider, StreamEvent } from '../src/core/providers/types.js'

// Point the app at a throwaway home *before* the modules that read it load.
const home = mkdtempSync(path.join(os.tmpdir(), 'milo-web-jobs-'))
process.env.MILO_HOME = home

const { WebHub } = await import('../src/gateways/web/hub.js')
const { AgentRuntime } = await import('../src/core/runtime.js')
const { JobManager, attachJobNotifier } = await import('../src/core/jobs/index.js')
const { createToolRegistry } = await import('../src/core/tools/index.js')
const { DefaultPermissionPolicy } = await import('../src/core/tools/permission.js')

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
  status?: string
  says?: string
  event?: { type: string; delta?: string; text?: string; ids?: string[] }
  reply?: string
}

async function waitFor(condition: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('condition timed out')
}

function scriptedRuntime(
  jobs: InstanceType<typeof JobManager>,
  handler: (call: number, req: ChatRequest) => AsyncGenerator<StreamEvent> | StreamEvent[],
): InstanceType<typeof AgentRuntime> {
  let calls = 0
  const provider: Provider = {
    id: 'scripted',
    async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
      calls += 1
      const out = handler(calls, req)
      if (Array.isArray(out)) {
        for (const event of out) yield event
      } else {
        for await (const event of out) yield event
      }
    },
  }
  return new AgentRuntime({
    provider,
    model: 'test-model',
    system: 'BASE',
    registry: createToolRegistry({ jobs }),
    memory: {
      remember: async () => undefined,
      recall: async () => [],
      list: async () => [],
      forget: async () => false,
    } as never,
    jobs,
    permissionPolicy: new DefaultPermissionPolicy({ mode: 'yolo' }),
    cwd: home,
  })
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

describe('web turns waiting on background jobs', () => {
  it('keeps the live web turn open across early job completion and avoids duplicate notices', async () => {
    const jobs = new JobManager()
    const runtime = scriptedRuntime(jobs, async function* (call) {
      if (call === 1) {
        yield {
          type: 'tool-call',
          id: 'c1',
          name: 'shell_command',
          args: { command: 'echo WEB_JOB_OK', background: true },
        }
        yield { type: 'done', finishReason: 'tool_calls' }
        return
      }
      if (call === 2) {
        yield { type: 'text', delta: 'Downloading tools…' }
        for (let i = 0; i < 100 && jobs.list().every((j) => j.state === 'running'); i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        yield { type: 'done', finishReason: 'stop' }
        return
      }
      yield { type: 'text', delta: 'All done on web!' }
      yield { type: 'done', finishReason: 'stop' }
    })
    const hub = new WebHub(runtime, home)
    const notices: string[] = []
    const detach = attachJobNotifier(runtime, (_job, msg) => {
      notices.push(msg.text)
    })

    const frames: Frame[] = []
    const page = client(frames)
    await hub.connect(page, CHAT)
    hub.handle(page, { type: 'send', text: 'prepare image' }, CHAT)

    await waitFor(() => frames.some((frame) => frame.type === 'turn-end'))
    await new Promise((resolve) => setTimeout(resolve, 50))
    detach()
    hub.close()

    const turnEnds = frames.filter((frame) => frame.type === 'turn-end')
    expect(turnEnds).toHaveLength(1)
    expect(turnEnds[0]?.status).toBe('done')
    const text = frames
      .filter((frame) => frame.type === 'event' && frame.event?.type === 'text-delta')
      .map((frame) => frame.event?.delta ?? '')
      .join('')
    expect(text).toContain('Downloading tools…')
    expect(text).toContain('All done on web!')
    expect(notices).toEqual([])
    await jobs.close()
  })

  it('supports steering and stop cancellation while waiting on a background job on web', async () => {
    const jobs = new JobManager()
    const runtime = scriptedRuntime(jobs, (call) => {
      if (call === 1) {
        return [
          {
            type: 'tool-call',
            id: 'c1',
            name: 'shell_command',
            args: { command: 'sleep 10', background: true },
          },
          { type: 'done', finishReason: 'tool_calls' },
        ]
      }
      return [
        { type: 'text', delta: 'Waiting…' },
        { type: 'done', finishReason: 'stop' },
      ]
    })
    const hub = new WebHub(runtime, home)
    const frames: Frame[] = []
    const page = client(frames)
    await hub.connect(page, CHAT)

    hub.handle(page, { type: 'send', text: 'start long work' }, CHAT)
    await waitFor(() => frames.some((frame) => frame.type === 'event' && frame.event?.type === 'job-waiting'))

    // User sends steering guidance while waiting.
    hub.handle(page, { type: 'send', text: 'adjust flags', intent: 'steer' }, CHAT)
    await waitFor(() => frames.some((frame) => frame.type === 'event' && frame.event?.type === 'job-waited'))

    // Wait until the turn re-enters job-waiting, then cancel via Stop control.
    await waitFor(() => frames.filter((frame) => frame.type === 'event' && frame.event?.type === 'job-waiting').length >= 2)
    hub.handle(page, { type: 'control', action: 'stop' }, CHAT)
    await waitFor(() => frames.some((frame) => frame.type === 'turn-end'))
    hub.close()

    expect(frames.find((frame) => frame.type === 'turn-end')?.status).toBe('stopped')
    await jobs.close()
  })
})
