import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatRequest, Provider, StreamEvent } from '../src/core/providers/types.js'
import type { PanelView, ServerFrame } from '../src/gateways/web/protocol.js'

const home = mkdtempSync(path.join(os.tmpdir(), 'milo-web-panel-'))
process.env.MILO_HOME = home

const { WebHub } = await import('../src/gateways/web/hub.js')
const { AgentRuntime } = await import('../src/core/runtime.js')
const { createToolRegistry } = await import('../src/core/tools/index.js')
const { parseClientFrame } = await import('../src/gateways/web/protocol.js')

const CONVERSATION = '11111111-2222-3333-4444-555555555555'

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
})

function build(provider: Provider, browser: unknown = null): InstanceType<typeof AgentRuntime> {
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
    browser: browser as never,
  })
}

/**
 * One `panel` call per step, in the order given, and then the answer: a turn that
 * shows several things. It keeps the system prompt of every request it was handed,
 * so a test can read what the model was told about the panel.
 */
class PanelProvider implements Provider {
  readonly id = 'panel'
  readonly systems: string[] = []
  private step = 0

  constructor(private readonly args: Array<Record<string, unknown>>) {}

  async *stream(request: ChatRequest): AsyncGenerator<StreamEvent> {
    this.systems.push(request.system ?? '')
    const args = this.args[this.step]
    this.step += 1
    if (!args) {
      yield { type: 'text', delta: 'here, look' }
      yield { type: 'done', finishReason: 'stop' }
      return
    }
    yield { type: 'tool-call', id: `c${this.step}`, name: 'panel', args }
    yield { type: 'done', finishReason: 'tool_calls' }
  }
}

function panelFrames(frames: ServerFrame[]): Array<Extract<ServerFrame, { type: 'panel' }>> {
  return frames.filter((frame): frame is Extract<ServerFrame, { type: 'panel' }> => frame.type === 'panel')
}

/** The tabs of the last panel frame, which is the current state of the panel. */
function viewOf(frames: ServerFrame[]): PanelView | null {
  return panelFrames(frames).at(-1)?.panel ?? null
}

/** Opens the chat, runs one turn to completion, and hands back the client watching. */
async function turn(hub: InstanceType<typeof WebHub>, frames: ServerFrame[]): Promise<{ send(frame: ServerFrame): void }> {
  const client = { send: (frame: ServerFrame) => frames.push(frame) }
  await hub.connect(client, CONVERSATION)
  frames.length = 0 // the handshake; only what follows is the turn
  hub.handle(client, { type: 'send', text: 'show me' }, CONVERSATION)
  expect(await waitFor(() => frames.some((frame) => frame.type === 'turn-end'))).toBe(true)
  return client
}

