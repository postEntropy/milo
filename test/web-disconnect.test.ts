import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatRequest, Provider, StreamEvent } from '../src/core/providers/types.js'
import type { PermissionPolicy, ToolRegistry } from '../src/core/tools/index.js'

const home = mkdtempSync(path.join(os.tmpdir(), 'milo-web-disconnect-'))
process.env.MILO_HOME = home

const { WebHub } = await import('../src/gateways/web/hub.js')
const { AgentRuntime } = await import('../src/core/runtime.js')
const { DefaultPermissionPolicy } = await import('../src/core/tools/permission.js')

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
    // One piece lands before the hold: a client that arrives while the answer is
    // being held has something the turn has already said, and the session on disk
    // does not carry it yet — the step in flight is written only when it ends.
    yield { type: 'text', delta: 'what it had said so far' }
    this.started.open()
    await until(this.allowed.promise, request.signal)
    yield { type: 'text', delta: 'the answer arrived with nobody watching' }
    yield { type: 'done', finishReason: 'stop' }
  }
}

/** The held answer, released when the test says so — or rejected if the turn is stopped. */
function until(open: Promise<void>, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
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
    void open.then(() => resolve())
  })
}

/**
 * A turn of two steps: the first is over — it said its words, asked for a read and
 * had it — and the second is held open, so a client can arrive while that step is the
 * one in flight. What it must not be handed is the first step again.
 */
class StepwiseProvider implements Provider {
  readonly id = 'stepwise'
  private calls = 0
  private readonly started = gate()
  private readonly allowed = gate()

  /** Resolves once the second step is running, with the first one behind it. */
  reached(): Promise<void> {
    return this.started.promise
  }

  /** Lets the held second step finish. */
  answer(): void {
    this.allowed.open()
  }

  async *stream(request: ChatRequest): AsyncGenerator<StreamEvent> {
    this.calls += 1
    if (this.calls === 1) {
      yield { type: 'text', delta: 'the step that landed' }
      yield { type: 'tool-call', id: 'c1', name: 'read_file', args: { path: 'a.txt' } }
      yield { type: 'done', finishReason: 'tool_calls' }
      return
    }
    yield { type: 'text', delta: 'the step still in flight' }
    this.started.open()
    await until(this.allowed.promise, request.signal)
    yield { type: 'text', delta: ', and its end' }
    yield { type: 'done', finishReason: 'stop' }
  }
}

/**
 * Asks for a tool the turn may not run on its own, then answers once it is allowed.
 * The permission policy is the real one in its default ask mode, so the question the
 * turn puts to the surface is the one it puts in production.
 */
class AskingProvider implements Provider {
  readonly id = 'asks'
  private calls = 0

  async *stream(_request: ChatRequest): AsyncGenerator<StreamEvent> {
    this.calls += 1
    if (this.calls === 1) {
      yield { type: 'tool-call', id: 'c1', name: 'shell_command', args: { command: 'ls' } }
      yield { type: 'done', finishReason: 'tool_calls' }
      return
    }
    yield { type: 'text', delta: 'it ran' }
    yield { type: 'done', finishReason: 'stop' }
  }
}

/** A tool that is not read-only, so a turn has to ask before it runs one. */
const askingTool = {
  name: 'shell_command',
  description: 'Runs a command',
  schema: { type: 'object', properties: {} },
  execute: async () => ({ content: 'ok' }),
}

const askingRegistry = {
  specs: () => [],
  get: (name: string) => (name === 'shell_command' ? askingTool : undefined),
  execute: async () => ({ content: 'ok' }),
} as unknown as ToolRegistry

/** A tool a step may run on its own, so the step after it can be the one in flight. */
const readingTool = {
  name: 'read_file',
  description: 'Reads a file',
  readOnly: true,
  schema: { type: 'object', properties: {} },
  execute: async () => ({ content: 'the file' }),
}

const readingRegistry = {
  specs: () => [],
  get: (name: string) => (name === 'read_file' ? readingTool : undefined),
  execute: async () => ({ content: 'the file' }),
} as unknown as ToolRegistry

function build(
  provider: Provider,
  extra?: { permissionPolicy?: PermissionPolicy; registry?: ToolRegistry },
): InstanceType<typeof AgentRuntime> {
  return new AgentRuntime({
    provider,
    model: 'test-model',
    system: '',
    registry: (extra?.registry ?? { specs: () => [] }) as never,
    ...(extra?.permissionPolicy ? { permissionPolicy: extra.permissionPolicy } : {}),
    memory: {
      remember: async () => undefined,
      recall: async () => [],
      list: async () => [],
      forget: async () => false,
    } as never,
    cwd: home,
  })
}

/** The frames a client would draw from, as much of each as these tests read. */
interface Frame {
  type: string
  turnId?: string
  event?: { type: string; delta?: string }
  activeTurn?: { id: string }
  id?: string
  expiresAt?: number
  allowed?: boolean
  messages?: Array<{ parts: Array<{ kind: string; text?: string }> }>
}

/** A client that keeps every frame, so what the surface would draw can be read back. */
function client(frames: Frame[]): { send(frame: unknown): void } {
  return { send: (frame: unknown) => void frames.push(frame as Frame) }
}

/** Every text part of a `ready`'s transcript, in order. */
function transcriptText(frame: Frame | undefined): string[] {
  return (frame?.messages ?? [])
    .flatMap((message) => message.parts.filter((part) => part.kind === 'text'))
    .map((part) => part.text ?? '')
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
    const hub = new WebHub(runtime)
    const frames: Frame[] = []
    const page = client(frames)

    await hub.connect(page, CONVERSATION)
    hub.handle(page, { type: 'send', text: 'still there?' }, CONVERSATION)
    await provider.reached()

    // A reload, a closed tab and a phone locking all close this socket exactly
    // the way a closing tab does, and nothing on the wire tells them apart — so
    // the turn is not the socket's to end. Only the stop control ends one.
    hub.disconnect(page)
    provider.answer()

    // The turn's words are its deltas run together, so the answer is read off the
    // transcript as the one piece of prose it is.
    expect(
      await waitFor(async () => (await transcript(runtime)).join('').includes('the answer arrived with nobody watching')),
    ).toBe(true)
  })
})

