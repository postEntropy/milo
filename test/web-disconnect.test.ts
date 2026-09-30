import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatRequest, Provider, StreamEvent } from '../src/core/providers/types.js'

const home = mkdtempSync(path.join(os.tmpdir(), 'milo-web-disconnect-'))
process.env.MILO_HOME = home

const { WebHub } = await import('../src/gateways/web/hub.js')
const { AgentRuntime } = await import('../src/core/runtime.js')

const CONVERSATION = '11111111-2222-3333-4444-555555555555'

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
})

/** A promise one side of the test opens by hand, so a turn can be held mid-stream. */
function gate(): { promise: Promise<void>; open(): void } {
  let open!: () => void
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

/**
 * Holds the answer until the test lets go, so the turn is provably still in
 * flight while the client goes away. A stop reaching this stream rejects instead
 * of answering, which is the whole difference under test.
 */
class HeldProvider implements Provider {
  readonly id = 'held'
  private readonly started = gate()
  private readonly allowed = gate()

  /** Resolves once the model call is running, so the turn has begun. */
  reached(): Promise<void> {
    return this.started.promise
  }

  /** Lets the held answer through. */
  answer(): void {
    this.allowed.open()
  }

  async *stream(request: ChatRequest): AsyncGenerator<StreamEvent> {
    this.started.open()
    await new Promise<void>((resolve, reject) => {
      const signal = request.signal
      const stopped = (): void => {
        const error = new Error('This operation was aborted.')
        error.name = 'AbortError'
        reject(error)
      }
      if (signal?.aborted) {
        stopped()
        return
      }
      signal?.addEventListener('abort', stopped, { once: true })
      void this.allowed.promise.then(() => resolve())
    })
    yield { type: 'text', delta: 'the answer arrived with nobody watching' }
    yield { type: 'done', finishReason: 'stop' }
  }
}

function build(provider: Provider): InstanceType<typeof AgentRuntime> {
  return new AgentRuntime({
    provider,
    model: 'test-model',
    system: '',
    registry: { specs: () => [] } as never,
    memory: {
      remember: async () => undefined,
      recall: async () => [],
      list: async () => [],
      forget: async () => false,
    } as never,
    cwd: home,
  })
}

/** Every text part of the conversation's transcript, in order. */
async function transcript(runtime: InstanceType<typeof AgentRuntime>): Promise<string[]> {
  const session = await runtime.getSession({ gateway: 'web', conversationId: CONVERSATION })
  return session.messages.flatMap((message) =>
    message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])))
}

describe('a client leaving a web conversation', () => {
  it('keeps the turn running when the last one goes', async () => {
    const provider = new HeldProvider()
    const runtime = build(provider)
    const hub = new WebHub(runtime, { provider: 'test', model: 'test-model' })
    const frames: unknown[] = []
    const client = { send: (frame: unknown) => void frames.push(frame) }

    await hub.connect(client, CONVERSATION)
    hub.handle(client, { type: 'send', text: 'still there?' }, CONVERSATION)
    await provider.reached()

    // A reload, a closed tab and a phone locking all close this socket exactly
    // the way a closing tab does, and nothing on the wire tells them apart — so
    // the turn is not the socket's to end. Only the stop control ends one.
    hub.disconnect(client)
    provider.answer()

    expect(
      await waitFor(async () => (await transcript(runtime)).includes('the answer arrived with nobody watching')),
    ).toBe(true)
  })
})

async function waitFor(condition: () => Promise<boolean>): Promise<boolean> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await condition()) return true
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return false
}
