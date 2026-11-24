import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { AgentEvent } from '../src/core/agent/events.js'
import type { ChatRequest, Message, Provider, StreamEvent } from '../src/core/providers/types.js'
import type { ChatSurface } from '../src/gateways/surface.js'

const home = mkdtempSync(path.join(tmpdir(), 'milo-turn-jobs-'))
process.env.MILO_HOME = home

const { runAgent } = await import('../src/core/agent/loop.js')
const { JobManager, attachJobNotifier } = await import('../src/core/jobs/index.js')
const { createJobTools } = await import('../src/core/tools/jobs.js')
const { shellTool } = await import('../src/core/tools/shell.js')
const { ToolRegistry } = await import('../src/core/tools/registry.js')
const { Session } = await import('../src/core/session.js')
const { MemorySessionStore } = await import('../src/core/sessions/memory-store.js')
const { SqliteMemory } = await import('../src/core/memory/sqlite.js')
const { DefaultPermissionPolicy } = await import('../src/core/tools/permission.js')
const { createToolRegistry } = await import('../src/core/tools/index.js')
const { jobsDir } = await import('../src/core/config/paths.js')
const { runTurn } = await import('../src/gateways/runner.js')

const origin = { gateway: 'cli', chatId: 'main' }

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

class ScriptedProvider implements Provider {
  readonly id = 'scripted'
  calls = 0
  readonly requests: ChatRequest[] = []

  constructor(
    private readonly handler: (call: number, req: ChatRequest) => AsyncGenerator<StreamEvent> | StreamEvent[],
  ) {}

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    this.calls += 1
    this.requests.push({ ...req, messages: structuredClone(req.messages) })
    const out = this.handler(this.calls, req)
    if (Array.isArray(out)) {
      for (const event of out) yield event
    } else {
      for await (const event of out) yield event
    }
  }
}

beforeEach(() => {
  rmSync(jobsDir(), { recursive: true, force: true })
})

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
})

async function makeSession(provider: Provider, jobs: InstanceType<typeof JobManager>) {
  const dir = mkdtempSync(path.join(home, 'sess-'))
  const store = new MemorySessionStore()
  const record = await store.create()
  const registry = createToolRegistry({ jobs })
  const memory = new SqliteMemory({ dir })
  const session = new Session({
    scope: origin,
    provider,
    model: 'test-model',
    system: 'BASE',
    registry,
    memory,
    store,
    record,
    cwd: process.cwd(),
    jobs,
    permissionPolicy: new DefaultPermissionPolicy({ mode: 'yolo' }),
    maxSteps: 10,
  })
  return { session, store }
}

