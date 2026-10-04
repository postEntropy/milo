import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatRequest, Provider, StreamEvent } from '../src/core/providers/types.js'
import type { ServerFrame } from '../src/gateways/web/protocol.js'

const home = mkdtempSync(path.join(os.tmpdir(), 'milo-web-ideas-'))
process.env.MILO_HOME = home

const { WebHub } = await import('../src/gateways/web/hub.js')
const { AgentRuntime } = await import('../src/core/runtime.js')

const EMPTY = '11111111-2222-3333-4444-555555555555'
const OTHER = '99999999-8888-7777-6666-555555555555'

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
})

/** Answers the ideas call with two cards, and any turn with a plain reply — counting ideas calls, so a test can prove the cache held. */
class IdeaProvider implements Provider {
  readonly id = 'ideas'
  ideaCalls = 0

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    if (req.system?.includes('suggest what a person')) {
      this.ideaCalls += 1
      yield { type: 'text', delta: 'Investigate the deploy | Why did the deploy fail?\nTidy the memory | Help me clean up what you remember.' }
      yield { type: 'done', finishReason: 'stop' }
      return
    }
    yield { type: 'text', delta: 'hello back' }
    yield { type: 'done', finishReason: 'stop' }
  }
}

/** Holds the ideas call until it is aborted, and answers turns normally. */
class CancellableProvider implements Provider {
  readonly id = 'cancel'
  ideaStarted = 0

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    if (req.system?.includes('suggest what a person')) {
      this.ideaStarted += 1
      await new Promise<void>((resolve) => req.signal?.addEventListener('abort', () => resolve(), { once: true }))
      throw new Error('This operation was aborted')
    }
    yield { type: 'text', delta: 'hello back' }
    yield { type: 'done', finishReason: 'stop' }
  }
}

function build(
  provider: Provider,
  notes: { id: string; text: string; createdAt: number }[] = [{ id: 'n1', text: 'prefers concise answers', createdAt: 0 }],
): InstanceType<typeof AgentRuntime> {
  return new AgentRuntime({
    provider,
    model: 'test-model',
    system: '',
    registry: { specs: () => [] } as never,
    memory: {
      remember: async () => undefined,
      recall: async () => [],
      list: async () => notes,
      forget: async () => false,
    } as never,
    cwd: home,
  })
}

const ideasOf = (frames: ServerFrame[]): Extract<ServerFrame, { type: 'suggestions' }>[] =>
  frames.filter((frame): frame is Extract<ServerFrame, { type: 'suggestions' }> => frame.type === 'suggestions')

// Parked with `IDEAS_ENABLED` in src/gateways/web/hub.ts — un-skip when it is turned
// back on. See `worklog.md`.
describe.skip('ideas on the empty web home', () => {
  it('derives them in the background and pushes them to the page', async () => {
    const provider = new IdeaProvider()
    const hub = new WebHub(build(provider))
    const frames: ServerFrame[] = []

    await hub.connect({ send: (frame) => frames.push(frame) }, EMPTY)
    // The handshake is on the wire before the call even starts: nothing waits.
    expect(frames.some((frame) => frame.type === 'ready')).toBe(true)

    await hub.flush()
    expect(ideasOf(frames).at(-1)).toEqual({
      type: 'suggestions',
      items: [
        { title: 'Investigate the deploy', prompt: 'Why did the deploy fail?' },
        { title: 'Tidy the memory', prompt: 'Help me clean up what you remember.' },
      ],
    })
    expect(provider.ideaCalls).toBe(1)
  })

  it('reuses a fresh answer, so several empty chats cost one call', async () => {
    const provider = new IdeaProvider()
    const hub = new WebHub(build(provider))
    const first: ServerFrame[] = []
    const second: ServerFrame[] = []

    await hub.connect({ send: (frame) => first.push(frame) }, EMPTY)
    await hub.flush()
    await hub.connect({ send: (frame) => second.push(frame) }, OTHER)
    await hub.flush()

    expect(provider.ideaCalls).toBe(1)
    expect(ideasOf(second)).toHaveLength(1)
  })

  it('holds to one call in the window, even when what Milo knows changes', async () => {
    const provider = new IdeaProvider()
    const notes = [{ id: 'n1', text: 'prefers concise answers', createdAt: 0 }]
    const hub = new WebHub(build(provider, notes))
    const first: ServerFrame[] = []
    const second: ServerFrame[] = []

    await hub.connect({ send: (frame) => first.push(frame) }, EMPTY)
    await hub.flush()
    expect(provider.ideaCalls).toBe(1)

    // A new note changes the key, which would otherwise spend a second call.
    notes.length = 0
    notes.push({ id: 'n2', text: 'now works on something else', createdAt: 1 })
    await hub.connect({ send: (frame) => second.push(frame) }, OTHER)
    await hub.flush()

    expect(provider.ideaCalls).toBe(1)
    // Served the ideas already in hand rather than calling again.
    expect(ideasOf(second)).toHaveLength(1)
  })

  it('cuts the call off when a turn starts, so nothing lands behind the answer', async () => {
    const provider = new CancellableProvider()
    const hub = new WebHub(build(provider))
    const frames: ServerFrame[] = []
    const client = { send: (frame: ServerFrame) => frames.push(frame) }

    await hub.connect(client, EMPTY)
    await tick()
    expect(provider.ideaStarted).toBe(1)

    hub.handle(client, { type: 'send', text: 'hello' }, EMPTY)
    await hub.flush()
    await tick()

    expect(ideasOf(frames)).toHaveLength(0)
    hub.close()
  })
})

const tick = (ms = 10): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
