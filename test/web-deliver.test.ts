import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ServerFrame } from '../src/gateways/web/protocol.js'

const home = mkdtempSync(path.join(os.tmpdir(), 'milo-web-deliver-'))
process.env.MILO_HOME = home

const { WebHub } = await import('../src/gateways/web/hub.js')
const { AgentRuntime } = await import('../src/core/runtime.js')

const CONVERSATION = '11111111-2222-3333-4444-555555555555'

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
})

function build(): InstanceType<typeof AgentRuntime> {
  return new AgentRuntime({
    provider: { id: 'test', stream: async function* () {} },
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

/** Every text part of a session's transcript, in order. */
async function transcript(runtime: InstanceType<typeof AgentRuntime>): Promise<string[]> {
  const session = await runtime.getSession({ gateway: 'web', conversationId: CONVERSATION })
  return session.messages.flatMap((message) =>
    message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])))
}

describe('a routine delivering into a web chat', () => {
  it('writes the message into the conversation and hands it to whoever is watching', async () => {
    const runtime = build()
    const hub = new WebHub(runtime, { provider: 'test', model: 'test-model' })
    const frames: ServerFrame[] = []
    const client = { send: (frame: ServerFrame) => frames.push(frame) }

    await hub.connect(client, CONVERSATION)
    frames.length = 0 // the handshake; only what follows is the delivery
    await hub.deliver(CONVERSATION, 'daily briefing\n\nnothing moved')

    expect(frames).toContainEqual({
      type: 'command-result',
      reply: 'daily briefing\n\nnothing moved',
      markdown: 'daily briefing\n\nnothing moved',
    })
    expect(await transcript(runtime)).toContain('daily briefing\n\nnothing moved')
  })

  it('keeps it for a chat nobody is watching', async () => {
    const runtime = build()
    const hub = new WebHub(runtime, { provider: 'test', model: 'test-model' })

    await hub.deliver(CONVERSATION, 'nightly report')

    // No client, so nothing was broadcast — the session is the only copy, and
    // that is exactly why the delivery is written before it is announced.
    expect(await transcript(runtime)).toEqual(['nightly report'])
  })

  it('refuses anything that is not a conversation id', async () => {
    const hub = new WebHub(build(), { provider: 'test', model: 'test-model' })
    await expect(hub.deliver('not-a-uuid', 'x')).rejects.toThrow('not a web conversation id')
  })
})

describe('a turn in a web conversation', () => {
  it('ends with a state frame that says it is over, so the composer lets go', async () => {
    const hub = new WebHub(build(), { provider: 'test', model: 'test-model' })
    const frames: ServerFrame[] = []
    const client = { send: (frame: ServerFrame) => frames.push(frame) }

    await hub.connect(client, CONVERSATION)
    frames.length = 0 // the handshake; only what follows is the turn

    hub.handle(client, { type: 'send', text: 'hello' }, CONVERSATION)
    expect(await waitFor(() => frames.some((frame) => frame.type === 'turn-end'))).toBe(true)
    // The frame that frees the button is sent on the queue's promise, which is a
    // tick after `turn-end`. Without that tick the last state frame on the wire
    // said `busy: true`, and the page held a stop button for a finished turn.
    await tick()

    // Only what arrives *after* the turn: a test that read the last state frame of
    // the whole exchange would pass on no frame at all, by falling back to the one
    // sent before the turn began.
    const ended = frames.findIndex((frame) => frame.type === 'turn-end')
    const after = frames.slice(ended + 1).filter((frame) => frame.type === 'state')
    expect(after.at(-1)).toEqual({ type: 'state', busy: false, queued: 0 })
  })
})

const tick = (ms = 10): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(condition: () => boolean): Promise<boolean> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return true
    await tick(5)
  }
  return false
}
