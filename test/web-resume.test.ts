import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { proseOf, type ServerFrame } from '../src/gateways/web/protocol.js'
import type { ProjectLookup } from '../src/core/projects.js'


const home = mkdtempSync(path.join(os.tmpdir(), 'milo-web-resume-'))
process.env.MILO_HOME = home

const { WebHub } = await import('../src/gateways/web/hub.js')
const { WebSettings } = await import('../src/gateways/web/settings.js')
const { AgentRuntime } = await import('../src/core/runtime.js')
const { findPreset } = await import('../src/core/config/presets.js')
const { placeProject } = await import('../src/core/projects.js')

const PAST_CONVERSATION = '11111111-2222-3333-4444-555555555555'
const NEXT_CONVERSATION = '99999999-8888-7777-6666-555555555555'

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
})

function build(providerId = 'test', project?: ProjectLookup): InstanceType<typeof AgentRuntime> {
  return new AgentRuntime({
    provider: { id: providerId, stream: async function* () {} },
    // The fallback bootstrap wires: a preset's own name, else the raw id.
    providerSwitch: { use: () => true, name: (id) => findPreset(id)?.name ?? id },
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
    ...(project ? { project } : {}),
  })
}

describe('opening a past session in the web', () => {
  /**
   * The page does two things in order: it asks the API to resume the session into
   * a conversation id it has just minted, and then it reconnects the socket on
   * that id. The socket's handshake is what fills the chat, so a resume the
   * handshake does not see is a click that opens nothing.
   */
  it('hands the socket the session that was resumed, not a fresh one', async () => {
    const runtime = build()
    const settings = new WebSettings(runtime, home)
    const hub = new WebHub(runtime)

    const past = await runtime.newSession({ gateway: 'web', conversationId: PAST_CONVERSATION })
    await past.appendNotice('the thing we talked about')

    await settings.handle('resume-session', { conversationId: NEXT_CONVERSATION, id: past.id })
    const frames: ServerFrame[] = []
    await hub.connect({ send: (frame) => frames.push(frame) }, NEXT_CONVERSATION)

    const ready = frames.find((frame): frame is Extract<ServerFrame, { type: 'ready' }> => frame.type === 'ready')
    expect(ready?.sessionId).toBe(past.id)
    expect(ready?.messages.map(proseOf)).toContain('the thing we talked about')
  })
})

describe('the web handshake', () => {
  it('names the provider it runs on, and keeps the id when it is not a known preset', async () => {
    const known = new WebHub(build('commandcode'))
    const frames: ServerFrame[] = []
    await known.connect({ send: (frame) => frames.push(frame) }, NEXT_CONVERSATION)
    expect(readyOf(frames)?.providerName).toBe('Command Code')

    const unknown = new WebHub(build('not-a-preset'))
    const other: ServerFrame[] = []
    await unknown.connect({ send: (frame) => other.push(frame) }, PAST_CONVERSATION)
    expect(readyOf(other)?.providerName).toBe('not-a-preset')
  })
})

function readyOf(frames: ServerFrame[]): Extract<ServerFrame, { type: 'ready' }> | undefined {
  return frames.find((frame): frame is Extract<ServerFrame, { type: 'ready' }> => frame.type === 'ready')
}

describe('what the ready frame says about the session', () => {
  const where = path.join(home, 'milo')

  /** A project in the install's own list, the way the Work screen puts one there. */
  const withProject = async (settings: InstanceType<typeof WebSettings>): Promise<{ id: string; name: string; path: string }> => {
    mkdirSync(where, { recursive: true })
    const added = (await settings.handle('project-action', { action: 'add', path: where, name: 'Milo' })) as {
      projects: Array<{ id: string; name: string; path: string }>
    }
    return added.projects[0]!
  }

  it('names the project, on a session that has not said anything yet', async () => {
    const runtime = build('test', placeProject)
    const settings = new WebSettings(runtime, home)
    const project = await withProject(settings)
    // The Work screen's own move: a session started in a project. The socket opens the
    // conversation right after, and the project is said there — before a word is written.
    await settings.handle('new-session', { conversationId: PAST_CONVERSATION, project: project.id })

    const frames: ServerFrame[] = []
    await new WebHub(runtime).connect({ send: (frame) => frames.push(frame) }, PAST_CONVERSATION)

    expect(readyOf(frames)?.messages).toEqual([])
    expect(readyOf(frames)?.project).toEqual(project)
  })

  it('keeps the name, and says why when the folder cannot be worked in', async () => {
    const runtime = build('test', placeProject)
    const settings = new WebSettings(runtime, home)
    const project = await withProject(settings)
    rmSync(where, { recursive: true })
    await settings.handle('new-session', { conversationId: PAST_CONVERSATION, project: project.id })

    const frames: ServerFrame[] = []
    await new WebHub(runtime).connect({ send: (frame) => frames.push(frame) }, PAST_CONVERSATION)

    const said = readyOf(frames)?.project
    expect(said?.name).toBe('Milo')
    expect(said?.error).toContain('is gone')
  })

  it('says nothing about a project on an ordinary chat', async () => {
    const runtime = build()
    await runtime.newSession({ gateway: 'web', conversationId: PAST_CONVERSATION })

    const frames: ServerFrame[] = []
    await new WebHub(runtime).connect({ send: (frame) => frames.push(frame) }, PAST_CONVERSATION)

    expect(readyOf(frames)).not.toHaveProperty('project')
  })
})
