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
  /** The tool names each request was offered, first call first. */
  readonly offered: string[][] = []

  constructor(private readonly file: string) {}

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    this.calls += 1
    this.offered.push((req.tools ?? []).map((tool) => tool.name))
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
async function run(deliverTo?: { gateway: string; conversationId: string }, gateway = 'routine') {
  const dir = mkdtempSync(path.join(tmpdir(), 'milo-session-send-'))
  const file = path.join(dir, 'shot.png')
  writeFileSync(file, 'not really a png')

  const store = new MemorySessionStore()
  const record = await store.create()
  const provider = new ShotProvider(file)
  const session = new Session({
    scope: { gateway, conversationId: 'calm-otter-1' },
    provider,
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
  return { session, events, ended, file, provider }
}

describe('a turn that sends a file', () => {
  it('collects the file for the chat the session delivers to', async () => {
    const { session, events, ended, provider } = await run({ gateway: 'telegram', conversationId: '123' })

    // Offered, because this turn has a chat to deliver to.
    expect(provider.offered[0]).toContain('send_file')
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

  // The catalog rule, and the refusal above is only the second line: a tool the
  // turn has nothing to act on is absent from the list, not offered and failing.
  it('is not offered to a turn with nobody to deliver to', async () => {
    const { provider } = await run()

    expect(provider.offered[0]).not.toContain('send_file')
  })

  it('is offered to a live chat that can receive a file, and collects for it', async () => {
    const { session, ended, provider } = await run(undefined, 'web')

    expect(provider.offered[0]).toContain('send_file')
    expect(ended?.isError).toBe(false)
    expect(session.takeOutgoing()).toEqual([
      expect.objectContaining({ name: 'shot.png', mimeType: 'image/png', caption: 'the screen' }),
    ])
  })

  it('stays out of the terminal, which has nowhere to put a file', async () => {
    const { ended, provider } = await run(undefined, 'cli')

    expect(provider.offered[0]).not.toContain('send_file')
    expect(ended?.isError).toBe(true)
  })
})
