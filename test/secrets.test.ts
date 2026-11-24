import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

const home = mkdtempSync(path.join(os.tmpdir(), 'milo-secrets-'))
process.env.MILO_HOME = home

const {
  REDACTED_PRIVATE_KEY,
  REDACTED_SECRET,
  SECRET_REDACTED_NOTICE,
  redactSecrets,
  redactSecretsInValue,
} = await import('../src/core/secrets.js')
const { fileTraces, TracedProvider } = await import('../src/core/traces.js')
const { dayOf, fileHistory } = await import('../src/core/history.js')
const { createMemory } = await import('../src/core/memory/index.js')
const { TurnIndex } = await import('../src/core/memory/turns.js')
const { Session } = await import('../src/core/session.js')
const { FileSessionStore } = await import('../src/core/sessions/file-store.js')
const { MemoryRecapStore } = await import('../src/core/sessions/recap.js')
const { ToolRegistry } = await import('../src/core/tools/index.js')
const { sanitizeMessagesForPersistence } = await import('../src/core/computer/sanitize.js')
type StreamEvent = import('../src/core/providers/types.js').StreamEvent
type ChatRequest = import('../src/core/providers/types.js').ChatRequest
type Memory = import('../src/core/memory/types.js').Memory
type HistoryEntry = import('../src/core/history.js').HistoryEntry

