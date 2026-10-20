import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatRequest, Provider, StreamEvent } from '../src/core/providers/types.js'
import type { PermissionPolicy, ToolRegistry } from '../src/core/tools/index.js'

const home = mkdtempSync(path.join(os.tmpdir(), 'milo-web-live-follow-'))
process.env.MILO_HOME = home

const { WebHub } = await import('../src/gateways/web/hub.js')
const { WebSettings } = await import('../src/gateways/web/settings.js')
const { AgentRuntime } = await import('../src/core/runtime.js')
const { DefaultPermissionPolicy } = await import('../src/core/tools/permission.js')
const { PLAN_APPROVAL } = await import('../src/gateways/web/protocol.js')

/** The desktop tab and the phone: two conversations a person may have open at once. */
const DESKTOP = '11111111-2222-3333-4444-555555555555'
const PHONE = '99999999-8888-7777-6666-555555555555'
/** A conversation a session is minted on but never connected to. */
const SPARE = '33333333-4444-5555-6666-777777777777'
/** The conversation a switch is opened on: one the daemon has not seen. */
const SWITCHED = '77777777-6666-5555-4444-333333333333'

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
 * Says one piece and then holds the turn open, so a sibling can arrive, steer or stop
 * while it is provably still running.
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
    yield { type: 'text', delta: 'what it had said so far' }
    this.started.open()
    await until(this.allowed.promise, request.signal)
    yield { type: 'text', delta: 'the rest of the answer' }
    yield { type: 'done', finishReason: 'stop' }
  }
}

/** Asks for a tool the turn may not run on its own, then answers once it is allowed. */
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
const askingRegistry = {
  specs: () => [],
  get: (name: string) => (name === 'shell_command'
    ? { name: 'shell_command', description: 'Runs a command', schema: { type: 'object', properties: {} }, execute: async () => ({ content: 'ok' }) }
    : undefined),
  execute: async () => ({ content: 'ok' }),
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
  status?: string
  busy?: boolean
  sessionId?: string
  turnId?: string
  event?: { type: string; delta?: string; text?: string }
  activeTurn?: { id: string }
  id?: string
  allowed?: boolean
  plan?: boolean
  text?: string
  messages?: Array<{ parts: Array<{ kind: string; text?: string }> }>
}

function client(frames: Frame[]): { send(frame: unknown): void } {
  return { send: (frame: unknown) => void frames.push(frame as Frame) }
}

function transcriptText(frame: Frame | undefined): string[] {
  return (frame?.messages ?? [])
    .flatMap((message) => message.parts.filter((part) => part.kind === 'text'))
    .map((part) => part.text ?? '')
}

/** The `busy` the last state frame carried — what the composer's stop control reads. */
function lastBusy(frames: Frame[]): boolean | undefined {
  return [...frames].reverse().find((frame) => frame.type === 'state')?.busy
}

/**
 * Two conversations bound to one session, the way a desktop tab and a phone that
 * picked the same session up are — the runtime hands both the same `Session`.
 */
async function twoScreens(
  provider: Provider,
  extra?: { permissionPolicy?: PermissionPolicy; registry?: ToolRegistry },
): Promise<{
  runtime: InstanceType<typeof AgentRuntime>
  hub: InstanceType<typeof WebHub>
  desktop: Frame[]
  phone: Frame[]
  at: { send(frame: unknown): void }
  phoneClient: { send(frame: unknown): void }
}> {
  const runtime = build(provider, extra)
  const settings = new WebSettings(runtime, home)
  const hub = new WebHub(runtime)

  // One session, and both conversations resumed onto it. Resuming both (not only the
  // phone) is what keeps the desktop's socket on this session too: a scope the process
  // has not opened is handed a fresh session, which would put the two screens apart.
  const session = await runtime.newSession({ gateway: 'web', chatId: DESKTOP })
  await settings.handle('resume-session', { chatId: DESKTOP, id: session.id })
  await settings.handle('resume-session', { chatId: PHONE, id: session.id })

  const desktop: Frame[] = []
  const phone: Frame[] = []
  const desktopClient = client(desktop)
  const phoneClient = client(phone)
  await hub.connect(desktopClient, DESKTOP)
  await hub.connect(phoneClient, PHONE)
  return { runtime, hub, desktop, phone, at: desktopClient, phoneClient }
}

