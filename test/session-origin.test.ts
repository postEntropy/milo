import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { AgentEvent } from '../src/core/agent/events.js'
import { SqliteMemory } from '../src/core/memory/sqlite.js'
import type { MemoryScope } from '../src/core/memory/types.js'
import type { ChatRequest, Provider, StreamEvent } from '../src/core/providers/types.js'
import { Session } from '../src/core/session.js'
import { MemorySessionStore } from '../src/core/sessions/memory-store.js'
import { ToolRegistry } from '../src/core/tools/registry.js'
import type { Tool } from '../src/core/tools/types.js'

/** Emits one `probe` call and then the answer, so the turn has a tool to look through. */
class ProbeProvider implements Provider {
  readonly id = 'probe'
  private calls = 0

  async *stream(_request: ChatRequest): AsyncGenerator<StreamEvent> {
    this.calls += 1
    if (this.calls === 1) {
      yield { type: 'tool-call', id: 'c1', name: 'probe', args: {} }
      yield { type: 'done', finishReason: 'tool_calls' }
      return
    }
    yield { type: 'text', delta: 'done' }
    yield { type: 'done', finishReason: 'stop' }
  }
}

/** The addresses the turn handed the tool, one per call. */
const seen: Array<MemoryScope | undefined> = []

const probeSchema = z.object({})
const probe: Tool<z.infer<typeof probeSchema>> = {
  name: 'probe',
  description: 'Records the address of the turn it runs in.',
  schema: probeSchema,
  async execute(_args, ctx) {
    seen.push(ctx.origin)
    return { content: 'seen' }
  },
}

/** A real turn over a real Session, in one web conversation. */
async function run(origin?: MemoryScope) {
  const dir = mkdtempSync(path.join(tmpdir(), 'milo-session-origin-'))
  const store = new MemorySessionStore()
  const record = await store.create()
  const session = new Session({
    scope: { gateway: 'web', conversationId: 'the-browser-chat' },
    provider: new ProbeProvider(),
    model: 'm',
    system: 'BASE',
    registry: new ToolRegistry([probe]),
    memory: new SqliteMemory({ dir }),
    cwd: dir,
    record,
    store,
    maxSteps: 4,
  })

  const events: AgentEvent[] = []
  for await (const event of session.send('every day at 8, tell me what moved', origin ? { origin } : undefined)) {
    events.push(event)
  }
  return { session, events }
}

describe('the address a turn is pinned to', () => {
  /**
   * The routines screen knows the destination before the sentence is written, so
   * it pins it. A tool that defaults to "the chat this request came from" then
   * means that chat — a routine named for Telegram is not made for the web chat
   * the screen happens to be running in.
   */
  it('hands the pinned destination to the tools, over the chat the turn runs in', async () => {
    seen.length = 0
    await run({ gateway: 'telegram', conversationId: '123' })

    expect(seen).toEqual([{ gateway: 'telegram', conversationId: '123' }])
  })

  it("falls back to the session's own chat when nothing is pinned", async () => {
    seen.length = 0
    await run()

    expect(seen).toEqual([{ gateway: 'web', conversationId: 'the-browser-chat' }])
  })
})
