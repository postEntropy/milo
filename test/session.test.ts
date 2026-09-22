import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileMemory } from '../src/core/memory/local'
import type { ChatRequest, Provider, StreamEvent } from '../src/core/providers/types'
import { Session } from '../src/core/session'
import { createToolRegistry } from '../src/core/tools'

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
  const scope = { gateway: 'cli', conversationId: 't' }
  const session = new Session({
    id: 't',
    scope,
    provider,
    model: 'test-model',
    system: 'BASE',
    registry: createToolRegistry(),
    memory,
    cwd: process.cwd(),
    maxSteps: 4,
  })

  const events = []
  for await (const event of session.send(input)) events.push(event)
  return { provider, memory, scope, events }
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
})
