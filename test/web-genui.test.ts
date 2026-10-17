import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stringify } from 'yaml'
import type { ChatRequest, Provider, StreamEvent } from '../src/core/providers/types.js'
import type { ServerFrame, TranscriptPart } from '../src/gateways/web/protocol.js'
import { appendText, withWidget } from '../web/src/chat/parts.js'

const home = mkdtempSync(path.join(os.tmpdir(), 'milo-web-genui-'))
process.env.MILO_HOME = home

const { WebHub } = await import('../src/gateways/web/hub.js')
const { AgentRuntime } = await import('../src/core/runtime.js')
const { createToolRegistry } = await import('../src/core/tools/index.js')

const CONVERSATION = '11111111-2222-3333-4444-555555555555'

/**
 * The configuration this home runs on. Drawing is off unless it is turned on, so this
 * is the switch in Settings — written the way turning it on writes it.
 */
function writeConfig(genui: boolean): void {
  writeFileSync(path.join(home, 'config.yml'), stringify({
    provider: 'test',
    model: 'test-model',
    providers: { test: { baseURL: 'https://x.test/v1', wire: 'openai' } },
    display: { tools: 'full', thinking: 'expanded', genui },
    gateways: {},
    permissions: { mode: 'ask', allow: [], deny: [] },
    classifier: { backend: 'commandcode' },
  }))
}

beforeEach(() => writeConfig(true))

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
})

