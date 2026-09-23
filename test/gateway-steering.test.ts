import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileMemory } from '../src/core/memory/local.js'
import type { ChatRequest, Provider, StreamEvent } from '../src/core/providers/types.js'
import { Session } from '../src/core/session.js'
import { MemorySessionStore } from '../src/core/sessions/memory-store.js'
import { createToolRegistry } from '../src/core/tools/index.js'
import { runTurn } from '../src/gateways/runner.js'
import type { ChatSurface } from '../src/gateways/surface.js'
import { TurnQueue } from '../src/gateways/turns.js'

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

/** Slow enough that a second message can arrive while the turn is running. */
class SlowProvider implements Provider {
  readonly id = 'slow'
  /** A snapshot per call: the session keeps pushing onto the array it handed in. */
  readonly requests: ChatRequest[] = []

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    this.requests.push({ ...req, messages: [...req.messages] })
    yield { type: 'text', delta: `answer ${this.requests.length}` }
    await tick(60)
    yield { type: 'done', finishReason: 'stop' }
  }
}

function usersOf(request: ChatRequest): string[] {
  return request.messages
    .filter((message) => message.role === 'user')
    .flatMap((message) =>
      message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])),
    )
}

async function harness() {
  const provider = new SlowProvider()
  const store = new MemorySessionStore()
  const record = await store.create()
  const session = new Session({
    scope: { gateway: 'telegram', conversationId: 'chat-1' },
    provider,
    model: 'm',
    system: 'BASE',
    registry: createToolRegistry(),
    memory: new FileMemory({ dir: mkdtempSync(path.join(tmpdir(), 'milo-steer-')) }),
    cwd: process.cwd(),
    record,
    store,
    maxSteps: 4,
  })

  const surface: ChatSurface = {
    post: async () => 'm1',
    edit: async () => undefined,
    ask: async () => true,
  }

  return { provider, session, surface }
}

describe('steering on a chat gateway', () => {
  it('takes up a message sent mid-turn, inside the same turn', async () => {
    const { provider, session, surface } = await harness()
    const queue = new TurnQueue()

    queue.run('chat-1', (steering) =>
      runTurn({
        session,
        conversationId: 'chat-1',
        text: 'read a.txt',
        surface,
        maxLength: 2000,
        flushMs: 0,
        steering,
      }),
    )

    await tick(30) // the turn is running, and its inbox belongs to it
    expect(queue.steer('chat-1', 'no, read b.txt')).toBe(true)
    await tick(250)

    // One turn, two model calls: the correction was answered inside it, where
    // starting a second turn would have raced the first over the same session.
    expect(provider.requests).toHaveLength(2)
    expect(usersOf(provider.requests[0]!)).toEqual(['read a.txt'])
    expect(usersOf(provider.requests[1]!)).toEqual(['read a.txt', 'no, read b.txt'])
  })

  it('runs a message as its own turn when nothing is running', async () => {
    const { provider, session, surface } = await harness()
    const queue = new TurnQueue()

    // Nobody to hand it to, so the gateway starts a turn instead of dropping it.
    expect(queue.steer('chat-1', 'hello')).toBe(false)
    queue.run('chat-1', (steering) =>
      runTurn({
        session,
        conversationId: 'chat-1',
        text: 'hello',
        surface,
        maxLength: 2000,
        flushMs: 0,
        steering,
      }),
    )
    await tick(200)

    expect(provider.requests).toHaveLength(1)
    expect(usersOf(provider.requests[0]!)).toEqual(['hello'])
  })
})
