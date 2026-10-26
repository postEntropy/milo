import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatRequest, Provider, StreamEvent } from '../src/core/providers/types.js'
import type { ServerFrame } from '../src/gateways/web/protocol.js'

const home = mkdtempSync(path.join(os.tmpdir(), 'milo-web-deliver-'))
process.env.MILO_HOME = home

const { WebHub } = await import('../src/gateways/web/hub.js')
const { transcriptOf } = await import('../src/gateways/web/transcript.js')
const { AgentRuntime } = await import('../src/core/runtime.js')
const { createToolRegistry } = await import('../src/core/tools/index.js')

const CHAT = '11111111-2222-3333-4444-555555555555'

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
  const session = await runtime.getSession({ gateway: 'web', chatId: CHAT })
  return session.messages.flatMap((message) =>
    message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])))
}

/** Every delivered-file part of a session's transcript, in order. */
async function attachments(runtime: InstanceType<typeof AgentRuntime>) {
  const session = await runtime.getSession({ gateway: 'web', chatId: CHAT })
  return session.messages.flatMap((message) =>
    message.content.flatMap((part) =>
      part.type === 'file' ? [{ path: part.path, name: part.name, mimeType: part.mimeType }] : []))
}

describe('a handshake', () => {
  it('hands the commands / offers to a client that cannot import them', async () => {
    const hub = new WebHub(build())
    const frames: ServerFrame[] = []
    const client = { send: (frame: ServerFrame) => frames.push(frame) }

    await hub.connect(client, CHAT)

    const ready = frames.find((frame) => frame.type === 'ready')
    const commands = ready?.type === 'ready' ? ready.commands ?? [] : []
    expect(commands.map((command) => command.name)).toContain('help')
    expect(commands.find((command) => command.name === 'mode')?.usage).toBe(' ask|auto|yolo')
  })
})

