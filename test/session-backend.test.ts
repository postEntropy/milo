import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '../src/core/agent/events.js'
import type { CommandCodeSessionDriver, NativeSessionHistory, NativeSessionTurn } from '../src/core/session-backend.js'
import { AgentRuntime, type RuntimeOptions } from '../src/core/runtime.js'
import type { ChatRequest, Message, Provider, StreamEvent } from '../src/core/providers/types.js'
import { FileSessionStore } from '../src/core/sessions/file-store.js'
import { MemorySessionSeen } from '../src/core/sessions/seen.js'
import type { CommandCodeSessionBackend, SessionRecord } from '../src/core/sessions/types.js'
import { createToolRegistry } from '../src/core/tools/index.js'
import { SqliteMemory } from '../src/core/memory/sqlite.js'

class StubProvider implements Provider {
  readonly id = 'stub'
  calls = 0

  async *stream(_request: ChatRequest): AsyncGenerator<StreamEvent> {
    this.calls += 1
    yield { type: 'text', delta: 'Milo response' }
    yield { type: 'done', finishReason: 'stop' }
  }
}

class StubCommandCode implements CommandCodeSessionDriver {
  calls = 0
  stops = 0
  readonly transcripts = new Map<string, Message[]>()

  async availability() {
    return { id: 'command-code' as const, available: true }
  }

  async history(record: SessionRecord): Promise<NativeSessionHistory> {
    const backend = record.backend
    const messages = backend?.kind === 'command-code' && backend.nativeSessionId
      ? structuredClone(this.transcripts.get(backend.nativeSessionId) ?? [])
      : []
    const last = messages.at(-1)
    const preview = messages.find((message) => message.role === 'user')?.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join(' ') ?? ''
    return {
      messages,
      ...(backend?.kind === 'command-code' && backend.nativeSessionId ? { nativeSessionId: backend.nativeSessionId } : {}),
      preview,
      messageCount: messages.filter((message) => message.role === 'user' || message.role === 'assistant').length,
      updatedAt: last?.at ?? record.createdAt,
    }
  }

  async *send(record: SessionRecord, input: string): AsyncGenerator<AgentEvent, NativeSessionTurn, void> {
    this.calls += 1
    const backend = record.backend
    if (backend?.kind !== 'command-code') throw new Error('Wrong backend')
    const nativeSessionId = backend.nativeSessionId ?? 'native-session-1'
    const existing = this.transcripts.get(nativeSessionId) ?? []
    const now = Date.now()
    const messages: Message[] = [
      ...existing,
      { role: 'user', content: [{ type: 'text', text: input }], at: now },
      { role: 'assistant', content: [{ type: 'text', text: 'Native response' }], at: now + 1 },
    ]
    this.transcripts.set(nativeSessionId, messages)
    yield { type: 'text-delta', delta: 'Native response' }
    yield { type: 'done', finishReason: 'end_turn' }
    const history = await this.history({ ...record, backend: { ...backend, nativeSessionId } })
    return {
      backend: { ...backend, state: 'ready', nativeSessionId, terminalId: undefined, pendingTurn: undefined },
      history,
    }
  }

  async stop(record: SessionRecord): Promise<CommandCodeSessionBackend> {
    this.stops += 1
    if (record.backend?.kind !== 'command-code') throw new Error('Wrong backend')
    return { ...record.backend, state: 'stopped', terminalId: undefined }
  }
}

function runtimeOptions(dir: string, commandCode?: CommandCodeSessionDriver): RuntimeOptions {
  return {
    provider: new StubProvider(),
    model: 'm',
    system: 'BASE',
    registry: createToolRegistry(),
    memory: new SqliteMemory({ dir: mkdtempSync(path.join(tmpdir(), 'milo-session-agent-memory-')) }),
    cwd: process.cwd(),
    store: new FileSessionStore({ dir }),
    seen: new MemorySessionSeen(),
    commandCode,
  }
}

