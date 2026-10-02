import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { stringify } from 'yaml'
import type { ChatRequest, Provider, StreamEvent } from '../src/core/providers/types.js'
import type { TranscriptMessage } from '../src/gateways/web/protocol.js'

const home = mkdtempSync(path.join(os.tmpdir(), 'milo-web-runs-'))
process.env.MILO_HOME = home

const { WebSettings } = await import('../src/gateways/web/settings.js')
const { AgentRuntime } = await import('../src/core/runtime.js')
const { createToolRegistry } = await import('../src/core/tools/index.js')
const { MAX_RUNS_PER_ROUTINE } = await import('../src/core/routines.js')

const CONVERSATION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
})

function writeConfig(): void {
  writeFileSync(path.join(home, 'config.yml'), stringify({
    provider: 'test',
    model: 'test-model',
    providers: { test: { baseURL: 'https://provider.example/v1' } },
  }))
}

/** Answers one word, so a run has something to read back. */
class AnswerProvider implements Provider {
  readonly id = 'test'
  async *stream(_request: ChatRequest): AsyncGenerator<StreamEvent> {
    yield { type: 'text', delta: 'nothing moved' }
    yield { type: 'done', finishReason: 'stop' }
  }
}

/** Calls `send_file` once, then answers: a run whose whole job is a picture. */
class ShotProvider implements Provider {
  readonly id = 'test'
  private calls = 0
  constructor(private readonly file: string) {}
  async *stream(_request: ChatRequest): AsyncGenerator<StreamEvent> {
    this.calls += 1
    if (this.calls === 1) {
      yield { type: 'tool-call', id: 'c1', name: 'send_file', args: { path: this.file, caption: 'the screen' } }
      yield { type: 'done', finishReason: 'tool_calls' }
      return
    }
    yield { type: 'text', delta: 'sent it' }
    yield { type: 'done', finishReason: 'stop' }
  }
}

function build(provider: Provider = new AnswerProvider()): InstanceType<typeof AgentRuntime> {
  return new AgentRuntime({
    provider,
    model: 'test-model',
    system: '',
    registry: createToolRegistry(),
    memory: { remember: async () => undefined, recall: async () => [], list: async () => [], forget: async () => false } as never,
    cwd: home,
  })
}

/** The registry the running server hands in, recording what it was asked to serve. */
function registry(served: string[] = []) {
  return {
    register: (file: { path: string; name: string; mimeType: string }) => {
      served.push(file.name)
      return { id: `id-${file.name}`, name: file.name, mimeType: file.mimeType, size: 0, image: false }
    },
  }
}

describe('web Settings reads a routine’s runs', () => {
  it('lists what a routine produced, and reads one run back as a transcript', async () => {
    writeConfig()
    const settings = new WebSettings(build(), home, registry())
    const created = await settings.handle('routine-add', {
      prompt: 'look at the repo',
      every: '6h',
      target: { gateway: 'web', conversationId: CONVERSATION },
    }) as { routine: { id: string } }

    const { runId } = await settings.handle('routine-run', { id: created.routine.id }) as { runId: string }

    const history = await settings.handle('routine-runs', { id: created.routine.id }) as { total: number; runs: { id: string; at: number }[] }
    expect(history.total).toBe(1)
    expect(history.runs.map((run) => run.id)).toEqual([runId])
    // A page past the end is empty, which is how the list knows to stop asking.
    const past = await settings.handle('routine-runs', { id: created.routine.id, offset: 1, limit: 20 }) as { runs: unknown[] }
    expect(past.runs).toEqual([])

    const transcript = await settings.handle('run-transcript', { id: runId }) as TranscriptMessage[]
    expect(transcript[0]).toMatchObject({ role: 'user', text: 'look at the repo' })
    expect(transcript.at(-1)).toMatchObject({ role: 'assistant', text: 'nothing moved' })
  })

  it('draws the file a run sent, through the server’s own registry', async () => {
    writeConfig()
    const shot = path.join(home, 'shot.png')
    writeFileSync(shot, 'not really a png')
    const served: string[] = []
    const settings = new WebSettings(build(new ShotProvider(shot)), home, registry(served))
    const created = await settings.handle('routine-add', {
      prompt: 'screenshot the page',
      every: '6h',
      target: { gateway: 'web', conversationId: CONVERSATION },
      allow: ['send_file'],
    }) as { routine: { id: string } }

    const { runId } = await settings.handle('routine-run', { id: created.routine.id }) as { runId: string }
    const transcript = await settings.handle('run-transcript', { id: runId }) as TranscriptMessage[]

    // The run's own record kept the picture, and reading it back registered the
    // file so `/attachment/<id>` can serve it — the same path a chat uses.
    expect(served).toContain('shot.png')
    expect(transcript.flatMap((message) => message.attachments ?? [])).toEqual([
      expect.objectContaining({ name: 'shot.png' }),
    ])
  })

  it('reads a run without taking the conversation over', async () => {
    writeConfig()
    const runtime = build()
    const settings = new WebSettings(runtime, home, registry())
    const created = await settings.handle('routine-add', {
      prompt: 'look at the repo',
      every: '6h',
      target: { gateway: 'web', conversationId: CONVERSATION },
    }) as { routine: { id: string } }
    const { runId } = await settings.handle('routine-run', { id: created.routine.id }) as { runId: string }

    const before = (await runtime.getSession({ gateway: 'web', conversationId: CONVERSATION })).id
    await settings.handle('run-transcript', { id: runId })
    // Read-only: the run is loaded and drawn, never bound — so opening a past run
    // does not move the conversation somebody is sitting in.
    expect((await runtime.getSession({ gateway: 'web', conversationId: CONVERSATION })).id).toBe(before)
  })

  it('says so when the run or the routine is not there', async () => {
    writeConfig()
    const settings = new WebSettings(build(), home, registry())
    await expect(settings.handle('run-transcript', { id: 'nope-nope-9' })).rejects.toThrow('No such run')
    await expect(settings.handle('routine-runs', { id: 'no-such-routine' })).rejects.toThrow('No routine')
  })
})