describe('a turn on a session open in two conversations', () => {
  it('streams to both screens, and says the session is busy on both', async () => {
    const provider = new HeldProvider()
    const { hub, desktop, phone, at } = await twoScreens(provider)

    hub.handle(at, { type: 'send', text: 'go' }, DESKTOP)
    await provider.reached()

    // The turn's own frames reach the sibling, not only the conversation that ran it.
    expect(desktop).toContainEqual(expect.objectContaining({ type: 'turn-start' }))
    expect(phone).toContainEqual(expect.objectContaining({ type: 'turn-start' }))
    expect(phone).toContainEqual(expect.objectContaining({
      type: 'event',
      event: expect.objectContaining({ type: 'text-delta', delta: 'what it had said so far' }),
    }))
    // And its composer is told the session is busy, so the stop and steer controls are
    // there while the desktop's turn runs.
    expect(lastBusy(phone)).toBe(true)

    provider.answer()
    expect(await waitFor(() => desktop.some((frame) => frame.type === 'turn-end'))).toBe(true)
    expect(phone.some((frame) => frame.type === 'turn-end')).toBe(true)
    expect(lastBusy(phone)).toBe(false)
  })

  it('tells both screens the sessions moved when a turn begins and ends', async () => {
    const provider = new HeldProvider()
    const { hub, desktop, phone, at } = await twoScreens(provider)
    const moved = (frames: Frame[]): number => frames.filter((frame) => frame.type === 'sessions-changed').length

    // Beginning: a screen re-reads what shows a session running — and this is the same
    // signal a project's page re-reads its folder on, so it has to be there on both ends.
    hub.handle(at, { type: 'send', text: 'go' }, DESKTOP)
    await provider.reached()
    const began = moved(phone)
    expect(began).toBeGreaterThanOrEqual(1)
    expect(moved(desktop)).toBeGreaterThanOrEqual(1)

    // Ending: said again, because the work has landed by then. Without this one a page
    // would still be drawing the folder as it was before the turn wrote anything.
    provider.answer()
    expect(await waitFor(() => moved(phone) > began)).toBe(true)
    // The conversation that did not run the turn is told too, not only the one that did.
    expect(moved(desktop)).toBeGreaterThan(began)
  })

  it('hands a screen that arrives mid-turn the same live turn', async () => {
    const provider = new HeldProvider()
    const { hub, at } = await twoScreens(provider)

    hub.handle(at, { type: 'send', text: 'go' }, DESKTOP)
    await provider.reached()

    // The phone opens the same session while the turn is in flight.
    const arriving: Frame[] = []
    await hub.connect(client(arriving), PHONE)

    const ready = arriving.find((frame) => frame.type === 'ready')
    expect(ready?.activeTurn?.id).toEqual(expect.any(String))
    // The history stops at the turn's own words; everything after is replayed below.
    expect(transcriptText(ready)).toEqual(['go'])
    expect(arriving).toContainEqual(expect.objectContaining({
      type: 'event',
      turnId: ready?.activeTurn?.id,
      event: expect.objectContaining({ type: 'text-delta', delta: 'what it had said so far' }),
    }))

    // And the turn carries on into that same row.
    provider.answer()
    expect(await waitFor(() => arriving.some((frame) => frame.type === 'turn-end'))).toBe(true)
    expect(arriving).toContainEqual(expect.objectContaining({
      type: 'event',
      event: expect.objectContaining({ type: 'text-delta', delta: 'the rest of the answer' }),
    }))
  })

  it('lets the sibling steer the turn running elsewhere, and both screens see it', async () => {
    const provider = new HeldProvider()
    const { hub, desktop, phone, at, phoneClient } = await twoScreens(provider)

    hub.handle(at, { type: 'send', text: 'go' }, DESKTOP)
    await provider.reached()

    hub.handle(phoneClient, { type: 'send', text: 'use b.txt instead', intent: 'steer' }, PHONE)

    const steered = expect.objectContaining({ type: 'event', event: expect.objectContaining({ type: 'steer', text: 'use b.txt instead' }) })
    expect(desktop).toContainEqual(steered)
    expect(phone).toContainEqual(steered)

    provider.answer()
    expect(await waitFor(() => desktop.some((frame) => frame.type === 'turn-end'))).toBe(true)
  })

  it('turns the session into a plan on both screens, and approves it into a turn', async () => {
    const provider = new HeldProvider()
    const { hub, desktop, phone, at } = await twoScreens(provider)

    hub.handle(at, { type: 'control', action: 'plan', plan: true }, DESKTOP)

    // The switch belongs to the session: the sibling is proposing too.
    const on = expect.objectContaining({ type: 'plan', plan: true })
    expect(desktop).toContainEqual(on)
    expect(phone).toContainEqual(on)

    // A screen that arrives afterwards is handed the state it missed.
    const arriving: Frame[] = []
    await hub.connect(client(arriving), DESKTOP)
    expect(arriving.find((frame) => frame.type === 'ready')?.plan).toBe(true)

    hub.handle(at, { type: 'control', action: 'approve-plan' }, DESKTOP)

    expect(desktop).toContainEqual(expect.objectContaining({ type: 'plan', plan: false }))
    expect(
      await waitFor(() => desktop.some((frame) => frame.type === 'turn-start' && frame.text === PLAN_APPROVAL)),
    ).toBe(true)

    await provider.reached()
    provider.answer()
    expect(await waitFor(() => desktop.some((frame) => frame.type === 'turn-end'))).toBe(true)
  })

  it('lets the sibling stop the turn running elsewhere', async () => {
    const provider = new HeldProvider()
    const { hub, desktop, phone, at, phoneClient } = await twoScreens(provider)

    hub.handle(at, { type: 'send', text: 'go' }, DESKTOP)
    await provider.reached()

    hub.handle(phoneClient, { type: 'control', action: 'stop' }, PHONE)

    expect(await waitFor(() => desktop.some((frame) => frame.type === 'turn-end' && frame.status === 'stopped'))).toBe(true)
    expect(phone.some((frame) => frame.type === 'turn-end' && frame.status === 'stopped')).toBe(true)
  })

  it('lets the sibling answer the permission the turn is waiting on', async () => {
    const provider = new AskingProvider()
    const { hub, desktop, phone, at, phoneClient } = await twoScreens(provider, {
      permissionPolicy: new DefaultPermissionPolicy(),
      registry: askingRegistry,
    })

    hub.handle(at, { type: 'send', text: 'run it' }, DESKTOP)
    expect(await waitFor(() => desktop.some((frame) => frame.type === 'permission'))).toBe(true)
    const asked = desktop.find((frame) => frame.type === 'permission')

    // The question is the session's own, so the phone was told it too.
    expect(phone.find((frame) => frame.type === 'permission')?.id).toBe(asked?.id)

    hub.handle(phoneClient, { type: 'control', action: 'allow', id: asked?.id ?? '' }, PHONE)
    expect(await waitFor(() => phone.some((frame) => frame.type === 'permission-result'))).toBe(true)
    expect(phone.find((frame) => frame.type === 'permission-result')?.allowed).toBe(true)
    expect(await waitFor(() => desktop.some((frame) => frame.type === 'turn-end'))).toBe(true)
  })

  it('shows a file the turn sent, and a finished job’s notice, on every screen of the session', async () => {
    const { hub, desktop, phone } = await twoScreens(new HeldProvider())

    // A file a turn sends: written to the session, and said to every screen on it —
    // the sibling is watching the same session, so it is owed the same message.
    await hub.deliver(DESKTOP, { files: [{ path: '/tmp/shot.png', name: 'shot.png', mimeType: 'image/png' }] })
    const delivered = expect.objectContaining({
      type: 'command-result',
      attachments: expect.arrayContaining([expect.objectContaining({ name: 'shot.png' })]),
    })
    expect(desktop).toContainEqual(delivered)
    expect(phone).toContainEqual(delivered)

    // A finished background job's announcement, which is already in the transcript.
    await hub.showNotice(DESKTOP, { text: 'the job finished' })
    const notice = expect.objectContaining({ type: 'command-result', reply: 'the job finished' })
    expect(desktop).toContainEqual(notice)
    expect(phone).toContainEqual(notice)
  })

  it('lands a switch on a fresh conversation even while a turn runs elsewhere', async () => {
    const provider = new HeldProvider()
    const runtime = build(provider)
    const settings = new WebSettings(runtime, home)
    const hub = new WebHub(runtime)

    // The phone has session A open, with a turn running on it.
    const a = await runtime.newSession({ gateway: 'web', chatId: DESKTOP })
    await settings.handle('resume-session', { chatId: DESKTOP, id: a.id })
    const phone = client([])
    await hub.connect(phone, DESKTOP)
    hub.handle(phone, { type: 'send', text: 'go' }, DESKTOP)
    await provider.reached()

    const b = await runtime.newSession({ gateway: 'web', chatId: SPARE })
    // The switch, as an app does it: B is bound to a conversation the daemon has not
    // seen, before that conversation is connected.
    await settings.handle('resume-session', { chatId: SWITCHED, id: b.id })

    // On the same conversation the daemon will not swap the session out from under the
    // running turn, so the reconnect still replays A — which is exactly why the apps
    // open a session on a conversation id of its own rather than reusing one.
    await settings.handle('resume-session', { chatId: DESKTOP, id: b.id })
    const same: Frame[] = []
    await hub.connect(client(same), DESKTOP)
    expect(same.find((frame) => frame.type === 'ready')?.sessionId).toBe(a.id)

    // A conversation the daemon has not seen: the switch lands, and B is what it replays.
    const fresh: Frame[] = []
    await hub.connect(client(fresh), SWITCHED)
    expect(fresh.find((frame) => frame.type === 'ready')?.sessionId).toBe(b.id)

    provider.answer()
  })
})

