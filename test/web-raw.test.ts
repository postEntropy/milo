import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatRequest, Provider, StreamEvent } from '../src/core/providers/types.js'

const home = mkdtempSync(path.join(os.tmpdir(), 'milo-web-raw-'))
process.env.MILO_HOME = home

const { WebHub } = await import('../src/gateways/web/hub.js')
const { AgentRuntime } = await import('../src/core/runtime.js')

const CHAT = '11111111-2222-3333-4444-555555555555'

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
})

/** Calls one tool, then answers: a turn whose raw copy holds a call, its arguments and
 *  the result that came back — the one shape the two copies read differently in. */
class CallsAndAnswersProvider implements Provider {
  readonly id = 'calls-and-answers'
  private calls = 0

  async *stream(_request: ChatRequest): AsyncGenerator<StreamEvent> {
    this.calls += 1
    if (this.calls === 1) {
      yield { type: 'tool-call', id: 'c1', name: 'read_file', args: { path: 'a.txt' } }
      yield { type: 'done', finishReason: 'tool_calls' }
      return
    }
    yield { type: 'text', delta: 'It is fine.' }
    yield { type: 'done', finishReason: 'stop' }
  }
}

function build(provider: Provider): InstanceType<typeof AgentRuntime> {
  return new AgentRuntime({
    provider,
    model: 'test-model',
    system: '',
    registry: {
      specs: () => [],
      get: () => undefined,
      execute: async () => ({ content: 'the file says hello' }),
    } as never,
    memory: {
      remember: async () => undefined,
      recall: async () => [],
      list: async () => [],
      forget: async () => false,
    } as never,
    cwd: home,
  })
}

interface Frame {
  type: string
  raw?: string
  rawNoOutput?: string
}

function client(frames: Frame[]): { send(frame: unknown): void } {
  return { send: (frame: unknown) => void frames.push(frame as Frame) }
}

describe('a web turn’s copies on the wire', () => {
  it('rides the turn-end with the turn whole, and the same turn without the tool output', async () => {
    const hub = new WebHub(build(new CallsAndAnswersProvider()))
    const frames: Frame[] = []
    const page = client(frames)

    await hub.connect(page, CHAT)
    hub.handle(page, { type: 'send', text: 'look at a.txt' }, CHAT)
    await waitFor(() => frames.some((frame) => frame.type === 'turn-end'))

    const end = frames.find((frame) => frame.type === 'turn-end')
    // The whole copy: the call with its arguments, and what came back for it.
    expect(end?.raw).toContain('**read_file**')
    expect(end?.raw).toContain('a.txt')
    expect(end?.raw).toContain('the file says hello')
    // The second copy is the path: the call stays, the result's own words go.
    expect(end?.rawNoOutput).toContain('**read_file**')
    expect(end?.rawNoOutput).toContain('a.txt')
    expect(end?.rawNoOutput).not.toContain('the file says hello')
  })
})

/** The raw rides with the `turn-end`, which is the frame the turn is done on. */
async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 800; attempt += 1) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('the turn never ended')
}