describe('a client arriving in the middle of a turn', () => {
  it('is handed the turn that is running, with everything it has already said', async () => {
    const provider = new HeldProvider()
    const runtime = build(provider)
    const hub = new WebHub(runtime)

    const watching: Frame[] = []
    const first = client(watching)
    await hub.connect(first, CONVERSATION)
    hub.handle(first, { type: 'send', text: 'are you still there?' }, CONVERSATION)
    await provider.reached()
    // The turn is provably in flight: the model call is held open, and the piece it
    // had already said went out to a client that is now gone.
    hub.disconnect(first)

    const arriving: Frame[] = []
    await hub.connect(client(arriving), CONVERSATION)

    // The words are in neither half of what a client arriving now is otherwise
    // given: the session on disk is written a step at a time and this step has not
    // finished, and the frame that carried them went out before this client existed.
    // The ready names the turn they belong to, and they are replayed under that same
    // id — which is what lets the row opened from it draw the answer as it stands.
    const ready = arriving.find((frame) => frame.type === 'ready')
    expect(ready?.activeTurn?.id).toEqual(expect.any(String))
    expect(transcriptText(ready)).toEqual(['are you still there?'])
    expect(arriving).toContainEqual(expect.objectContaining({
      type: 'event',
      turnId: ready?.activeTurn?.id,
      event: expect.objectContaining({ type: 'text-delta', delta: 'what it had said so far' }),
    }))

    // And the turn carries on into that same row.
    provider.answer()
    await waitFor(() => arriving.some((frame) => frame.type === 'turn-end'))
    expect(arriving).toContainEqual(expect.objectContaining({
      type: 'event',
      turnId: ready?.activeTurn?.id,
      event: expect.objectContaining({ type: 'text-delta', delta: 'the answer arrived with nobody watching' }),
    }))
  })
})

describe('the step behind the one in flight', () => {
  it('is not said again to the client that arrives', async () => {
    const provider = new StepwiseProvider()
    const runtime = build(provider, {
      permissionPolicy: new DefaultPermissionPolicy(),
      registry: readingRegistry,
    })
    const hub = new WebHub(runtime)

    const gone: Frame[] = []
    const first = client(gone)
    await hub.connect(first, CONVERSATION)
    hub.handle(first, { type: 'send', text: 'go' }, CONVERSATION)
    // The first step is over — its words went into the session and its read ran — and
    // the second one is the step in flight.
    await provider.reached()
    hub.disconnect(first)

    const arriving: Frame[] = []
    await hub.connect(client(arriving), CONVERSATION)

    const ready = arriving.find((frame) => frame.type === 'ready')
    expect(ready?.activeTurn?.id).toEqual(expect.any(String))
    // The step that landed is history, and the transcript handed over draws it.
    expect(transcriptText(ready)).toContain('the step that landed')

    // So its frames must not come with it: both together is the same words on the
    // screen twice — the beginning of the answer, said again.
    expect(arriving).not.toContainEqual(expect.objectContaining({
      type: 'event',
      event: expect.objectContaining({ delta: 'the step that landed' }),
    }))
    // The step in flight exists nowhere else, so it is replayed.
    expect(arriving).toContainEqual(expect.objectContaining({
      type: 'event',
      turnId: ready?.activeTurn?.id,
      event: expect.objectContaining({ delta: 'the step still in flight' }),
    }))

    provider.answer()
    expect(await waitFor(() => arriving.some((frame) => frame.type === 'turn-end'))).toBe(true)
  })
})

describe('a question the turn is waiting on', () => {
  it('is put again to the client that arrives after it', async () => {
    const provider = new AskingProvider()
    const runtime = build(provider, {
      permissionPolicy: new DefaultPermissionPolicy(),
      registry: askingRegistry,
    })
    const hub = new WebHub(runtime)

    const gone: Frame[] = []
    const first = client(gone)
    await hub.connect(first, CONVERSATION)
    hub.handle(first, { type: 'send', text: 'run it' }, CONVERSATION)
    await waitFor(() => gone.some((frame) => frame.type === 'permission'))
    const asked = gone.find((frame) => frame.type === 'permission')

    // The turn is parked on the question, and the client that was asked is gone. Five
    // minutes of nobody able to answer is a denial, which is what this used to be.
    hub.disconnect(first)

    const arriving: Frame[] = []
    const second = client(arriving)
    await hub.connect(second, CONVERSATION)
    const again = arriving.find((frame) => frame.type === 'permission')
    expect(again?.id).toBe(asked?.id)
    // The deadline is the daemon's, so the countdown this client draws is the one
    // actually running rather than a fresh five minutes.
    expect(again?.expiresAt).toBe(asked?.expiresAt)

    // And the answer it gives is the one the turn is waiting for.
    hub.handle(second, { type: 'control', action: 'allow', id: again?.id ?? '' }, CONVERSATION)
    await waitFor(() => arriving.some((frame) => frame.type === 'permission-result'))
    expect(arriving.find((frame) => frame.type === 'permission-result')?.allowed).toBe(true)
    expect(await waitFor(() => arriving.some((frame) => frame.type === 'turn-end'))).toBe(true)
  })
})

async function waitFor(condition: () => boolean | Promise<boolean>): Promise<boolean> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await condition()) return true
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return false
}
