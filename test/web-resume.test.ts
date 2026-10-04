import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ServerFrame } from '../src/gateways/web/protocol.js'

const home = mkdtempSync(path.join(os.tmpdir(), 'milo-web-resume-'))
process.env.MILO_HOME = home

const { WebHub } = await import('../src/gateways/web/hub.js')
const { WebSettings } = await import('../src/gateways/web/settings.js')
const { AgentRuntime } = await import('../src/core/runtime.js')
const { findPreset } = await import('../src/core/config/presets.js')

const PAST_CONVERSATION = '11111111-2222-3333-4444-555555555555'
const NEXT_CONVERSATION = '99999999-8888-7777-6666-555555555555'

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
})

function build(providerId = 'test'): InstanceType<typeof AgentRuntime> {
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
    expect(ready?.messages.map((message) => message.text)).toContain('the thing we talked about')
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