async function drain(stream: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

async function seedCommandCodeSession(dir: string, commandCode: CommandCodeSessionDriver, scope: { gateway: string; chatId: string }, project = 'project-a', provider: Provider = new StubProvider()) {
  const store = new FileSessionStore({ dir })
  const record = await store.create(scope, project)
  record.backend = {
    kind: 'command-code',
    state: 'waiting',
    nativeTitle: `Milo Session ${record.id}`,
    requestId: scope.chatId,
    workingDirectory: process.cwd(),
  }
  await store.save(record, record.version)
  const runtime = new AgentRuntime({ ...runtimeOptions(dir, commandCode), provider, store })
  const session = await runtime.resumeSession(scope, record.id)
  if (!session) throw new Error('Seeded Command Code Session could not be resumed.')
  return { runtime, session }
}

describe('Session agent backends', () => {
  it('keeps Command Code identity in Milo and the transcript only in the native backend', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milo-session-agent-'))
    const provider = new StubProvider()
    const commandCode = new StubCommandCode()
    const scope = { gateway: 'web', chatId: '2e741b35-7ca0-4b32-9d1c-47ba5e7a22a1' }
    const { runtime, session } = await seedCommandCodeSession(dir, commandCode, scope, 'project-a', provider)
    expect(session.backend.kind).toBe('command-code')
    expect(session.messages).toEqual([])
    expect(commandCode.calls).toBe(0)

    const events = await drain(session.send('Create a source file.'))
    expect(events).toContainEqual({ type: 'text-delta', delta: 'Native response' })
    expect(session.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(provider.calls).toBe(0)
    expect((await runtime.loadSession(session.id))?.messages).toEqual([])
    expect((await runtime.listSessions()).find((summary) => summary.id === session.id)).toMatchObject({
      backend: { kind: 'command-code', state: 'ready', nativeSessionId: 'native-session-1' },
      preview: 'Create a source file.',
      messageCount: 2,
    })
  })

  it('persists a selected model on the Command Code Session without changing Milo defaults', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milo-session-agent-'))
    const commandCode = new StubCommandCode()
    const scope = { gateway: 'web', chatId: '2e741b35-7ca0-4b32-9d1c-47ba5e7a22a1' }
    const { runtime, session } = await seedCommandCodeSession(dir, commandCode, scope)

    await session.setCommandCodeModel('anthropic/claude-sonnet-5-5')

    expect(session.backendView).toMatchObject({ kind: 'command-code', model: 'anthropic/claude-sonnet-5-5' })
    expect((await runtime.loadSession(session.id))?.backend).toMatchObject({ model: 'anthropic/claude-sonnet-5-5' })
    expect(runtime.model).toBe('m')
  })

  it('does not clear an unresolved turn from coincidentally matching native messages', async () => {
    const commandCode: CommandCodeSessionDriver = {
      availability: async () => ({ id: 'command-code', available: true }),
      history: async (record) => {
        const pending = record.backend?.kind === 'command-code' ? record.backend.pendingTurn : undefined
        const messages: Message[] = pending ? [
          { role: 'user', content: [{ type: 'text', text: pending.input }] },
          { role: 'assistant', content: [{ type: 'text', text: 'An unrelated answer.' }] },
        ] : []
        return { messages, preview: pending?.input ?? '', messageCount: messages.length, updatedAt: 1 }
      },
      async *send(): AsyncGenerator<AgentEvent, NativeSessionTurn, void> {
        yield { type: 'waiting' }
        throw new Error('Herdr disconnected')
      },
      stop: async (record) => record.backend as CommandCodeSessionBackend,
    }
    const dir = mkdtempSync(path.join(tmpdir(), 'milo-session-agent-'))
    const scope = { gateway: 'web', chatId: '2e741b35-7ca0-4b32-9d1c-47ba5e7a22a1' }
    const { session } = await seedCommandCodeSession(dir, commandCode, scope)

    await drain(session.send('the repeated message'))

    expect(session.backendView.pendingTurn?.input).toBe('the repeated message')
  })

  it('reuses an external Session when the same creation request is retried', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milo-session-agent-'))
    const commandCode = new StubCommandCode()
    const scope = { gateway: 'web', chatId: '2e741b35-7ca0-4b32-9d1c-47ba5e7a22a1' }
    const { runtime, session: first } = await seedCommandCodeSession(dir, commandCode, scope)
    const options = { backend: 'command-code' as const, confirmed: true, creationKey: scope.chatId, project: 'project-a' }

    const retry = await runtime.newSession(scope, undefined, options)

    expect(retry.id).toBe(first.id)
    expect(runtime.sessionCount).toBe(1)
    expect(commandCode.calls).toBe(0)
  })

  it('serializes concurrent retries of the same external Session request', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milo-session-agent-'))
    const commandCode = new StubCommandCode()
    const scope = { gateway: 'web', chatId: '2e741b35-7ca0-4b32-9d1c-47ba5e7a22a1' }
    const { runtime, session: first } = await seedCommandCodeSession(dir, commandCode, scope)
    const options = { backend: 'command-code' as const, confirmed: true, creationKey: scope.chatId, project: 'project-a' }

    const [retry] = await Promise.all([
      runtime.newSession(scope, undefined, options),
      runtime.newSession(scope, undefined, options),
    ])

    expect(retry.id).toBe(first.id)
    expect((await runtime.listSessions()).filter((session) => session.backend?.kind === 'command-code')).toHaveLength(1)
  })

  it('refuses to reuse a creation key for a different project', async () => {
    const commandCode = new StubCommandCode()
    const scope = { gateway: 'web', chatId: '2e741b35-7ca0-4b32-9d1c-47ba5e7a22a1' }
    const { runtime } = await seedCommandCodeSession(mkdtempSync(path.join(tmpdir(), 'milo-session-agent-')), commandCode, scope)
    const options = { backend: 'command-code' as const, confirmed: true, creationKey: scope.chatId, project: 'project-a' }

    await expect(runtime.newSession(scope, undefined, { ...options, project: 'second-project' }))
      .rejects.toThrow('already used for a different project')
  })

  it('leaves legacy records on the Milo backend', async () => {
    const runtime = new AgentRuntime(runtimeOptions(mkdtempSync(path.join(tmpdir(), 'milo-session-agent-'))))
    const session = await runtime.newSession({ gateway: 'cli', chatId: 'main' })

    expect(session.backend).toEqual({ kind: 'milo' })
  })

  it('refuses to create a Command Code Session outside Work', async () => {
    const commandCode = new StubCommandCode()
    const runtime = new AgentRuntime(runtimeOptions(mkdtempSync(path.join(tmpdir(), 'milo-session-agent-')), commandCode))

    await expect(runtime.newSession(
      { gateway: 'web', chatId: '2e741b35-7ca0-4b32-9d1c-47ba5e7a22a1' },
      undefined,
      { backend: 'command-code', confirmed: true },
    )).rejects.toThrow('must be started in a Work project')
    expect(runtime.sessionCount).toBe(0)
  })

  it('does not silently create an external Session without confirmation', async () => {
    const commandCode = new StubCommandCode()
    const runtime = new AgentRuntime(runtimeOptions(mkdtempSync(path.join(tmpdir(), 'milo-session-agent-')), commandCode))

    await expect(runtime.newSession(
      { gateway: 'web', chatId: '2e741b35-7ca0-4b32-9d1c-47ba5e7a22a1' },
      undefined,
      { backend: 'command-code', project: 'project-a' },
    )).rejects.toThrow('Confirm the Command Code backend')
    expect(runtime.sessionCount).toBe(0)
  })

  it('preserves native history when the Milo Session is deleted', async () => {
    const commandCode = new StubCommandCode()
    const scope = { gateway: 'web', chatId: '2e741b35-7ca0-4b32-9d1c-47ba5e7a22a1' }
    const { runtime, session } = await seedCommandCodeSession(mkdtempSync(path.join(tmpdir(), 'milo-session-agent-')), commandCode, scope)
    await drain(session.send('Create a source file.'))

    expect(await runtime.removeSession(session.id)).toBe(true)
    expect(commandCode.stops).toBe(1)
    expect(commandCode.transcripts.get('native-session-1')).toHaveLength(2)
    expect(await runtime.loadSession(session.id)).toBeNull()
  })
})