describe('same-turn job continuation and early-completion races', () => {
  it('continues in the same turn with job_wait and does not emit duplicate post-turn notifications', async () => {
    const jobs = new JobManager()
    const announcements: string[] = []
    let sawPayloadInSameTurn = false

    const provider = new ScriptedProvider((call, req) => {
      if (call === 1) {
        return [
          { type: 'text', delta: 'Downloading Android tools…' },
          {
            type: 'tool-call',
            id: 'c1',
            name: 'shell_command',
            args: { command: 'sleep 0.05 && echo TOOLS_EXTRACTED', background: true },
          },
          { type: 'done', finishReason: 'tool_calls' },
        ]
      }
      if (call === 2) {
        return [
          { type: 'tool-call', id: 'c2', name: 'job_wait', args: {} },
          { type: 'done', finishReason: 'tool_calls' },
        ]
      }
      sawPayloadInSameTurn = req.messages.some(
        (m) => m.role === 'tool' && JSON.stringify(m.content).includes('TOOLS_EXTRACTED'),
      )
      return [
        { type: 'text', delta: 'Tools extracted and ready.' },
        { type: 'done', finishReason: 'stop' },
      ]
    })

    const { session } = await makeSession(provider, jobs)
    const runtime = { jobs, getSession: async () => session } as never
    const detach = attachJobNotifier(runtime, (_job, msg) => {
      announcements.push(msg.text)
    })

    const events: AgentEvent[] = []
    for await (const event of session.send('Prepare the Android image')) {
      events.push(event)
    }
    await tick(60)
    detach()

    expect(provider.calls).toBe(3)
    expect(sawPayloadInSameTurn).toBe(true)
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1)
    expect(announcements).toEqual([])
    await jobs.close()
  })

  it('keeps the turn active when the model emits progress without tool calls while a task job is still running', async () => {
    const jobs = new JobManager()
    const announcements: string[] = []
    let continuationSawResult = false

    const provider = new ScriptedProvider((call, req) => {
      if (call === 1) {
        return [
          {
            type: 'tool-call',
            id: 'c1',
            name: 'shell_command',
            args: { command: 'sleep 0.08 && echo IMAGE_READY', background: true },
          },
          { type: 'done', finishReason: 'tool_calls' },
        ]
      }
      if (call === 2) {
        // Model emits a progress message with NO tool call (would previously end the turn prematurely).
        return [
          { type: 'text', delta: 'Downloading Android tools, will continue once finished.' },
          { type: 'done', finishReason: 'stop' },
        ]
      }
      continuationSawResult = req.messages.some(
        (m) => m.role === 'user' && m.internal === 'job' && JSON.stringify(m.content).includes('IMAGE_READY'),
      )
      return [
        { type: 'text', delta: 'All done: image is ready.' },
        { type: 'done', finishReason: 'stop' },
      ]
    })

    const { session } = await makeSession(provider, jobs)
    const runtime = { jobs, getSession: async () => session } as never
    const detach = attachJobNotifier(runtime, (_job, msg) => {
      announcements.push(msg.text)
    })

    const events: AgentEvent[] = []
    for await (const event of session.send('Prepare the rooted Android image')) {
      events.push(event)
    }
    await tick(60)
    detach()

    expect(provider.calls).toBe(3)
    expect(continuationSawResult).toBe(true)
    expect(events.some((e) => e.type === 'job-waiting')).toBe(true)
    expect(events.some((e) => e.type === 'job-waited' && e.reason === 'settled')).toBe(true)
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1)
    expect(announcements).toEqual([])
    // Internal job continuation message must not leak into visible user turns.
    expect(session.messages.filter((m) => m.role === 'user' && !m.internal)).toHaveLength(1)
    await jobs.close()
  })

  it('reproduces the early-completion race (wise-yak-27): job finishes while the turn is still streaming its closing text', async () => {
    const jobs = new JobManager()
    const announcements: string[] = []
    let sawEarlyResultInSameTurn = false

    const provider = new ScriptedProvider(async function* (call, req) {
      if (call === 1) {
        yield {
          type: 'tool-call',
          id: 'c1',
          name: 'shell_command',
          args: { command: 'echo ANDROID_TOOLS_OK', background: true },
        }
        yield { type: 'done', finishReason: 'tool_calls' }
        return
      }
      if (call === 2) {
        yield { type: 'text', delta: 'Started job to download and extract Android tools. ' }
        // Wait long enough for the background job to finish WHILE this stream is still open!
        for (let i = 0; i < 100 && jobs.list().every((j) => j.state === 'running'); i += 1) {
          await tick(10)
        }
        expect(jobs.list()[0]?.state).toBe('done')
        yield { type: 'text', delta: 'I will continue once it finishes.' }
        yield { type: 'done', finishReason: 'stop' }
        return
      }
      sawEarlyResultInSameTurn = req.messages.some(
        (m) =>
          m.role === 'user' &&
          m.internal === 'job' &&
          JSON.stringify(m.content).includes('ANDROID_TOOLS_OK'),
      )
      yield { type: 'text', delta: 'Continued immediately and finished preparing the image.' }
      yield { type: 'done', finishReason: 'stop' }
    })

    const { session } = await makeSession(provider, jobs)
    const runtime = { jobs, getSession: async () => session } as never
    const detach = attachJobNotifier(runtime, (_job, msg) => {
      announcements.push(msg.text)
    })

    const events: AgentEvent[] = []
    for await (const event of session.send('Prepare rooted Android image and test Play Store')) {
      events.push(event)
    }
    await tick(60)
    detach()

    // Must not require a user "ok", must stay in one turn, and must not fire a duplicate announcement.
    expect(provider.calls).toBe(3)
    expect(sawEarlyResultInSameTurn).toBe(true)
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1)
    expect(announcements).toEqual([])
    await jobs.close()
  })

  it('delivers non-zero job failure into the same turn and avoids duplicate failure announcements', async () => {
    const jobs = new JobManager()
    const announcements: string[] = []
    let sawFailureDetails = false

    const provider = new ScriptedProvider((call, req) => {
      if (call === 1) {
        return [
          {
            type: 'tool-call',
            id: 'c1',
            name: 'shell_command',
            args: { command: 'echo checksum_mismatch >&2; exit 2', background: true },
          },
          { type: 'done', finishReason: 'tool_calls' },
        ]
      }
      if (call === 2) {
        return [
          { type: 'text', delta: 'Checking tools…' },
          { type: 'done', finishReason: 'stop' },
        ]
      }
      const serialized = JSON.stringify(req.messages)
      sawFailureDetails =
        serialized.includes('failed (exit 2)') && serialized.includes('checksum_mismatch')
      return [
        { type: 'text', delta: 'Download failed with checksum_mismatch (exit 2).' },
        { type: 'done', finishReason: 'stop' },
      ]
    })

    const { session } = await makeSession(provider, jobs)
    const runtime = { jobs, getSession: async () => session } as never
    const detach = attachJobNotifier(runtime, (_job, msg) => {
      announcements.push(msg.text)
    })

    const events: AgentEvent[] = []
    for await (const event of session.send('Download tools')) {
      events.push(event)
    }
    await tick(60)
    detach()

    expect(provider.calls).toBe(3)
    expect(sawFailureDetails).toBe(true)
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1)
    expect(announcements).toEqual([])
    await jobs.close()
  })

  it('allows steering guidance during wait and wakes immediately to process it', async () => {
    const jobs = new JobManager()
    const registry = new ToolRegistry([shellTool, ...createJobTools(jobs)])
    const steering: string[] = []
    let sawSteer = false
    let killedJob = false

    const provider = new ScriptedProvider((call, req) => {
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
      if (call === 2) {
        return [
          { type: 'text', delta: 'Waiting for the download…' },
          { type: 'done', finishReason: 'stop' },
        ]
      }
      if (call === 3) {
        sawSteer = req.messages.some(
          (m) => m.role === 'user' && !m.internal && JSON.stringify(m.content).includes('cancel and skip'),
        )
        const runningJob = jobs.list().find((j) => j.state === 'running')
        if (runningJob) {
          killedJob = true
          return [
            { type: 'tool-call', id: 'c2', name: 'job_kill', args: { id: runningJob.id } },
            { type: 'done', finishReason: 'tool_calls' },
          ]
        }
      }
      return [
        { type: 'text', delta: 'Stopped the download as requested.' },
        { type: 'done', finishReason: 'stop' },
      ]
    })

    const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'start download' }] }]
    const events: AgentEvent[] = []
    for await (const event of runAgent({
      provider,
      model: 'm',
      tools: registry.specs(),
      registry,
      messages,
      context: { cwd: process.cwd(), signal: new AbortController().signal, jobs, sessionId: 's-steer' },
      steering,
    })) {
      events.push(event)
      if (event.type === 'job-waiting') {
        setTimeout(() => steering.push('cancel and skip'), 25)
      }
    }

    expect(sawSteer).toBe(true)
    expect(killedJob).toBe(true)
    expect(events.some((e) => e.type === 'steer' && e.text === 'cancel and skip')).toBe(true)
    expect(events.some((e) => e.type === 'job-waited' && e.reason === 'steered')).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: 'done' })
    await jobs.close()
  })

  it('cancels the running task job when the turn is stopped during the wait and emits no post-turn notice', async () => {
    const jobs = new JobManager()
    const announcements: string[] = []
    const controller = new AbortController()

    const provider = new ScriptedProvider((call) => {
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
        { type: 'text', delta: 'Working on it…' },
        { type: 'done', finishReason: 'stop' },
      ]
    })

    const { session } = await makeSession(provider, jobs)
    const runtime = { jobs, getSession: async () => session } as never
    const detach = attachJobNotifier(runtime, (_job, msg) => {
      announcements.push(msg.text)
    })

    const events: AgentEvent[] = []
    for await (const event of session.send('Run long task', { signal: controller.signal })) {
      events.push(event)
      if (event.type === 'job-waiting') {
        setTimeout(() => controller.abort(), 30)
      }
    }

    for (let i = 0; i < 100 && jobs.list(session.id).some((j) => j.state === 'running'); i += 1) {
      await tick(10)
    }
    detach()

    expect(events.some((e) => e.type === 'aborted')).toBe(true)
    expect(events.some((e) => e.type === 'error')).toBe(false)
    expect(jobs.list(session.id)[0]?.state).toBe('killed')
    expect(announcements).toEqual([])
    await jobs.close()
  })

  it('wakes immediately when a user kills the waited job directly via jobs.kill', async () => {
    const jobs = new JobManager()
    let sawStopped = false

    const provider = new ScriptedProvider((call, req) => {
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
      if (call === 2) {
        return [
          { type: 'text', delta: 'Waiting…' },
          { type: 'done', finishReason: 'stop' },
        ]
      }
      sawStopped = req.messages.some(
        (m) => m.role === 'user' && m.internal === 'job' && JSON.stringify(m.content).includes('was stopped'),
      )
      return [
        { type: 'text', delta: 'Job was stopped by user.' },
        { type: 'done', finishReason: 'stop' },
      ]
    })

    const { session } = await makeSession(provider, jobs)
    const events: AgentEvent[] = []
    for await (const event of session.send('Run long task')) {
      events.push(event)
      if (event.type === 'job-waiting') {
        setTimeout(() => {
          jobs.kill(event.ids[0]!, session.id)
        }, 25)
      }
    }

    expect(sawStopped).toBe(true)
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1)
    await jobs.close()
  })

  it('preserves independent detached background jobs: turn finishes immediately and notifies when the job ends later', async () => {
    const jobs = new JobManager()
    const announcements: string[] = []

    const provider = new ScriptedProvider((call) => {
      if (call === 1) {
        return [
          {
            type: 'tool-call',
            id: 'c1',
            name: 'shell_command',
            args: { command: 'sleep 0.08 && echo SERVER_DONE', background: true, detach: true },
          },
          { type: 'done', finishReason: 'tool_calls' },
        ]
      }
      if (call === 2) {
        return [
          { type: 'text', delta: 'Left running in the background.' },
          { type: 'done', finishReason: 'stop' },
        ]
      }
      return [
        { type: 'text', delta: 'The independent background job finished.' },
        { type: 'done', finishReason: 'stop' },
      ]
    })

    const { session } = await makeSession(provider, jobs)
    const runtime = { jobs, getSession: async () => session } as never
    const detach = attachJobNotifier(runtime, (_job, msg) => {
      announcements.push(msg.text)
    })

    const events: AgentEvent[] = []
    for await (const event of session.send('Start this in the background and do not wait')) {
      events.push(event)
    }

    // Turn ended right away while the detached job is still running.
    expect(provider.calls).toBe(2)
    expect(events.some((e) => e.type === 'job-waiting')).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: 'done' })
    expect(jobs.list(session.id)[0]?.state).toBe('running')

    // Wait for the detached job to finish and announce via attachJobNotifier.
    for (let i = 0; i < 100 && announcements.length === 0; i += 1) {
      await tick(15)
    }
    detach()

    expect(announcements).toEqual(['The independent background job finished.'])
    await jobs.close()
  })

  it('flushes progress cleanly across job-waiting/job-waited in the shared gateway runner', async () => {
    const jobs = new JobManager()
    const provider = new ScriptedProvider((call) => {
      if (call === 1) {
        return [
          {
            type: 'tool-call',
            id: 'c1',
            name: 'shell_command',
            args: { command: 'sleep 0.05 && echo DONE', background: true },
          },
          { type: 'done', finishReason: 'tool_calls' },
        ]
      }
      if (call === 2) {
        return [
          { type: 'text', delta: 'Downloading tools…' },
          { type: 'done', finishReason: 'stop' },
        ]
      }
      return [
        { type: 'text', delta: 'Finished configuring image.' },
        { type: 'done', finishReason: 'stop' },
      ]
    })

    const { session } = await makeSession(provider, jobs)
    const edits: string[] = []
    const surface: ChatSurface = {
      post: async () => 'm1',
      edit: async (_chatId, _id, value) => {
        edits.push(value)
      },
      ask: async () => ({ allowed: true }),
      files: async () => undefined,
      typing: () => () => undefined,
    }

    await runTurn({
      session,
      chatId: 'main',
      text: 'Prepare image',
      surface,
      maxLength: 4000,
      flushMs: 0,
    })

    // The progress line was flushed while waiting, and the continuation starts on a new paragraph.
    expect(edits.some((text) => text.includes('Downloading tools…'))).toBe(true)
    expect(edits.at(-1)).toContain('Downloading tools…\n\nFinished configuring image.')
    await jobs.close()
  })

  it('waits in-turn for a turn-bound job with notify=never, delivers its result, and emits no duplicate notice', async () => {
    const jobs = new JobManager()
    const announcements: string[] = []
    let sawOutput = false

    const provider = new ScriptedProvider((call, req) => {
      if (call === 1) {
        return [
          {
            type: 'tool-call',
            id: 'c1',
            name: 'shell_command',
            args: { command: 'sleep 0.05 && echo QUIET_OK', background: true, notify: 'never' },
          },
          { type: 'done', finishReason: 'tool_calls' },
        ]
      }
      if (call === 2) {
        return [
          { type: 'text', delta: 'Running step…' },
          { type: 'done', finishReason: 'stop' },
        ]
      }
      sawOutput = req.messages.some(
        (m) => m.role === 'user' && m.internal === 'job' && JSON.stringify(m.content).includes('QUIET_OK'),
      )
      return [
        { type: 'text', delta: 'Continued with QUIET_OK in the same turn.' },
        { type: 'done', finishReason: 'stop' },
      ]
    })

    const { session } = await makeSession(provider, jobs)
    const runtime = { jobs, getSession: async () => session } as never
    const detach = attachJobNotifier(runtime, (_job, msg) => {
      announcements.push(msg.text)
    })

    const events: AgentEvent[] = []
    for await (const event of session.send('Run quiet turn job')) {
      events.push(event)
    }
    await tick(60)
    detach()

    expect(sawOutput).toBe(true)
    expect(events.some((e) => e.type === 'job-waiting')).toBe(true)
    expect(events.some((e) => e.type === 'job-waited' && e.reason === 'settled')).toBe(true)
    expect(announcements).toEqual([])
    await jobs.close()
  })

  it('delivers failure of a turn-bound job with notify=never in-turn without a duplicate notice', async () => {
    const jobs = new JobManager()
    const announcements: string[] = []
    let sawFailure = false

    const provider = new ScriptedProvider((call, req) => {
      if (call === 1) {
        return [
          {
            type: 'tool-call',
            id: 'c1',
            name: 'shell_command',
            args: { command: 'sleep 0.04 && echo TURN_FAIL >&2 && exit 2', background: true, notify: 'never' },
          },
          { type: 'done', finishReason: 'tool_calls' },
        ]
      }
      if (call === 2) {
        return [
          { type: 'text', delta: 'Waiting on command…' },
          { type: 'done', finishReason: 'stop' },
        ]
      }
      sawFailure = req.messages.some(
        (m) => m.role === 'user' && m.internal === 'job' && JSON.stringify(m.content).includes('exit 2'),
      )
      return [
        { type: 'text', delta: 'The command failed with exit 2.' },
        { type: 'done', finishReason: 'stop' },
      ]
    })

    const { session } = await makeSession(provider, jobs)
    const runtime = { jobs, getSession: async () => session } as never
    const detach = attachJobNotifier(runtime, (_job, msg) => {
      announcements.push(msg.text)
    })

    const events: AgentEvent[] = []
    for await (const event of session.send('Run failing quiet job')) {
      events.push(event)
    }
    await tick(60)
    detach()

    expect(sawFailure).toBe(true)
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1)
    expect(announcements).toEqual([])
    await jobs.close()
  })

  it('leaves an independent silent job (detach=true, notify=never) running and suppresses its success notice', async () => {
    const jobs = new JobManager()
    const announcements: string[] = []

    const provider = new ScriptedProvider((call) => {
      if (call === 1) {
        return [
          {
            type: 'tool-call',
            id: 'c1',
            name: 'shell_command',
            args: { command: 'sleep 0.05 && echo SILENT_BG_OK', background: true, detach: true, notify: 'never' },
          },
          { type: 'done', finishReason: 'tool_calls' },
        ]
      }
      return [
        { type: 'text', delta: 'Started silently in the background.' },
        { type: 'done', finishReason: 'stop' },
      ]
    })

    const { session } = await makeSession(provider, jobs)
    const runtime = { jobs, getSession: async () => session } as never
    const detach = attachJobNotifier(runtime, (_job, msg) => {
      announcements.push(msg.text)
    })

    const events: AgentEvent[] = []
    for await (const event of session.send('Start silent background job')) {
      events.push(event)
    }

    expect(provider.calls).toBe(2)
    expect(events.some((e) => e.type === 'job-waiting')).toBe(false)
    expect(jobs.list(session.id)[0]?.state).toBe('running')

    for (let i = 0; i < 100 && jobs.list(session.id)[0]?.state === 'running'; i += 1) {
      await tick(15)
    }
    await tick(40)
    detach()

    expect(jobs.list(session.id)[0]?.state).toBe('done')
    expect(announcements).toEqual([])
    await jobs.close()
  })

  it('still announces failure of an independent job started with detach=true and notify=never', async () => {
    const jobs = new JobManager()
    const announcements: string[] = []

    const provider = new ScriptedProvider((call) => {
      if (call === 1) {
        return [
          {
            type: 'tool-call',
            id: 'c1',
            name: 'shell_command',
            args: { command: 'sleep 0.05 && echo BG_BOOM >&2 && exit 3', background: true, detach: true, notify: 'never' },
          },
          { type: 'done', finishReason: 'tool_calls' },
        ]
      }
      if (call === 2) {
        return [
          { type: 'text', delta: 'Started silently in the background.' },
          { type: 'done', finishReason: 'stop' },
        ]
      }
      return [
        { type: 'text', delta: 'Background job failed with exit 3.' },
        { type: 'done', finishReason: 'stop' },
      ]
    })

    const { session } = await makeSession(provider, jobs)
    const runtime = { jobs, getSession: async () => session } as never
    const detach = attachJobNotifier(runtime, (_job, msg) => {
      announcements.push(msg.text)
    })

    const events: AgentEvent[] = []
    for await (const event of session.send('Start silent background job that fails')) {
      events.push(event)
    }
    expect(events.some((e) => e.type === 'job-waiting')).toBe(false)

    for (let i = 0; i < 100 && announcements.length === 0; i += 1) {
      await tick(15)
    }
    detach()

    expect(jobs.list(session.id)[0]?.state).toBe('error')
    expect(announcements).toEqual(['Background job failed with exit 3.'])
    await jobs.close()
  })
})
