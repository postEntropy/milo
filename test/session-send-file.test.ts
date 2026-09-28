import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '../src/core/agent/events.js'
import { SqliteMemory } from '../src/core/memory/sqlite.js'
import type { ChatRequest, Provider, StreamEvent } from '../src/core/providers/types.js'
import { Session } from '../src/core/session.js'
import { MemorySessionStore } from '../src/core/sessions/memory-store.js'
import { createToolRegistry } from '../src/core/tools/index.js'

/** Emits one `send_file` call and then the answer: the shape a routine's turn takes. */
class ShotProvider implements Provider {
  readonly id = 'shot'
  private calls = 0

  constructor(private readonly file: string) {}

  async *stream(_req: ChatRequest): AsyncGenerator<StreamEvent> {
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

/** A real turn over a real Session, with a file the tool can name. */
async function run(deliverTo?: { gateway: string; conversationId: string }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'milo-session-send-'))
  const file = path.join(dir, 'shot.png')
  writeFileSync(file, 'not really a png')

  const store = new MemorySessionStore()
  const record = await store.create()
  const session = new Session({
    scope: { gateway: 'routine', conversationId: 'calm-otter-1' },
    provider: new ShotProvider(file),
    model: 'm',
    system: 'BASE',
    registry: createToolRegistry(),
    memory: new SqliteMemory({ dir }),
    cwd: dir,
    record,
    store,
    maxSteps: 4,
    deliverTo,
  })

  const events: AgentEvent[] = []
  for await (const event of session.send('take a screenshot and send it')) events.push(event)
  const ended = events.find((event): event is Extract<AgentEvent, { type: 'tool-end' }> => event.type === 'tool-end')
  return { session, events, ended, file }
}

describe('a turn that sends a file', () => {
  it('collects the file for the chat the session delivers to', async () => {
    const { session, events, ended } = await run({ gateway: 'telegram', conversationId: '123' })

    expect(ended?.isError).toBe(false)
    expect(events.some((event) => event.type === 'text-delta' && event.delta === 'sent')).toBe(true)
    expect(session.takeOutgoing()).toEqual([
      expect.objectContaining({ name: 'shot.png', mimeType: 'image/png', caption: 'the screen' }),
    ])
    // Taken, not copied: a second read must not deliver the same picture twice.
    expect(session.takeOutgoing()).toEqual([])
  })

  it('refuses when there is no chat to send to', async () => {
    const { session, ended } = await run()

    expect(ended?.isError).toBe(true)
    expect(ended?.result).toContain('no chat')
    expect(session.takeOutgoing()).toEqual([])
  })
})