/** Two steps that write in the folder, then an answer — the shape of a turn that edits files. */
class WritingProvider implements Provider {
  readonly id = 'writing'
  private calls = 0

  async *stream(_request: ChatRequest): AsyncGenerator<StreamEvent> {
    this.calls += 1
    if (this.calls === 1) {
      yield { type: 'tool-call', id: 'w1', name: 'fake_write', args: { path: 'a.txt' } }
      yield { type: 'tool-call', id: 'w2', name: 'fake_write', args: { path: 'b.txt' } }
      yield { type: 'done', finishReason: 'tool_calls' }
      return
    }
    yield { type: 'text', delta: 'both written' }
    yield { type: 'done', finishReason: 'stop' }
  }
}

/** A step that may have changed something: not read-only, which is all the daemon asks. */
const writingRegistry = {
  specs: () => [],
  get: (name: string) => (name === 'fake_write'
    ? { name: 'fake_write', description: 'Writes a file', schema: { type: 'object', properties: {} }, execute: async () => ({ content: 'wrote' }) }
    : undefined),
  execute: async () => ({ content: 'wrote' }),
} as unknown as ToolRegistry

describe('a turn that may have changed what is on disk', () => {
  it('says so to both screens, once, and holds a burst of steps to the floor', async () => {
    const provider = new WritingProvider()
    const { hub, desktop, phone, at } = await twoScreens(provider, { registry: writingRegistry })
    const wrote = (frames: Frame[]): number =>
      frames.filter((frame) => frame.type === 'work-changed').length

    hub.handle(at, { type: 'send', text: 'write both files' }, DESKTOP)
    expect(await waitFor(() => desktop.some((frame) => frame.type === 'turn-end'))).toBe(true)

    // The screen drawing a folder has something new to read while the turn is still going —
    // and it is the install's news, not one conversation's, so the sibling is told too.
    expect(wrote(desktop)).toBe(1)
    expect(wrote(phone)).toBe(1)
    // Two steps wrote and one frame went out: they were the same second, and each one costs
    // every screen a tree and a diff. The turn's own end is what says the last word.
    expect(desktop.filter((frame) => frame.type === 'sessions-changed').length).toBeGreaterThan(1)
  })
})

describe('a turn on a session no socket asked for', () => {
  it('tells the open screens that the install’s sessions moved', async () => {
    // A gateway or a routine runs its turn straight on the runtime — nobody's socket asked
    // for it. It still has to be announced: a screen watching the Work tab is watching the
    // install, not only the conversation it happens to be sitting in.
    const provider: Provider = {
      id: 'answering',
      async *stream(): AsyncGenerator<StreamEvent> {
        yield { type: 'text', delta: 'done' }
        yield { type: 'done', finishReason: 'stop' }
      },
    }
    const { runtime, desktop, phone } = await twoScreens(provider)

    const elsewhere = await runtime.getSession({ gateway: 'telegram', chatId: 'chat-1' })
    for await (const _event of elsewhere.send('go')) {
      // drain
    }

    expect(await waitFor(() => phone.some((frame) => frame.type === 'sessions-changed'))).toBe(true)
    expect(desktop.some((frame) => frame.type === 'sessions-changed')).toBe(true)
  })
})

async function waitFor(condition: () => boolean | Promise<boolean>): Promise<boolean> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await condition()) return true
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return false
}
