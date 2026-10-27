import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ServerFrame } from '../src/gateways/web/protocol.js'

const home = mkdtempSync(path.join(os.tmpdir(), 'milo-web-history-'))
process.env.MILO_HOME = home

const { WebHub } = await import('../src/gateways/web/hub.js')
const { AgentRuntime } = await import('../src/core/runtime.js')
const { findPreset } = await import('../src/core/config/presets.js')
const { TRANSCRIPT_CHUNK_BYTES, transcriptChunks } = await import('../src/gateways/web/protocol.js')

const CHAT = '11111111-2222-3333-4444-555555555555'
/**
 * What a phone's websocket refuses: `URLSessionWebSocketTask` closes the socket with
 * "Message too long" for anything over 1 MiB, which is why a long session is cut up.
 */
const IOS_MESSAGE_LIMIT = 1024 * 1024
/** A row of about a tenth of the budget, so a session of these has room to be split. */
const ROW_BYTES = 100_000

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
})

function build(): InstanceType<typeof AgentRuntime> {
  return new AgentRuntime({
    provider: { id: 'test', stream: async function* () {} },
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

function client(frames: ServerFrame[]): { send(frame: unknown): void } {
  return { send: (frame: unknown) => void frames.push(frame as ServerFrame) }
}

/** What a surface draws: the `ready`'s rows followed by every `history` piece, in order. */
function threadOf(frames: ServerFrame[]): Array<{ role: string; text: string }> {
  return frames.flatMap((frame) => {
    const messages = frame.type === 'ready' || frame.type === 'history' ? frame.messages : []
    return messages.map((message) => ({
      role: message.role,
      text: message.parts.flatMap((part) => (part.kind === 'text' ? [part.text] : [])).join(''),
    }))
  })
}

describe('a transcript split for a socket that has a ceiling', () => {
  it('keeps whole rows, and sends a row too big for the budget alone', () => {
    const row = (text: string) => ({ role: 'assistant' as const, parts: [{ kind: 'text' as const, text }] })
    const huge = row('x'.repeat(TRANSCRIPT_CHUNK_BYTES + 1))

    // Three small rows fill one piece; the oversized row cannot be divided, so it goes
    // by itself rather than arriving as half a result on a surface that cannot tell.
    const chunks = transcriptChunks([row('a'), huge, row('b')])
    expect(chunks.map((chunk) => chunk.length)).toEqual([1, 1, 1])
    expect(chunks.flat()).toHaveLength(3)
  })

  it('hands a long session over in pieces no phone has to refuse', async () => {
    const runtime = build()
    const session = await runtime.newSession({ gateway: 'web', chatId: CHAT })
    // Turns, not one long answer: a row is a turn, so this is what a session with a
    // dozen of them looks like on the wire.
    const said: string[] = []
    for (let index = 0; index < 6; index += 1) {
      const question = `ask ${index}`
      const answer = `${index}:${'w'.repeat(ROW_BYTES)}`
      session.messages.push({ role: 'user', content: [{ type: 'text', text: question }] })
      session.messages.push({ role: 'assistant', content: [{ type: 'text', text: answer }] })
      said.push(question, answer)
    }

    const frames: ServerFrame[] = []
    await new WebHub(runtime).connect(client(frames), CHAT)

    const ready = frames.find((frame) => frame.type === 'ready')
    const pieces = frames.filter((frame) => frame.type === 'history')
    expect(ready?.type).toBe('ready')
    // The handshake says more follows, and the rows arrive across more than one message.
    expect(ready?.type === 'ready' && ready.continues).toBe(true)
    expect(pieces.length).toBeGreaterThan(0)
    for (const frame of frames) expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThan(IOS_MESSAGE_LIMIT)
    // Nothing lost or reordered by the cut: the surface draws the session it asked for.
    expect(threadOf(frames).map((row) => row.text)).toEqual(said)
  })

  it('opens a session that fits in one message with the handshake alone', async () => {
    const runtime = build()
    const session = await runtime.newSession({ gateway: 'web', chatId: CHAT })
    await session.appendNotice('a short one')

    const frames: ServerFrame[] = []
    await new WebHub(runtime).connect(client(frames), CHAT)

    const ready = frames.find((frame) => frame.type === 'ready')
    expect(ready?.type === 'ready' && ready.messages).toHaveLength(1)
    // No piece to follow, so no `continues` and nothing else to append.
    expect(ready?.type === 'ready' && ready.continues).toBeUndefined()
    expect(frames.some((frame) => frame.type === 'history')).toBe(false)
  })
})
