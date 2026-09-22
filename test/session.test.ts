import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileMemory } from '../src/core/memory/local'
import type { MemoryScope } from '../src/core/memory/index'
import type { ChatRequest, Provider, StreamEvent } from '../src/core/providers/types'
import { Session, type SessionOptions } from '../src/core/session'
import { MemorySessionStore } from '../src/core/sessions/memory-store'
import { createToolRegistry } from '../src/core/tools'

type Extra = Omit<SessionOptions, 'record' | 'scope' | 'store' | 'provider' | 'memory'>

class CapturingProvider implements Provider {
  readonly id = 'capturing'
  lastSystem?: string

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    this.lastSystem = req.system
    yield { type: 'text', delta: 'SECRET_ASSISTANT_REPLY' }
    yield { type: 'done', finishReason: 'stop' }
  }
}

async function run(input: string) {
  const dir = mkdtempSync(path.join(tmpdir(), 'milo-session-'))
  const provider = new CapturingProvider()
  const memory = new FileMemory({ dir })
  const store = new MemorySessionStore()
  const scope: MemoryScope = { gateway: 'cli', conversationId: 't' }
  const base: Extra = {
    model: 'test-model',
    system: 'BASE',
    registry: createToolRegistry(),
    cwd: process.cwd(),
    maxSteps: 4,
  }

  const record = await store.create()
  const session = new Session({ ...base, provider, memory, store, scope, record })

  const events = []
  for await (const event of session.send(input)) events.push(event)
  return { provider, memory, store, scope, base, record, session, events }
}

describe('Session', () => {
  it('builds a system prompt with environment and tools', async () => {
    const { provider } = await run('hello there')
    expect(provider.lastSystem).toContain('## Environment')
    expect(provider.lastSystem).toContain(`Working directory: ${process.cwd()}`)
    expect(provider.lastSystem).toContain('## Available tools')
    expect(provider.lastSystem).toContain('read_file(path, offset?, limit?)')
  })

  it('remembers the user message but not the assistant reply', async () => {
    const { memory, scope } = await run('my editor is Neovim')

    const userHits = await memory.recall(scope, 'which editor do I like?', { limit: 5 })
    expect(userHits.some((hit) => hit.text.includes('Neovim'))).toBe(true)

    const assistantHits = await memory.recall(scope, 'SECRET_ASSISTANT_REPLY', { limit: 5 })
    expect(assistantHits).toEqual([])
  })

  it('persists the transcript and reloads it into a new session', async () => {
    const { store, session, scope, base, provider, memory } = await run('what is the package?')

    const saved = await store.load(session.id)
    expect(saved).not.toBeNull()
    expect(saved!.messages.map((message) => message.role)).toEqual(['user', 'assistant'])

    const reloaded = new Session({ ...base, provider, memory, store, scope, record: saved! })
    expect(reloaded.id).toBe(session.id)
    expect(reloaded.messages).toHaveLength(2)
  })

  it('reports stats that match the transcript', async () => {
    const { session } = await run('hello there')
    const stats = session.stats()

    expect(stats.id).toBe(session.id)
    expect(stats.messages).toBe(session.messages.length)
    expect(stats.turns).toBe(1)
    expect(stats.tokens).toBeGreaterThan(0)
    expect(stats.compacted).toBe(false)
  })

  it('clears the transcript but keeps the session identity', async () => {
    const { session, store } = await run('hello there')
    await session.clear()

    expect(session.messages).toHaveLength(0)
    expect(session.id).toMatch(/^[a-z]+-[a-z]+-\d{1,3}$/)
    expect((await store.load(session.id))!.messages).toHaveLength(0)
  })

  it('keeps remembered facts when a new session starts on the same scope', async () => {
    const { store, scope, base, provider, memory } = await run('my editor is Neovim')

    // A brand-new session for the same conversation is a /new: its transcript is
    // empty, but the scope — and therefore the memory — is the same.
    const record = await store.create()
    const fresh = new Session({ ...base, provider, memory, store, scope, record })
    for await (const _event of fresh.send('which editor do I use?')) {
      // drain
    }

    expect(fresh.messages).toHaveLength(2)
    expect(provider.lastSystem).toContain('## What you remember')
    expect(provider.lastSystem).toContain('Neovim')
  })
})
