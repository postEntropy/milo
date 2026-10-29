import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ChatRequest, Provider, StreamEvent } from '../src/core/providers/types.js'
import { AgentRuntime } from '../src/core/runtime.js'
import { FileSessionStore } from '../src/core/sessions/file-store.js'
import { MemorySessionSeen } from '../src/core/sessions/seen.js'
import { WebHub } from '../src/gateways/web/hub.js'

const POPUP = '11111111-2222-3333-4444-555555555555'
const BROWSER = '99999999-8888-7777-6666-555555555555'

const provider: Provider = {
  id: 'stub',
  async *stream(_request: ChatRequest): AsyncGenerator<StreamEvent> {
    yield { type: 'text', delta: 'ok' }
    yield { type: 'done', finishReason: 'stop' }
  },
}

function runtimeOver(dir: string, store: FileSessionStore): AgentRuntime {
  return new AgentRuntime({
    provider,
    model: 'm',
    system: '',
    registry: { specs: () => [] } as never,
    memory: { remember: async () => undefined, recall: async () => [], list: async () => [], forget: async () => false } as never,
    cwd: dir,
    store,
    seen: new MemorySessionSeen(),
  })
}

function frames(): { send(frame: unknown): void; seen: { type: string; sessionId?: string }[] } {
  const seen: { type: string; sessionId?: string }[] = []
  return { send: (frame) => void seen.push(frame as never), seen }
}

function readySession(collected: ReturnType<typeof frames>): string {
  const ready = collected.seen.find((frame) => frame.type === 'ready')
  if (!ready?.sessionId) throw new Error('No session was opened.')
  return ready.sessionId
}

describe('a session asked for by the spotlight', () => {
  it('is recorded with the surface that asked, beside the web scope it keeps', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milo-spotlight-'))
    const store = new FileSessionStore({ dir })
    const hub = new WebHub(runtimeOver(dir, store))

    const popup = frames()
    await hub.connect(popup, POPUP, undefined, undefined, 'spotlight')

    const record = await store.load(readySession(popup))
    expect(record?.surface).toBe('spotlight')
    // The address stays the web's: same place, same memory as any other web session.
    expect(record?.scope).toEqual({ gateway: 'web', chatId: POPUP })
  })

  it('is left unmarked when the browser itself asks', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milo-spotlight-'))
    const store = new FileSessionStore({ dir })
    const hub = new WebHub(runtimeOver(dir, store))

    const browser = frames()
    await hub.connect(browser, BROWSER)

    const record = await store.load(readySession(browser))
    expect(record).not.toHaveProperty('surface')
  })
})