describe('the panel beside a web chat', () => {
  it('shows a file Milo points at, served by id', async () => {
    const report = path.join(home, 'report.md')
    writeFileSync(report, '# the report')
    const hub = new WebHub(build(new PanelProvider([{ path: report }])), home)
    const frames: ServerFrame[] = []

    await turn(hub, frames)

    const tab = viewOf(frames)?.tabs[0]
    expect(tab?.kind).toBe('document')
    expect(tab?.artifact).toMatchObject({ name: 'report.md' })
    // The id is the whole of what the page holds, and it resolves to the file.
    expect(hub.attachment(tab!.artifact!.id)).toEqual({
      path: report,
      name: 'report.md',
      mimeType: 'text/markdown; charset=utf-8',
    })
  })

  it('draws an HTML file as a page, with the type the browser needs to frame it', async () => {
    const page = path.join(home, 'page.html')
    writeFileSync(page, '<h1>hi</h1>')
    const hub = new WebHub(build(new PanelProvider([{ path: page }])), home)
    const frames: ServerFrame[] = []

    await turn(hub, frames)

    const tab = viewOf(frames)?.tabs[0]
    expect(tab?.kind).toBe('page')
    // Served as HTML, not as a download, or the frame would never render.
    expect(hub.attachment(tab!.artifact!.id)?.mimeType).toBe('text/html; charset=utf-8')
  })

  it('shows the browser, and says it has no page when none is running', async () => {
    const hub = new WebHub(build(new PanelProvider([{ browser: true }])), home)
    const frames: ServerFrame[] = []

    await turn(hub, frames)

    expect(viewOf(frames)).toEqual({ tabs: [{ kind: 'browser', url: null, key: 'browser' }], active: 0 })
  })

  it('follows the browser onto a new page, so the header is not left on the old one', async () => {
    const listeners = new Set<(url: string | null) => void>()
    const status = { url: 'https://example.com/' }
    const runtime = build(new PanelProvider([{ browser: true }]), {
      status,
      facts: () => ({ binary: 'chromium', headless: true, profile: 'its own', running: true, port: null }),
      onNavigate: (listener: (url: string | null) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      stopScreencast: () => undefined,
    })
    const hub = new WebHub(runtime, home)
    const frames: ServerFrame[] = []

    await turn(hub, frames)
    expect(viewOf(frames)?.tabs[0]?.url).toBe('https://example.com/')

    status.url = 'https://example.com/deeper'
    for (const listener of listeners) listener(status.url)

    expect(await waitFor(() => viewOf(frames)?.tabs[0]?.url === 'https://example.com/deeper')).toBe(true)
  })

  it('takes the panel down when the model closes it', async () => {
    const hub = new WebHub(build(new PanelProvider([{ action: 'close' }])), home)
    const frames: ServerFrame[] = []

    await turn(hub, frames)

    expect(panelFrames(frames).at(-1)).toEqual({ type: 'panel', panel: null })
  })

  it('gives a second thing its own tab, and puts it in front', async () => {
    const report = path.join(home, 'report.md')
    writeFileSync(report, '# the report')
    const hub = new WebHub(build(new PanelProvider([{ path: report }, { browser: true }])), home)
    const frames: ServerFrame[] = []

    await turn(hub, frames)

    const view = viewOf(frames)
    expect(view?.tabs.map((tab) => tab.kind)).toEqual(['document', 'browser'])
    expect(view?.active).toBe(1)
  })

  it('brings an open tab forward rather than opening a second copy of the same file', async () => {
    const first = path.join(home, 'first.md')
    const second = path.join(home, 'second.md')
    writeFileSync(first, '# one')
    writeFileSync(second, '# two')
    const hub = new WebHub(build(new PanelProvider([{ path: first }, { path: second }, { path: first }])), home)
    const frames: ServerFrame[] = []

    await turn(hub, frames)

    const view = viewOf(frames)
    expect(view?.tabs.map((tab) => tab.title)).toEqual(['first.md', 'second.md'])
    expect(view?.active).toBe(0)
  })

  it('brings a tab forward, and closes one, by the key the person clicked', async () => {
    const first = path.join(home, 'first.md')
    const second = path.join(home, 'second.md')
    writeFileSync(first, '# one')
    writeFileSync(second, '# two')
    const hub = new WebHub(build(new PanelProvider([{ path: first }, { path: second }])), home)
    const frames: ServerFrame[] = []
    const client = await turn(hub, frames)
    const tabs = viewOf(frames)!.tabs

    hub.handle(client, { type: 'panel-activate', key: tabs[0]!.key }, CONVERSATION)
    expect(viewOf(frames)?.active).toBe(0)

    hub.handle(client, { type: 'panel-close', key: tabs[0]!.key }, CONVERSATION)
    expect(viewOf(frames)?.tabs.map((tab) => tab.title)).toEqual(['second.md'])

    hub.handle(client, { type: 'panel-close', key: tabs[1]!.key }, CONVERSATION)
    expect(viewOf(frames)).toBeNull()
  })

  it('ignores a key that is not open', async () => {
    const report = path.join(home, 'report.md')
    writeFileSync(report, '# the report')
    const hub = new WebHub(build(new PanelProvider([{ path: report }])), home)
    const frames: ServerFrame[] = []
    const client = await turn(hub, frames)
    const before = panelFrames(frames).length

    hub.handle(client, { type: 'panel-activate', key: 'not-a-tab' }, CONVERSATION)
    hub.handle(client, { type: 'panel-close', key: 'not-a-tab' }, CONVERSATION)

    expect(panelFrames(frames).length).toBe(before)
    expect(viewOf(frames)?.tabs).toHaveLength(1)
  })

  it('brings the tabs back on a reload, in order and on the same one in front', async () => {
    const report = path.join(home, 'report.md')
    writeFileSync(report, '# the report')
    const runtime = build(new PanelProvider([{ path: report }, { browser: true }]))
    const first: ServerFrame[] = []
    await turn(new WebHub(runtime, home), first)
    expect(viewOf(first)?.tabs).toHaveLength(2)

    // A fresh page (a reload) opens the same conversation: the ready frame carries
    // the tabs again, replayed from the requests the transcript kept.
    const second = new WebHub(runtime, home)
    const opening: ServerFrame[] = []
    await second.connect({ send: (frame) => opening.push(frame) }, CONVERSATION)
    const ready = opening.find((frame): frame is Extract<ServerFrame, { type: 'ready' }> => frame.type === 'ready')
    expect(ready?.panel?.tabs.map((tab) => tab.kind)).toEqual(['document', 'browser'])
    expect(ready?.panel?.active).toBe(1)
  })

  it('reads a close back out of the transcript, leaving no tabs', async () => {
    const report = path.join(home, 'report.md')
    writeFileSync(report, '# the report')
    const runtime = build(new PanelProvider([{ path: report }, { action: 'close' }]))
    const first: ServerFrame[] = []
    await turn(new WebHub(runtime, home), first)
    expect(viewOf(first)).toBeNull()

    const second = new WebHub(runtime, home)
    const opening: ServerFrame[] = []
    await second.connect({ send: (frame) => opening.push(frame) }, CONVERSATION)
    const ready = opening.find((frame): frame is Extract<ServerFrame, { type: 'ready' }> => frame.type === 'ready')
    expect(ready?.panel).toBeNull()
  })

  it('tells the model which tabs are open, and where each one is', async () => {
    const report = path.join(home, 'report.md')
    writeFileSync(report, '# the report')
    const provider = new PanelProvider([{ path: report }, { browser: true }])
    const hub = new WebHub(build(provider), home)
    const frames: ServerFrame[] = []
    const client = await turn(hub, frames)

    // The prompt is built once per send, so it is the *next* turn that is told what
    // the last one opened — what a turn opens itself comes back as its tool result.
    hub.handle(client, { type: 'send', text: 'what is open?' }, CONVERSATION)
    expect(await waitFor(() => frames.filter((frame) => frame.type === 'turn-end').length === 2)).toBe(true)

    const prompt = provider.systems.at(-1) ?? ''
    expect(prompt).toContain('Panel right now: 2 tabs')
    // The file, so it can be read without the person having to say where it is.
    expect(prompt).toContain(`"report.md" (document at \`${report}\`)`)
    expect(prompt).toContain('the browser (in front)')
  })

  it('says the panel is empty when nothing is open', async () => {
    const report = path.join(home, 'report.md')
    writeFileSync(report, '# the report')
    const provider = new PanelProvider([{ path: report }])
    const hub = new WebHub(build(provider), home)
    const frames: ServerFrame[] = []

    await turn(hub, frames)

    // The request that first showed the file was told the panel was empty.
    expect(provider.systems[0]).toContain('Panel right now: nothing open.')
  })

  it('reports a pointer sent into a browser that is not there', async () => {
    const hub = new WebHub(build(new PanelProvider([{ browser: true }])), home)
    const frames: ServerFrame[] = []
    const client = { send: (frame: ServerFrame) => frames.push(frame) }
    await hub.connect(client, CONVERSATION)
    frames.length = 0

    hub.handle(client, { type: 'panel-input', input: { kind: 'click', x: 0.5, y: 0.5 } }, CONVERSATION)

    expect(await waitFor(() => frames.some((frame) => frame.type === 'error'))).toBe(true)
  })
})

describe('the panel-input frame', () => {
  it('accepts a well-formed pointer event', () => {
    expect(parseClientFrame({ type: 'panel-input', input: { kind: 'click', x: 0.2, y: 0.8 } })).not.toBeNull()
    expect(parseClientFrame({ type: 'panel-input', input: { kind: 'scroll', x: 0.5, y: 0.5, deltaY: -120 } })).not.toBeNull()
    expect(parseClientFrame({ type: 'panel-input', input: { kind: 'key', key: 'Enter' } })).not.toBeNull()
    expect(parseClientFrame({ type: 'panel-input', input: { kind: 'key', key: 'a', modifiers: 2 } })).not.toBeNull()
    expect(parseClientFrame({ type: 'panel-input', input: { kind: 'type', text: 'hi' } })).not.toBeNull()
  })

  it('rejects one that is malformed', () => {
    expect(parseClientFrame({ type: 'panel-input', input: { kind: 'click', x: 'left', y: 0.8 } })).toBeNull()
    expect(parseClientFrame({ type: 'panel-input', input: { kind: 'scroll', x: 0.1, y: 0.2 } })).toBeNull()
    expect(parseClientFrame({ type: 'panel-input', input: { kind: 'key', key: '  ' } })).toBeNull()
    expect(parseClientFrame({ type: 'panel-input', input: { kind: 'key', key: 'a', modifiers: 16 } })).toBeNull()
    expect(parseClientFrame({ type: 'panel-input', input: { kind: 'key', key: 'a', modifiers: 1.5 } })).toBeNull()
    expect(parseClientFrame({ type: 'panel-input' })).toBeNull()
  })
})

describe('the panel strip frames', () => {
  it('accepts a key to activate, and one to close', () => {
    expect(parseClientFrame({ type: 'panel-activate', key: 'browser' })).not.toBeNull()
    expect(parseClientFrame({ type: 'panel-close', key: 'abc123' })).not.toBeNull()
  })

  it('rejects one with no key to name', () => {
    expect(parseClientFrame({ type: 'panel-activate' })).toBeNull()
    expect(parseClientFrame({ type: 'panel-activate', key: '' })).toBeNull()
    expect(parseClientFrame({ type: 'panel-close', key: 3 })).toBeNull()
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
