import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileMemory } from '../src/core/memory/local'
import type { ChatRequest, Provider, StreamEvent } from '../src/core/providers/types'
import { AgentRuntime, type RuntimeOptions } from '../src/core/runtime'
import { FileSessionStore } from '../src/core/sessions/file-store'
import { createToolRegistry } from '../src/core/tools'

class StubProvider implements Provider {
  readonly id = 'stub'
  async *stream(_req: ChatRequest): AsyncGenerator<StreamEvent> {
    yield { type: 'text', delta: 'ok' }
    yield { type: 'done', finishReason: 'stop' }
  }
}

function runtimeOptions(dir: string): RuntimeOptions {
  return {
    provider: new StubProvider(),
    model: 'm',
    system: 'BASE',
    registry: createToolRegistry(),
    memory: new FileMemory({ dir: mkdtempSync(path.join(tmpdir(), 'milo-mem-')) }),
    cwd: process.cwd(),
    store: new FileSessionStore({ dir }),
  }
}

const cli = { gateway: 'cli', conversationId: 'main' }

async function drain(promise: AsyncGenerator<unknown>): Promise<void> {
  for await (const _event of promise) {
    // drain
  }
}

describe('AgentRuntime sessions', () => {
  it('binds a conversation to one session and reuses it', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milo-rt-'))
    const runtime = new AgentRuntime(runtimeOptions(dir))

    const first = await runtime.getSession(cli)
    const again = await runtime.getSession(cli)

    expect(first.id).toBe(again.id)
    expect(runtime.sessionCount).toBe(1)
  })

  it('starts a new session without losing the old one', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milo-rt-'))
    const runtime = new AgentRuntime(runtimeOptions(dir))

    const first = await runtime.getSession(cli)
    await drain(first.send('hello'))

    const second = await runtime.newSession(cli, 'my project')
    expect(second.id).not.toBe(first.id)
    expect(second.title).toBe('my project')

    const list = await runtime.listSessions()
    expect(list.map((entry) => entry.id)).toEqual(expect.arrayContaining([first.id, second.id]))
    expect(list.find((entry) => entry.id === second.id)?.title).toBe('my project')
  })

  it('switches back to an old session with its transcript intact', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milo-rt-'))
    const runtime = new AgentRuntime(runtimeOptions(dir))

    const first = await runtime.getSession(cli)
    await drain(first.send('remember this'))
    await runtime.newSession(cli)

    const back = await runtime.resumeSession(cli, first.id)
    expect(back?.id).toBe(first.id)
    expect(back?.messages.length).toBeGreaterThan(0)
  })

  it('returns null for an unknown session id', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milo-rt-'))
    const runtime = new AgentRuntime(runtimeOptions(dir))
    expect(await runtime.resumeSession(cli, 'nope-nope-9')).toBeNull()
  })

  it('continues the same session after a restart', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milo-rt-'))

    const before = new AgentRuntime(runtimeOptions(dir))
    const session = await before.getSession(cli)
    await drain(session.send('first message'))

    // A new process, same on-disk store.
    const after = new AgentRuntime(runtimeOptions(dir))
    const resumed = await after.getSession(cli)

    expect(resumed.id).toBe(session.id)
    expect(resumed.messages).toHaveLength(2)
  })

  it('lets another gateway open the same session', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milo-rt-'))
    const runtime = new AgentRuntime(runtimeOptions(dir))

    const telegram = await runtime.getSession({ gateway: 'telegram', conversationId: '42' })
    await drain(telegram.send('from telegram'))

    const opened = await runtime.resumeSession(
      { gateway: 'discord', conversationId: '99' },
      telegram.id,
    )
    expect(opened?.id).toBe(telegram.id)

    const discord = await runtime.getSession({ gateway: 'discord', conversationId: '99' })
    expect(discord.id).toBe(telegram.id)
    expect(discord.messages.length).toBeGreaterThan(0)
  })
})