describe('a routine delivering into a web chat', () => {
  it('writes the message into the chat and hands it to whoever is watching', async () => {
    const runtime = build()
    const hub = new WebHub(runtime)
    const frames: ServerFrame[] = []
    const client = { send: (frame: ServerFrame) => frames.push(frame) }
    const at = new Date(2026, 9, 25, 8, 0).getTime()

    await hub.connect(client, CHAT)
    frames.length = 0 // the handshake; only what follows is the delivery
    await hub.deliver(CHAT, { text: 'nothing moved', routine: { name: 'Daily briefing', at } })

    // The name travels as the delivery's own mark, not as the first line of its
    // text: the surface draws the head, and the answer is the answer.
    expect(frames).toContainEqual({
      type: 'command-result',
      reply: 'nothing moved',
      markdown: 'nothing moved',
      routine: { name: 'Daily briefing', at },
    })
    expect(await transcript(runtime)).toContain('nothing moved')
  })

  it('reads back as the same card, with its own row rather than the answer above it', async () => {
    const runtime = build()
    const hub = new WebHub(runtime)
    const at = new Date(2026, 9, 25, 8, 0).getTime()
    const session = await runtime.getSession({ gateway: 'web', chatId: CHAT })

    // A turn's answer, then the delivery: it arrived on its own, so it must not be
    // grouped into the turn that happened to be above it — the card is its own row.
    await session.appendNotice('the answer the person asked for')
    await hub.deliver(CHAT, { text: 'nothing moved', routine: { name: 'Daily briefing', at } })

    const loaded = await runtime.getSession({ gateway: 'web', chatId: CHAT })
    const read = transcriptOf(loaded.messages, (file) => ({
      id: file.path, name: file.name, mimeType: file.mimeType, size: 0, image: false,
    }))
    expect(read).toHaveLength(2)
    expect(read[1]?.routine).toEqual({ name: 'Daily briefing', at })
    expect(read[1]?.parts).toEqual([{ kind: 'text', text: 'nothing moved' }])
  })

  it('delivers a file alongside the answer and serves it back by id', async () => {
    const runtime = build()
    const hub = new WebHub(runtime)
    const frames: ServerFrame[] = []
    const client = { send: (frame: ServerFrame) => frames.push(frame) }
    const shot = path.join(home, 'shot.png')
    writeFileSync(shot, 'not really a png')

    await hub.connect(client, CHAT)
    frames.length = 0 // the handshake; only what follows is the delivery
    await hub.deliver(CHAT, {
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
    const hub = new WebHub(runtime)

    await hub.deliver(CHAT, { text: 'nightly report' })

    // No client, so nothing was broadcast — the session is the only copy, and
    // that is exactly why the delivery is written before it is announced.
    expect(await transcript(runtime)).toEqual(['nightly report'])
  })

  it('refuses anything that is not a chat id', async () => {
    const hub = new WebHub(build())
    await expect(hub.deliver('not-a-uuid', { text: 'x' })).rejects.toThrow('not a web chat id')
  })
})

describe('a turn in a web chat', () => {
  it('ends with a state frame that says it is over, so the composer lets go', async () => {
    const hub = new WebHub(build())
    const frames: ServerFrame[] = []
    const client = { send: (frame: ServerFrame) => frames.push(frame) }

    await hub.connect(client, CHAT)
    frames.length = 0 // the handshake; only what follows is the turn

    hub.handle(client, { type: 'send', text: 'hello' }, CHAT)
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

  it('ends a slash command with the same freeing state frame', async () => {
    const hub = new WebHub(build())
    const frames: ServerFrame[] = []
    const client = { send: (frame: ServerFrame) => frames.push(frame) }

    await hub.connect(client, CHAT)
    frames.length = 0 // the handshake; only what follows is the command

    hub.handle(client, { type: 'command', text: '/help' }, CHAT)
    expect(await waitFor(() => frames.some((frame) => frame.type === 'command-result'))).toBe(true)
    // A slash command is instantaneous, so it must never report itself as running:
    // the frame that frees the stop button rides the queue's promise, a tick after
    // the reply. Read from inside the command it said `busy: true`, and the page
    // was left holding a stop button with nothing to stop.
    await tick()

    const answered = frames.findIndex((frame) => frame.type === 'command-result')
    const after = frames.slice(answered + 1).filter((frame) => frame.type === 'state')
    expect(after.at(-1)).toEqual({ type: 'state', busy: false, queued: 0 })
    // And the command never announced itself as busy in the first place.
    expect(frames.filter((frame) => frame.type === 'state' && frame.busy)).toEqual([])
  })

  it('delivers a file the live turn sends into the chat it is talking in', async () => {
    const shot = path.join(home, 'shot.png')
    writeFileSync(shot, 'not really a png')
    const runtime = buildWith(new ShotProvider(shot))
    const hub = new WebHub(runtime)
    const frames: ServerFrame[] = []
    const client = { send: (frame: ServerFrame) => frames.push(frame) }

    await hub.connect(client, CHAT)
    frames.length = 0 // the handshake; only what follows is the turn
    hub.handle(client, { type: 'send', text: 'screenshot and send it' }, CHAT)

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

describe('a file a client sends with a message', () => {
  it('runs the staged bytes into the turn the send frame names them on', async () => {
    const runtime = build()
    const hub = new WebHub(runtime)
    const frames: ServerFrame[] = []
    const client = { send: (frame: ServerFrame) => frames.push(frame) }

    // The two halves the phone keeps apart: the bytes go up over HTTP and are staged
    // under an id, and only the id travels on the `send` frame. Nothing else in the
    // protocol can carry a file, so this is the whole of how an attach arrives.
    const uploadId = hub.stageUpload({
      name: 'notes.txt',
      mimeType: 'text/plain',
      data: Buffer.from('the milk is off'),
    })

    await hub.connect(client, CHAT)
    frames.length = 0 // the handshake; only what follows is the message
    hub.handle(client, { type: 'send', text: 'what does this say?', uploadIds: [uploadId] }, CHAT)
    expect(await waitFor(() => frames.some((frame) => frame.type === 'turn-end'))).toBe(true)

    // What the model was handed: the person's words and the file's on the *same*
    // user message. A staged file that reached the turn as nothing would still end
    // the turn, so the reading is of the message and not of the frame.
    const session = await runtime.getSession({ gateway: 'web', chatId: CHAT })
    const said = session.messages
      .filter((message) => message.role === 'user')
      .flatMap((message) => message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])))
      .join('\n')
    expect(said).toContain('what does this say?')
    expect(said).toContain('Attached notes.txt')
    expect(said).toContain('the milk is off')
  })

  it('refuses an id it never staged rather than running a turn with nothing attached', async () => {
    const runtime = build()
    const hub = new WebHub(runtime)
    const frames: ServerFrame[] = []
    const client = { send: (frame: ServerFrame) => frames.push(frame) }

    await hub.connect(client, CHAT)
    frames.length = 0
    hub.handle(client, { type: 'send', text: 'look at this', uploadIds: ['never-staged'] }, CHAT)
    expect(await waitFor(() => frames.some((frame) => frame.type === 'error'))).toBe(true)

    // The refusal is said where the message was sent — and no turn ran, so the
    // person is not left with an answer about a file the daemon never had.
    const session = await runtime.getSession({ gateway: 'web', chatId: CHAT })
    expect(session.messages).toEqual([])
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