beforeEach(() => {
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('secret redaction', () => {
  it('redacts labeled passwords and credentials across Portuguese and English prose', () => {
    const sample = 'user@example.com\nsenha: MySecret99!\n\nvai digitar sim!'
    const out = redactSecrets(sample)
    expect(out.redacted).toBe(true)
    expect(out.text).toBe(`user@example.com\nsenha: ${REDACTED_SECRET}\n\nvai digitar sim!`)
    expect(out.text).not.toContain('MySecret99!')

    expect(redactSecrets('password="my pass 123"').text).toBe(`password="${REDACTED_SECRET}"`)
    expect(redactSecrets('minha senha é Forte123!').text).toBe(`minha senha é ${REDACTED_SECRET}`)
    expect(redactSecrets('my password is hunter2').text).toBe(`my password is ${REDACTED_SECRET}`)
    expect(redactSecrets('otp: 849201').text).toBe(`otp: ${REDACTED_SECRET}`)
  })

  it('redacts structured keys, bearer headers, credentialed URLs, and private keys', () => {
    expect(redactSecrets('use sk-proj-abcdefghijklmnopqrstuvwxyz123456').text).toBe(
      `use ${REDACTED_SECRET}`,
    )
    expect(redactSecrets('Authorization: Bearer topsecretvalue123456').text).toBe(
      `Authorization: Bearer ${REDACTED_SECRET}`,
    )
    expect(redactSecrets('postgres://alice:s3cr3tPass@db.internal:5432/app').text).toBe(
      `postgres://alice:${REDACTED_SECRET}@db.internal:5432/app`,
    )
    expect(redactSecrets('OPENAI_API_KEY=sk-test-1234567890abcdefghij').text).toBe(
      `OPENAI_API_KEY=${REDACTED_SECRET}`,
    )

    const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nabc123\n-----END OPENSSH PRIVATE KEY-----'
    expect(redactSecrets(pem).text).toBe(REDACTED_PRIVATE_KEY)
  })

  it('leaves ordinary prose mentioning passwords unredacted and is idempotent', () => {
    const prose = 'não envie a senha aqui; a senha é obrigatória e password is required'
    const first = redactSecrets(prose)
    expect(first.redacted).toBe(false)
    expect(first.text).toBe(prose)

    const redacted = redactSecrets('senha: SecretValue99!')
    const second = redactSecrets(redacted.text)
    expect(second.redacted).toBe(false)
    expect(second.text).toBe(redacted.text)
  })

  it('redacts strings inside nested objects without mutating inputs', () => {
    const original = { command: 'curl -H "Authorization: Bearer abcdef1234567890"', tags: ['ok', 'pin: 4321'] }
    const cleaned = redactSecretsInValue(original) as typeof original
    expect(cleaned.command).toContain(REDACTED_SECRET)
    expect(cleaned.tags).toEqual(['ok', `pin: ${REDACTED_SECRET}`])
    expect(original.tags[1]).toBe('pin: 4321')
  })
})

describe('file permissions and persistence redaction', () => {
  it('creates brand-new traces.jsonl and daily history files with 0600 permissions', () => {
    const tracesFile = path.join(home, 'traces.jsonl')
    const historyDir = path.join(home, 'history')
    const day = dayOf(new Date())
    const historyFile = path.join(historyDir, `${day}.jsonl`)

    fileTraces.record({ at: new Date().toISOString(), event: 'turn', ok: true, ms: 1 })
    fileHistory.append([{ at: new Date().toISOString(), session: 's', scope: 'cli:1', kind: 'user', text: 'hello' }])

    expect(statSync(tracesFile).mode & 0o777).toBe(0o600)
    expect(statSync(historyFile).mode & 0o777).toBe(0o600)
  })

  it('tightens pre-existing traces.jsonl and daily history files to 0600 on append', () => {
    const tracesFile = path.join(home, 'traces.jsonl')
    const historyDir = path.join(home, 'history')
    const day = dayOf(new Date())
    const historyFile = path.join(historyDir, `${day}.jsonl`)

    writeFileSync(tracesFile, '', { mode: 0o644 })
    chmodSync(tracesFile, 0o644)
    fileTraces.record({ at: new Date().toISOString(), event: 'turn', ok: true, ms: 1 })
    expect(statSync(tracesFile).mode & 0o777).toBe(0o600)

    rmSync(historyDir, { recursive: true, force: true })
    fileHistory.append([{ at: new Date().toISOString(), session: 's', scope: 'cli:1', kind: 'user', text: 'ok' }])
    chmodSync(historyFile, 0o644)
    fileHistory.append([
      {
        at: new Date().toISOString(),
        session: 's',
        scope: 'cli:1',
        kind: 'user',
        text: 'senha: Secret999!',
      },
    ])
    expect(statSync(historyFile).mode & 0o777).toBe(0o600)
    expect(readFileSync(historyFile, 'utf8')).not.toContain('Secret999!')
  })

  it('redacts secrets in TracedProvider request and response payloads', async () => {
    const seen: Record<string, unknown>[] = []
    const inner = {
      id: 'test',
      async *stream(): AsyncGenerator<StreamEvent> {
        yield { type: 'text', delta: 'token: sk-proj-abcdefghijklmnopqrstuvwxyz123456' }
        yield { type: 'done', finishReason: 'stop' }
      },
    }
    const provider = new TracedProvider(inner, { record: (entry) => seen.push(entry) })

    for await (const _ of provider.stream({
      model: 'm',
      system: 'remember senha: SystemSecret123!',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'senha: MsgSecret123!' }] }],
    })) {
      void _
    }

    const serialized = JSON.stringify(seen[0])
    expect(serialized).not.toContain('SystemSecret123!')
    expect(serialized).not.toContain('MsgSecret123!')
    expect(serialized).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz123456')
  })

  it('redacts secrets in TurnIndex during indexing and recall of legacy rows', async () => {
    const historyDir = path.join(home, 'history')
    const day = dayOf(new Date())
    const historyFile = path.join(historyDir, `${day}.jsonl`)
    fileHistory.append([{ at: new Date().toISOString(), session: 's1', scope: 'web:1', kind: 'user', text: 'init' }])
    // Simulate a legacy unredacted line written before ingestion redaction existed.
    writeFileSync(
      historyFile,
      `${JSON.stringify({ at: new Date().toISOString(), session: 's1', scope: 'web:1', kind: 'user', text: 'conta teste senha: LegacySecret99!' })}\n`,
      { flag: 'a' },
    )

    const index = new TurnIndex({ dir: historyDir })
    try {
      const recalled = await index.recall({ gateway: 'web', chatId: '1' }, 'conta teste')
      expect(recalled).toHaveLength(1)
      expect(recalled[0]?.text).not.toContain('LegacySecret99!')
      expect(recalled[0]?.text).toContain(REDACTED_SECRET)
    } finally {
      index.close()
    }
  })

  let openServer: Server | null = null

  afterEach(() => {
    openServer?.close()
    openServer = null
  })

  it('redacts secrets in messages before session persistence and before embedding requests', async () => {
    const persisted = sanitizeMessagesForPersistence([
      { role: 'user', displayText: 'password: DisplaySecret1', content: [{ type: 'text', text: 'senha: BodySecret2' }] },
    ])
    expect(JSON.stringify(persisted)).not.toContain('DisplaySecret1')
    expect(JSON.stringify(persisted)).not.toContain('BodySecret2')

    const seenBodies: unknown[] = []
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk: Buffer) => { raw += chunk.toString() })
      req.on('end', () => {
        seenBodies.push(JSON.parse(raw || '{}'))
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ embedding: [1, 0] }] }))
      })
    })
    openServer = server
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0

    const recordedTraces: Record<string, unknown>[] = []
    const mem = createMemory(
      { derive: false, prune: false, embedding: { provider: 'openrouter', url: `http://127.0.0.1:${port}`, model: 'test-embed' } },
      path.join(home, 'memory'),
      { apiKey: 'test-key', traces: { record: (entry) => recordedTraces.push(entry) } },
    )
    await mem.recall({ gateway: 'web', chatId: '1' }, 'senha: EmbedSecret123!')
    expect(JSON.stringify(seenBodies)).not.toContain('EmbedSecret123!')
    expect(JSON.stringify(recordedTraces)).not.toContain('EmbedSecret123!')
    expect(JSON.stringify(seenBodies)).toContain(REDACTED_SECRET)
  })
})

