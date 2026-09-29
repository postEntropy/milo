import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatRequest, Provider, StreamEvent } from '../src/core/providers/types.js'
import type { ServerFrame } from '../src/gateways/web/protocol.js'

const home = mkdtempSync(path.join(os.tmpdir(), 'milo-web-deliver-'))
process.env.MILO_HOME = home

const { WebHub } = await import('../src/gateways/web/hub.js')
const { AgentRuntime } = await import('../src/core/runtime.js')
const { createToolRegistry } = await import('../src/core/tools/index.js')

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

/** Emits one `send_file` call and then the answer: a turn that sends a file. */
class ShotProvider implements Provider {
  readonly id = 'shot'
  private calls = 0

  constructor(private readonly file: string) {}

  async *stream(_request: ChatRequest): AsyncGenerator<StreamEvent> {
    this.calls += 1
    if (this.calls === 1) {
      yield { type: 'tool-call', id: 'c1', name: 'send_file', args: { path: this.file, caption: 'the screen' } }
      yield { type: 'done', finishReason: 'tool_calls' }
      return
    }
    yield { type: 'text', delta: 'sent' }
    yield { type: 'done', finishReason: 'stop' }
  }
}

/** A runtime whose turn runs a real tool registry, so `send_file` reaches the session. */
function buildWith(provider: Provider): InstanceType<typeof AgentRuntime> {
  return new AgentRuntime({
    provider,
    model: 'test-model',
    system: '',
    registry: createToolRegistry(),
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

/** Every delivered-file part of a session's transcript, in order. */
async function attachments(runtime: InstanceType<typeof AgentRuntime>) {
  const session = await runtime.getSession({ gateway: 'web', conversationId: CONVERSATION })
  return session.messages.flatMap((message) =>
    message.content.flatMap((part) =>
      part.type === 'file' ? [{ path: part.path, name: part.name, mimeType: part.mimeType }] : []))
}

describe('a routine delivering into a web chat', () => {
  it('writes the message into the conversation and hands it to whoever is watching', async () => {
    const runtime = build()
    const hub = new WebHub(runtime, { provider: 'test', model: 'test-model' })
    const frames: ServerFrame[] = []
    const client = { send: (frame: ServerFrame) => frames.push(frame) }

    await hub.connect(client, CONVERSATION)
    frames.length = 0 // the handshake; only what follows is the delivery
    await hub.deliver(CONVERSATION, { text: 'daily briefing\n\nnothing moved' })

    expect(frames).toContainEqual({
      type: 'command-result',
      reply: 'daily briefing\n\nnothing moved',
      markdown: 'daily briefing\n\nnothing moved',
    })
    expect(await transcript(runtime)).toContain('daily briefing\n\nnothing moved')
  })

  it('delivers a file alongside the answer and serves it back by id', async () => {
    const runtime = build()
    const hub = new WebHub(runtime, { provider: 'test', model: 'test-model' })
    const frames: ServerFrame[] = []
    const client = { send: (frame: ServerFrame) => frames.push(frame) }
    const shot = path.join(home, 'shot.png')
    writeFileSync(shot, 'not really a png')

    await hub.connect(client, CONVERSATION)
    frames.length = 0 // the handshake; only what follows is the delivery
    await hub.deliver(CONVERSATION, {
      text: 'the screen',
      files: [{ path: shot, name: 'shot.png', mimeType: 'image/png' }],
    })

    const frame = frames.find(
      (entry): entry is Extract<ServerFrame, { type: 'command-result' }> => entry.type === 'command-result',
    )
    expect(frame?.attachments?.[0]).toMatchObject({ name: 'shot.png', mimeType: 'image/png', image: true })
    // The id is the only name the browser holds, and it resolves back to exactly
    // the file that was delivered — nothing else on disk can be asked for.
    expect(hub.attachment(frame!.attachments![0]!.id)).toEqual({ path: shot, name: 'shot.png', mimeType: 'image/png' })
    expect(await attachments(runtime)).toEqual([{ path: shot, name: 'shot.png', mimeType: 'image/png' }])
  })

  it('keeps it for a chat nobody is watching', async () => {
    const runtime = build()
    const hub = new WebHub(runtime, { provider: 'test', model: 'test-model' })

    await hub.deliver(CONVERSATION, { text: 'nightly report' })

    // No client, so nothing was broadcast — the session is the only copy, and
    // that is exactly why the delivery is written before it is announced.
    expect(await transcript(runtime)).toEqual(['nightly report'])
  })

  it('refuses anything that is not a conversation id', async () => {
    const hub = new WebHub(build(), { provider: 'test', model: 'test-model' })
    await expect(hub.deliver('not-a-uuid', { text: 'x' })).rejects.toThrow('not a web conversation id')
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

  it('delivers a file the live turn sends into the chat it is talking in', async () => {
    const shot = path.join(home, 'shot.png')
    writeFileSync(shot, 'not really a png')
    const runtime = buildWith(new ShotProvider(shot))
    const hub = new WebHub(runtime, { provider: 'test', model: 'test-model' })
    const frames: ServerFrame[] = []
    const client = { send: (frame: ServerFrame) => frames.push(frame) }

    await hub.connect(client, CONVERSATION)
    frames.length = 0 // the handshake; only what follows is the turn
    hub.handle(client, { type: 'send', text: 'screenshot and send it' }, CONVERSATION)

    const delivered = (): Extract<ServerFrame, { type: 'command-result' }> | undefined =>
      frames.find(
        (frame): frame is Extract<ServerFrame, { type: 'command-result' }> =>
          frame.type === 'command-result' && (frame.attachments?.length ?? 0) > 0,
      )
    expect(await waitFor(() => delivered() !== undefined)).toBe(true)

    const frame = delivered()!
    expect(frame.attachments?.[0]).toMatchObject({ name: 'shot.png', mimeType: 'image/png', image: true })
    // The id is the only name the browser holds, and it resolves to the file.
    expect(hub.attachment(frame.attachments![0]!.id)).toEqual({ path: shot, name: 'shot.png', mimeType: 'image/png' })
    // Kept in the transcript, so a reload serves the same picture again.
    expect(await attachments(runtime)).toEqual([{ path: shot, name: 'shot.png', mimeType: 'image/png' }])
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
