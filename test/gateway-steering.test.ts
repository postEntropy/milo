import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileMemory } from '../src/core/memory/local.js'
import type { ChatRequest, Provider, StreamEvent } from '../src/core/providers/types.js'
import { Session } from '../src/core/session.js'
import { MemorySessionStore } from '../src/core/sessions/memory-store.js'
import { createToolRegistry } from '../src/core/tools/index.js'
import { runTurn, runTurns } from '../src/gateways/runner.js'
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
    // A real provider rejects when its request is cancelled. A fake that ignored
    // the signal would make a stop look like it worked while the turn ran on.
    if (req.signal?.aborted) throw new Error('aborted')
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

async function harness(options: { onEdit?: (value: string) => void } = {}) {
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

  const edits: string[] = []
  const surface: ChatSurface = {
    post: async () => 'm1',
    edit: async (_conversationId, _messageId, value) => {
      edits.push(value)
      options.onEdit?.(value)
    },
    ask: async () => true,
    typing: () => () => undefined,
  }

  return { provider, session, surface, edits }
}

/** A turn against this session, as a gateway would run it. */
function turnOn(
  session: Session,
  surface: ChatSurface,
  text: string,
): (steering: string[], signal: AbortSignal) => Promise<void> {
  return (steering, signal) =>
    runTurn({
      session,
      conversationId: 'chat-1',
      text,
      surface,
      maxLength: 2000,
      flushMs: 0,
      steering,
      signal,
    })
}

describe('the turns a gateway runs behind one message', () => {
  it('runs a correction that arrived too late as the next turn', async () => {
    const steering: string[] = []
    let injected = false
    const { provider, session, surface } = await harness({
      onEdit: () => {
        // Once: the second turn ends with an edit too, and a message landing
        // there is a third turn, not a reason for a fourth.
        if (injected) return
        injected = true
        steering.push('one more thing')
      },
    })

    await runTurns({
      session,
      conversationId: 'chat-1',
      text: 'first',
      surface,
      maxLength: 2000,
      flushMs: 60_000,
      steering,
    })

    // Taken, not dropped: the model never saw it inside the first turn, so it
    // gets a turn of its own rather than vanishing.
    expect(steering).toEqual([])
    expect(provider.requests).toHaveLength(2)
    expect(usersOf(provider.requests[1]!)).toEqual(['first', 'one more thing'])
  })

  it('drops what arrived too late when the turn was stopped', async () => {
    const controller = new AbortController()
    const steering: string[] = []
    let injected = false
    const { provider, session, surface } = await harness({
      onEdit: () => {
        if (injected) return
        injected = true
        steering.push('one more thing')
        // The stop lands in the same moment the message does.
        controller.abort()
      },
    })

    const failure = await runTurns({
      session,
      conversationId: 'chat-1',
      text: 'first',
      surface,
      maxLength: 2000,
      flushMs: 60_000,
      steering,
      signal: controller.signal,
    })

    // A stop is not a failure to report, and the leftover is not taken up: the
    // stop was the answer to everything sent by then.
    expect(failure).toBeNull()
    expect(provider.requests).toHaveLength(1)
  })

  it('hands back what a turn died of, for the surface to say', async () => {
    const { session, surface } = await harness()
    const failing: ChatSurface = {
      ...surface,
      post: async () => {
        throw new Error('posting failed')
      },
    }

    const failure = await runTurns({
      session,
      conversationId: 'chat-1',
      text: 'first',
      surface: failing,
      maxLength: 2000,
    })

    expect(failure).toContain('posting failed')
  })
})

describe('stopping a turn from a chat gateway', () => {
  it('ends the turn in flight as a stop, not as a failure', async () => {
    const { session, surface, edits } = await harness()
    const queue = new TurnQueue()

    queue.run('chat-1', turnOn(session, surface, 'a long task'))
    await tick(30)
    expect(queue.stop('chat-1')).toEqual({ stopped: true, dropped: 0 })
    await tick(250)

    // The model call was cancelled mid-stream, and that reads as the end of the
    // turn — not as an error the person has to interpret.
    expect(edits.at(-1)).toContain('🛑 stopped')
    expect(edits.at(-1)).not.toContain('[error]')
    expect(queue.busy('chat-1')).toBe(false)
  })

  it('drops the turns queued behind the one it stopped', async () => {
    const { provider, session, surface } = await harness()
    const queue = new TurnQueue()
    let ranSecond = false

    queue.run('chat-1', turnOn(session, surface, 'first'))
    queue.run('chat-1', async () => {
      ranSecond = true
      await turnOn(session, surface, 'second')([], new AbortController().signal)
    })
    await tick(30)

    expect(queue.queued('chat-1')).toBe(1)
    expect(queue.stop('chat-1')).toEqual({ stopped: true, dropped: 1 })
    await tick(250)

    // Stop means stop: not "stop this one, then start the next thing I sent".
    expect(ranSecond).toBe(false)
    expect(provider.requests).toHaveLength(1)
  })

  it('runs the next message normally, so a stop is not a dead end', async () => {
    const { provider, session, surface } = await harness()
    const queue = new TurnQueue()

    queue.run('chat-1', turnOn(session, surface, 'first'))
    await tick(30)
    queue.stop('chat-1')
    await tick(250)

    queue.run('chat-1', turnOn(session, surface, 'second'))
    await tick(250)

    expect(usersOf(provider.requests.at(-1)!)).toEqual(['first', 'second'])
    expect(queue.busy('chat-1')).toBe(false)
  })

  it('says there was nothing running when there was nothing to stop', async () => {
    const queue = new TurnQueue()
    expect(queue.stop('chat-1')).toEqual({ stopped: false, dropped: 0 })
  })
})

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