describe('Session ingestion redaction', () => {
  it('redacts credentials before recall, history, session storage, model calls, and derive', async () => {
    const store = new FileSessionStore({ dir: path.join(home, 'sessions') })
    const recaps = new MemoryRecapStore()
    const record = await store.create({ gateway: 'web', chatId: 'chat-1' })

    const recalledQueries: string[] = []
    const memory: Memory = {
      remember: async () => {},
      recall: async (_scope, query) => {
        recalledQueries.push(query)
        return []
      },
      list: async () => [],
      forget: async () => false,
      update: async () => ({ ok: false, error: 'not implemented' }),
      prune: async () => ({ dropped: 0, folded: 0 }),
    }

    const seenRequests: ChatRequest[] = []
    const provider = {
      id: 'fake',
      async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
        seenRequests.push(JSON.parse(JSON.stringify(req)) as ChatRequest)
        if (req.trace?.purpose === 'derive') {
          yield { type: 'text', delta: 'NONE' }
          yield { type: 'done', finishReason: 'stop' }
          return
        }
        yield { type: 'text', delta: 'Please type your password directly in the emulator.' }
        yield { type: 'done', finishReason: 'stop' }
      },
    }

    const historyEntries: HistoryEntry[] = []
    const session = new Session({
      scope: { gateway: 'web', chatId: 'chat-1' },
      provider,
      model: 'test-model',
      system: 'base',
      registry: new ToolRegistry([]),
      memory,
      cwd: home,
      derive: true,
      record,
      store,
      recaps,
      history: { append: (entries) => historyEntries.push(...entries) },
    })

    const secret = 'VerySecretPwd99!'
    const emittedText: string[] = []
    for await (const event of session.send(`user@example.com\nsenha: ${secret}\n\nvai digitar sim!`)) {
      if (event.type === 'text-delta') emittedText.push(event.delta)
    }
    await session.settle()

    expect(emittedText.join('')).toContain(SECRET_REDACTED_NOTICE)
    expect(recalledQueries).toEqual([`user@example.com\nsenha: ${REDACTED_SECRET}\n\nvai digitar sim!`])
    expect(JSON.stringify(seenRequests)).not.toContain(secret)
    expect(JSON.stringify(historyEntries)).not.toContain(secret)
    expect(JSON.stringify(session.messages)).not.toContain(secret)

    const saved = await store.load(record.id)
    expect(JSON.stringify(saved)).not.toContain(secret)
    expect(saved?.messages[0]?.mediaNotices).toContain(SECRET_REDACTED_NOTICE)
  })

  it('redacts secrets in mid-turn steering messages before persistence and model calls', async () => {
    const store = new FileSessionStore({ dir: path.join(home, 'sessions') })
    const recaps = new MemoryRecapStore()
    const record = await store.create({ gateway: 'web', chatId: 'chat-2' })

    const seenRequests: ChatRequest[] = []
    const steering: string[] = []
    let step = 0
    const provider = {
      id: 'fake',
      async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
        seenRequests.push(JSON.parse(JSON.stringify(req)) as ChatRequest)
        step += 1
        if (step === 1) {
          steering.push('password: SteerSecret88!')
          yield { type: 'tool-call', id: 'c1', name: 'noop', args: {} }
          yield { type: 'done', finishReason: 'tool_calls' }
          return
        }
        yield { type: 'text', delta: 'Done.' }
        yield { type: 'done', finishReason: 'stop' }
      },
    }

    const registry = new ToolRegistry([
      {
        name: 'noop',
        description: 'noop',
        schema: z.object({}),
        execute: async () => ({ content: 'ok' }),
      },
    ])

    const historyEntries: HistoryEntry[] = []
    const session = new Session({
      scope: { gateway: 'web', chatId: 'chat-2' },
      provider,
      model: 'test-model',
      system: 'base',
      registry,
      memory: {
        remember: async () => {},
        recall: async () => [],
        list: async () => [],
        forget: async () => false,
        update: async () => ({ ok: false, error: 'not implemented' }),
        prune: async () => ({ dropped: 0, folded: 0 }),
      },
      cwd: home,
      record,
      store,
      recaps,
      history: { append: (entries) => historyEntries.push(...entries) },
    })

    const steers: string[] = []
    for await (const event of session.send('start', { steering })) {
      if (event.type === 'steer') steers.push(event.text)
    }

    expect(steers).toEqual([`password: ${REDACTED_SECRET}`])
    expect(JSON.stringify(seenRequests)).not.toContain('SteerSecret88!')
    expect(JSON.stringify(historyEntries)).not.toContain('SteerSecret88!')
    expect(JSON.stringify(session.messages)).not.toContain('SteerSecret88!')
  })

  it('keeps masked text across model, embedding, Session, history, and traces for initial, steered, and queued turns', async () => {
    const seenEmbedBodies: unknown[] = []
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk: Buffer) => { raw += chunk.toString() })
      req.on('end', () => {
        seenEmbedBodies.push(JSON.parse(raw || '{}'))
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ embedding: [1, 0] }] }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0

    try {
      const sessionsDir = path.join(home, 'sessions')
      const historyDir = path.join(home, 'history')
      const tracesFile = path.join(home, 'traces.jsonl')
      const store = new FileSessionStore({ dir: sessionsDir })
      const recaps = new MemoryRecapStore()
      const record = await store.create({ gateway: 'web', chatId: 'chat-e2e' })

      const memory = createMemory(
        { derive: false, prune: false, embedding: { provider: 'openrouter', url: `http://127.0.0.1:${port}`, model: 'test-embed' } },
        path.join(home, 'memory'),
        { apiKey: 'test-key', traces: fileTraces },
      )

      const seenModelRequests: ChatRequest[] = []
      const steering: string[] = []
      let callCount = 0
      const rawProvider = {
        id: 'fake',
        async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
          seenModelRequests.push(JSON.parse(JSON.stringify(req)) as ChatRequest)
          callCount += 1
          if (req.trace?.purpose === 'derive') {
            yield { type: 'text', delta: 'NONE' }
            yield { type: 'done', finishReason: 'stop' }
            return
          }
          if (callCount === 1) {
            steering.push('Authorization: Bearer FakeSteerToken12345678\npostgres://bob:FakeDbPass99@db.local/app')
            yield { type: 'tool-call', id: 'c1', name: 'noop', args: {} }
            yield { type: 'done', finishReason: 'tool_calls' }
            return
          }
          yield { type: 'text', delta: 'Handled.' }
          yield { type: 'done', finishReason: 'stop' }
        },
      }
      const provider = new TracedProvider(rawProvider, fileTraces)

      const registry = new ToolRegistry([
        {
          name: 'noop',
          description: 'noop',
          schema: z.object({}),
          execute: async () => ({ content: 'ok' }),
        },
      ])

      const session = new Session({
        scope: { gateway: 'web', chatId: 'chat-e2e' },
        provider,
        model: 'test-model',
        system: 'base',
        registry,
        memory,
        cwd: home,
        derive: true,
        record,
        store,
        recaps,
        history: fileHistory,
        traces: fileTraces,
      })

      const secrets = [
        'DummyInitPass1!',
        'sk-proj-dummyOpenAiKey1234567890abcd',
        'FakeSteerToken12345678',
        'FakeDbPass99',
        'DummyQueuedPass77!',
        'FAKE_PRIVATE_KEY_BODY_999',
      ]

      const initMessage = [
        'senha: DummyInitPass1!',
        'key sk-proj-dummyOpenAiKey1234567890abcd',
      ].join('\n')
      for await (const _ of session.send(initMessage, { steering })) void _

      const queuedMessage = [
        'minha senha é DummyQueuedPass77!',
        '-----BEGIN RSA PRIVATE KEY-----',
        'FAKE_PRIVATE_KEY_BODY_999',
        '-----END RSA PRIVATE KEY-----',
      ].join('\n')
      for await (const _ of session.send(queuedMessage)) void _
      await session.settle()

      // 1. Model provider requests & embedding provider requests never saw raw secrets.
      const modelPayload = JSON.stringify(seenModelRequests)
      const embedPayload = JSON.stringify(seenEmbedBodies)
      expect(modelPayload).toContain(REDACTED_SECRET)
      expect(modelPayload).toContain(REDACTED_PRIVATE_KEY)
      expect(embedPayload).toContain(REDACTED_SECRET)

      // 2. Session file, daily history, TurnIndex, and traces.jsonl all exist, are 0600, and contain only masked text.
      const sessionJson = readFileSync(path.join(sessionsDir, `${record.id}.json`), 'utf8')
      const historyFile = path.join(historyDir, `${dayOf(new Date())}.jsonl`)
      const historyJsonl = readFileSync(historyFile, 'utf8')
      const tracesJsonl = readFileSync(tracesFile, 'utf8')

      expect(statSync(historyFile).mode & 0o777).toBe(0o600)
      expect(statSync(tracesFile).mode & 0o777).toBe(0o600)

      const turnIndex = new TurnIndex({ dir: historyDir })
      const recalled = await turnIndex.recall({ gateway: 'web', chatId: 'chat-e2e' }, 'senha')
      turnIndex.close()
      const recalledJson = JSON.stringify(recalled)

      for (const secret of secrets) {
        expect(modelPayload).not.toContain(secret)
        expect(embedPayload).not.toContain(secret)
        expect(sessionJson).not.toContain(secret)
        expect(historyJsonl).not.toContain(secret)
        expect(tracesJsonl).not.toContain(secret)
        expect(recalledJson).not.toContain(secret)
      }
      expect(tracesJsonl).toContain('"event":"embedding.request"')
      expect(tracesJsonl).toContain('"event":"model.request"')
    } finally {
      server.close()
    }
  })
})
