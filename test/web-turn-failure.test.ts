import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatRequest, Provider, StreamEvent } from '../src/core/providers/types.js'

const home = mkdtempSync(path.join(os.tmpdir(), 'milo-web-turn-failure-'))
process.env.MILO_HOME = home

const { WebHub } = await import('../src/gateways/web/hub.js')
const { AgentRuntime } = await import('../src/core/runtime.js')

const CONVERSATION = '11111111-2222-3333-4444-555555555555'

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
})

/**
 * Answers the first step with a tool call and dies on the step after its result —
 * the shape a turn was left in by hand: transcript ending on a tool result, no
 * answer after it, and nothing on the screen to say why.
 */
class DiesAfterToolProvider implements Provider {
  readonly id = 'dies-after-tool'
  private calls = 0

  async *stream(_request: ChatRequest): AsyncGenerator<StreamEvent> {
    this.calls += 1
    if (this.calls === 1) {
      yield { type: 'tool-call', id: 'c1', name: 'echo', args: {} }
      yield { type: 'done', finishReason: 'tool_calls' }
      return
    }
    throw new Error('the model call broke')
  }
}

function build(provider: Provider): InstanceType<typeof AgentRuntime> {
  return new AgentRuntime({
    provider,
    model: 'test-model',
    system: '',
    // Enough of a registry for the one call the provider makes: the loop looks
    // the tool up to decide whether calls may overlap, then runs it.
    registry: {
      specs: () => [],
      get: () => undefined,
      execute: async () => ({ content: 'ok' }),
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
  turnId?: string
  event?: { type: string; message?: string }
  messages?: Array<{ parts: Array<{ kind: string; text?: string }> }>
}

/** A client that keeps every frame, so what the page would draw can be read back. */
function client(frames: Frame[]): { send(frame: unknown): void } {
  return { send: (frame: unknown) => void frames.push(frame as Frame) }
}

describe('a web turn that fails', () => {
  it('says so on the turn, where the failure happened, and never as a notice', async () => {
    const runtime = build(new DiesAfterToolProvider())
    const hub = new WebHub(runtime)
    const frames: Frame[] = []
    const page = client(frames)

    await hub.connect(page, CONVERSATION)
    hub.handle(page, { type: 'send', text: 'do it' }, CONVERSATION)
    await waitFor(() => frames.some((frame) => frame.type === 'turn-end'))

    const failure = frames.find((frame) => frame.type === 'event' && frame.event?.type === 'error')
    expect(failure?.event?.message).toBe('the model call broke')
    // Attached to the turn, so it is drawn on the message it belongs to...
    expect(failure?.turnId).toBeTruthy()
    // ...and not as a bare error frame, which is the transient notice that
    // disappears — the way a dead turn ends up explained by nothing at all.
    expect(frames.some((frame) => frame.type === 'error')).toBe(false)

    // The trace is the one seen by hand: the turn stopped on its last tool result.
    const session = await runtime.getSession({ gateway: 'web', conversationId: CONVERSATION })
    expect(session.messages.at(-1)?.role).toBe('tool')
  })

  it('writes the reason down, so the conversation shows it again when reopened', async () => {
    const runtime = build(new DiesAfterToolProvider())
    // The failure is thrown by the hub itself, outside the turn — the path that
    // used to reach the person only as a notice that cleared itself.
    const realGetSession = runtime.getSession.bind(runtime)
    let failNow = true
    runtime.getSession = (async (scope: never) => {
      if (failNow) {
        failNow = false
        throw new Error('the session store is gone')
      }
      return realGetSession(scope)
    }) as typeof runtime.getSession

    const hub = new WebHub(runtime)
    const frames: Frame[] = []
    const page = client(frames)

    await hub.connect(page, CONVERSATION)
    hub.handle(page, { type: 'send', text: 'do it' }, CONVERSATION)
    await waitFor(() => frames.some((frame) => frame.type === 'turn-end'))
    expect(frames.find((frame) => frame.type === 'event' && frame.event?.type === 'error')?.event?.message)
      .toBe('the session store is gone')

    const reopened: Frame[] = []
    await hub.connect(client(reopened), CONVERSATION)
    const text = (reopened.find((frame) => frame.type === 'ready')?.messages ?? [])
      .flatMap((message) => message.parts)
      .filter((part) => part.kind === 'text')
      .map((part) => part.text ?? '')
      .join('\n')
    expect(text).toContain('the turn failed: the session store is gone')
  })
})

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('the turn never ended')
}