function build(provider: Provider): InstanceType<typeof AgentRuntime> {
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

/**
 * A model that draws when its prompt taught it to and answers in prose when it did
 * not — which is what a real one does, and what the two chats are compared by. The
 * chunks are deliberately awkward: the fence, the JSON and the closing fence each
 * arriving split, because that is how a real stream delivers them.
 *
 * Every request it was handed is kept, which is how the claim that drawing costs no
 * extra round trip is checked.
 */
class BlockProvider implements Provider {
  readonly id = 'block'
  readonly offered: string[][] = []
  readonly systems: string[] = []

  async *stream(request: ChatRequest): AsyncGenerator<StreamEvent> {
    this.offered.push((request.tools ?? []).map((tool) => tool.name))
    this.systems.push(request.system ?? '')
    const tree = JSON.stringify(widget('Seats', 'seats'))
    const chunks = ['Eight seats', ' comes to $232.\n\n``', '`genui\n', tree.slice(0, 24), tree.slice(24), '\n`', '``\n', '\nTell me if you want it changed.']
    for (const chunk of chunks) yield { type: 'text', delta: chunk }
    yield { type: 'done', finishReason: 'stop' }
  }
}

/**
 * A model that writes two widgets with prose between them: the shape a turn takes
 * when the answer has parts that each want their own piece.
 */
class InterleavedProvider implements Provider {
  readonly id = 'interleaved'

  async *stream(_request: ChatRequest): AsyncGenerator<StreamEvent> {
    const answer = [
      'Here is the plan.',
      '',
      '```genui',
      JSON.stringify(widget('Seats', 'seats')),
      '```',
      '',
      'And what it costs.',
      '',
      '```genui',
      JSON.stringify(widget('Guests', 'guests')),
      '```',
      '',
      'Tell me if you want it changed.',
    ].join('\n')
    for (const chunk of answer.match(/\S+\s*|\s+/g) ?? []) yield { type: 'text', delta: chunk }
    yield { type: 'done', finishReason: 'stop' }
  }
}

/**
 * A model that writes a list one item at a time, pausing between them the way a real one
 * does with its tokens: the shape the streaming widget exists for. What it checks is that
 * the widget is on screen from the first complete item, not from the closing fence.
 */
class GrowingProvider implements Provider {
  readonly id = 'growing'

  async *stream(_request: ChatRequest): AsyncGenerator<StreamEvent> {
    const head = '```genui\n{"title":"Seats","tree":{"kind":"list","items":["one"'
    yield { type: 'text', delta: head }
    await tick(150)
    yield { type: 'text', delta: ',"two"' }
    await tick(150)
    yield { type: 'text', delta: ',"three"]}}\n```\n' }
    yield { type: 'done', finishReason: 'stop' }
  }
}

/**
 * A model that calls `render_ui` — the shape of a session stored while a turn could
 * draw by calling a tool. Nothing offers that tool any more, so the call comes back
 * as an unknown one and the turn carries on: what is being read back is the widget
 * the call carried, which is what such a history has to keep drawing.
 */
class StoredToolCallProvider implements Provider {
  readonly id = 'stored'
  private step = 0

  async *stream(_request: ChatRequest): AsyncGenerator<StreamEvent> {
    if (this.step === 0) {
      this.step += 1
      yield { type: 'text', delta: 'Eight seats comes to $232 a month.' }
      yield { type: 'tool-call', id: 'c1', name: 'render_ui', args: { title: 'Team plan', tree: widget('Seats', 'seats').tree } }
      yield { type: 'done', finishReason: 'tool_calls' }
      return
    }
    yield { type: 'text', delta: 'Anything else?' }
    yield { type: 'done', finishReason: 'stop' }
  }
}

function widget(label: string, id: string): Record<string, unknown> {
  return { tree: { kind: 'box', children: [{ kind: 'slider', id, label, min: 1, max: 10, value: 2 }] } }
}

/** Opens the chat drawing the given way, runs one turn, and hands back the frames. */
async function turn(hub: InstanceType<typeof WebHub>, genui?: boolean): Promise<ServerFrame[]> {
  const frames: ServerFrame[] = []
  const client = { send: (frame: ServerFrame) => frames.push(frame) }
  await hub.connect(client, CONVERSATION, genui)
  frames.length = 0
  hub.handle(client, { type: 'send', text: 'make me a savings calculator' }, CONVERSATION)
  expect(await waitFor(() => frames.some((frame) => frame.type === 'turn-end'))).toBe(true)
  return frames
}

/** Every text delta of a turn, joined: the answer as the person reads it. */
function proseOf(frames: ServerFrame[]): string {
  return frames
    .filter((frame): frame is Extract<ServerFrame, { type: 'event' }> => frame.type === 'event' && frame.event.type === 'text-delta')
    .map((frame) => (frame.event.type === 'text-delta' ? frame.event.delta : ''))
    .join('')
}

/** Opens the conversation again and reads the assistant's turn back, the way a reload does. */
async function reopen(runtime: InstanceType<typeof AgentRuntime>, genui: boolean): Promise<TranscriptPart[]> {
  const opening: ServerFrame[] = []
  await new WebHub(runtime, home).connect({ send: (frame) => opening.push(frame) }, CONVERSATION, genui)
  const ready = opening.find((frame): frame is Extract<ServerFrame, { type: 'ready' }> => frame.type === 'ready')
  return (ready?.messages ?? [])
    .filter((message) => message.role === 'assistant')
    .flatMap((message) => message.parts)
}

function uiFrames(frames: ServerFrame[]): Array<Extract<ServerFrame, { type: 'event' }>> {
  return frames.filter(
    (frame): frame is Extract<ServerFrame, { type: 'event' }> => frame.type === 'event' && frame.event.type === 'ui',
  )
}

/** The widgets that are finished: a draft is the same one still being written. */
function drawnFrames(frames: ServerFrame[]): Array<Extract<ServerFrame, { type: 'event' }>> {
  return uiFrames(frames).filter((frame) => !(frame.event.type === 'ui' && frame.event.draft))
}

describe('a widget the page is drawing while it is written', () => {
  const widget = (title: string, draft: boolean): TranscriptPart => ({
    kind: 'ui',
    ...(draft ? { draft: true } : {}),
    render: { title, tree: { kind: 'list', items: [title] } },
  })
  const named = (part: TranscriptPart): string | null =>
    part.kind === 'ui' ? `${part.render.title}${part.draft ? ' (draft)' : ''}` : null
  const namedAll = (parts: TranscriptPart[]): Array<string | null> => parts.map(named)

  it('grows in one place, instead of stacking up behind itself', () => {
    let parts: TranscriptPart[] = []
    parts = withWidget(parts, widget('Eight seats', true))
    parts = withWidget(parts, widget('Eight seats and a table', true))
    // The block closes: the finished tree is the widget it was becoming.
    parts = withWidget(parts, widget('Eight seats and a table', false))
    expect(namedAll(parts)).toEqual(['Eight seats and a table'])
  })

  it('starts a new widget after a finished one, rather than replacing it', () => {
    const first = withWidget([], widget('Guests', false))
    expect(namedAll(withWidget(first, widget('Seats', true)))).toEqual(['Guests', 'Seats (draft)'])
  })

  it('withdraws the draft when the block turns out to be words', () => {
    // The tree was refused, so the fence hands the block back as its own text: the
    // draft is not a widget, and it does not sit above the words it is not.
    const drawn = withWidget([{ kind: 'text', text: 'Lima.\n\n' }], widget('Eight seats', true))
    const parts = appendText(drawn, '```\n{"tree":')
    expect(parts).toEqual([{ kind: 'text', text: 'Lima.\n\n```\n{"tree":' }])
  })
})

describe('a generated interface on the web chat', () => {
  it('is taught to a client that said it draws one, and to nothing else', async () => {
    const drawing = new BlockProvider()
    await turn(new WebHub(build(drawing), home), true)
    expect(drawing.systems[0]).toContain('```genui')

    // The same model on a chat that did not ask for it: nothing is taught, so the
    // fence it writes anyway stays words.
    const plain = new BlockProvider()
    const frames = await turn(new WebHub(build(plain), home))
    expect(plain.systems[0]).not.toContain('```genui')
    expect(drawnFrames(frames)).toHaveLength(0)
  })

  it('draws nothing on a home that was never configured', async () => {
    // Off is the default: a fresh Milo draws nothing until the switch is turned on.
    rmSync(path.join(home, 'config.yml'), { force: true })
    const provider = new BlockProvider()
    const frames = await turn(new WebHub(build(provider), home), true)
    expect(provider.systems[0]).not.toContain('```genui')
    expect(uiFrames(frames)).toHaveLength(0)
  })

  it('is taught to nobody once the setting is off, however the client asks', async () => {
    // Off is where it starts, and it is the whole point of the switch: a turn carries
    // the teaching in its prompt, so off has to take it out of the prompt and not just
    // off the page.
    writeConfig(false)
    const provider = new BlockProvider()
    const frames = await turn(new WebHub(build(provider), home), true)
    expect(provider.systems[0]).not.toContain('```genui')
    expect(uiFrames(frames)).toHaveLength(0)
  })

  it('sends the tree as an event of its own, so the surface draws it', async () => {
    const frames = await turn(new WebHub(build(new BlockProvider()), home), true)
    const drawn = drawnFrames(frames)
    expect(drawn).toHaveLength(1)
    const event = drawn[0]!.event
    expect(event.type === 'ui' && event.render.tree.kind).toBe('box')
  })

  it('draws the widget as the tree is written, then hands over to the finished one', async () => {
    const frames = await turn(new WebHub(build(new BlockProvider()), home), true)
    const written = uiFrames(frames).map((frame) =>
      frame.event.type === 'ui' && frame.event.draft ? 'draft' : 'finished')
    // The tree lands in pieces, so a widget the schema can read goes out before the
    // fence closes — and the closed block is the widget it was becoming, not a second
    // one appearing beside it.
    expect(written[0]).toBe('draft')
    expect(written.at(-1)).toBe('finished')
    expect(written.filter((kind) => kind === 'finished')).toHaveLength(1)
  })

  it('puts the widget on screen growing, item by item, not whole at the end', async () => {
    const frames = await turn(new WebHub(build(new GrowingProvider()), home), true)
    const drawn = uiFrames(frames).map((frame) => frame.event.type !== 'ui'
      ? ''
      : `${frame.event.draft ? 'draft' : 'finished'}:${frame.event.render.tree.kind === 'list' ? frame.event.render.tree.items.length : -1}`)
    // Each item that lands is drawn at once, and the closing fence hands the whole list
    // over in place of the draft it grew out of. Had this been written to land whole,
    // there would be one line here, and a person would have watched nothing.
    expect(drawn).toEqual(['draft:1', 'draft:2', 'finished:3'])
  })

  it('costs one model request: the widget is written inside the answer', async () => {
    // The invariant the whole design exists for, and the one no rendering test
    // would catch. A tool call ended the request, so drawing by calling needed a
    // second one to carry the answer on; a block rides the answer being written.
    // If this ever reads 2, the round trip is back and the drawing has moved.
    const provider = new BlockProvider()
    const frames = await turn(new WebHub(build(provider), home), true)
    expect(provider.offered).toHaveLength(1)
    expect(drawnFrames(frames)).toHaveLength(1)
  })

  it('never reaches the screen as a fence — only the prose around it does', async () => {
    const frames = await turn(new WebHub(build(new BlockProvider()), home), true)
    const prose = proseOf(frames)
    expect(prose).not.toContain('```genui')
    expect(prose).not.toContain('```')
    expect(prose).toContain('Eight seats comes to $232.')
    expect(prose).toContain('Tell me if you want it changed.')
  })

  it('reads back on a reload as prose and a widget, in the order it was written', async () => {
    const runtime = build(new BlockProvider())
    await turn(new WebHub(runtime, home), true)
    const parts = await reopen(runtime, true)
    expect(parts.map((part) => part.kind)).toEqual(['text', 'ui', 'text'])
    expect(parts.some((part) => part.kind === 'tool')).toBe(false)
  })

  it('interleaves several widgets with the prose, in the order they were written', async () => {
    const runtime = build(new InterleavedProvider())
    const frames = await turn(new WebHub(runtime, home), true)

    // Live: each widget arrives where its block was, between the prose around it.
    // Consecutive deltas are one piece of prose — what is asserted is the order the
    // pieces arrive in, not how many chunks the stream happened to use.
    const kinds = frames
      .filter((frame): frame is Extract<ServerFrame, { type: 'event' }> => frame.type === 'event')
      // Drafts are the same widget earlier, not another piece of the answer.
      .filter((frame) => !(frame.event.type === 'ui' && frame.event.draft))
      .map((frame) => frame.event.type)
      .filter((kind) => kind === 'text-delta' || kind === 'ui')
    const streamed = kinds.filter((kind, at) => kind !== 'text-delta' || kinds[at - 1] !== 'text-delta')
    expect(streamed).toEqual(['text-delta', 'ui', 'text-delta', 'ui', 'text-delta'])

    // And on a reload the stored turn reads back in that same order.
    const stored = (await reopen(runtime, true)).map((part) => part.kind)
    expect(stored).toEqual(['text', 'ui', 'text', 'ui', 'text'])
  })

  it('keeps drawing a widget a stored session drew by calling the tool', async () => {
    // The reader for a session written while the tool existed. Its call is not a
    // line of its own on screen, and the widget it carried still arrives — a
    // history that lost what it showed is the one thing worse than one that never
    // showed it.
    const runtime = build(new StoredToolCallProvider())
    await turn(new WebHub(runtime, home), true)
    const parts = await reopen(runtime, true)
    const drawn = parts.find((part) => part.kind === 'ui')
    expect(drawn?.kind === 'ui' && drawn.render.title).toBe('Team plan')
    expect(parts.some((part) => part.kind === 'tool')).toBe(false)
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
