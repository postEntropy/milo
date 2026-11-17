import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const home = mkdtempSync(path.join(os.tmpdir(), 'milo-traces-'))
process.env.MILO_HOME = home

const { fileTraces, followTraces, TracedProvider, readTraces, traceStatus, trimTraces } = await import(
  '../src/core/traces.js'
)
const { withTraceContext } = await import('../src/core/trace-context.js')
const { DANGER_QUESTION, Classifier } = await import('../src/core/classifier/index.js')
const { runLog } = await import('../src/bin/log.js')
type StreamEvent = import('../src/core/providers/types.js').StreamEvent

const file = path.join(home, 'traces.jsonl')
const at = (day: string) => `${day}T00:00:00.000Z`

beforeEach(() => {
  rmSync(file, { force: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the execution log on disk', () => {
  it('appends one JSONL line per event and reads them back newest-last', () => {
    fileTraces.record({ at: at('2026-10-07'), event: 'turn', ok: true, ms: 5, surface: 'cli' })
    fileTraces.record({ at: at('2026-10-08'), event: 'tool.call', ok: true, ms: 1, tool: 'read_file' })

    expect(traceStatus()).toMatchObject({ events: 2, oldest: at('2026-10-07'), newest: at('2026-10-08') })
    expect(readTraces({ limit: 1 })).toEqual([expect.objectContaining({ event: 'tool.call', tool: 'read_file' })])
    expect(readTraces().map((event) => event.event)).toEqual(['turn', 'tool.call'])
  })

  it('reads older events that have no request content', () => {
    writeFileSync(file, `${JSON.stringify({ at: at('2026-10-07'), event: 'model.request', ok: true, ms: 10, model: 'm', purpose: 'chat' })}\n`)
    const [event] = readTraces()
    expect(Object.keys(event!).sort()).toEqual(['at', 'event', 'model', 'ms', 'ok', 'purpose'])
  })

  it('drops the events from before a day, and keeps the rest', () => {
    fileTraces.record({ at: at('2026-01-01'), event: 'turn', ok: true, ms: 1 })
    fileTraces.record({ at: at('2026-06-01'), event: 'turn', ok: true, ms: 1 })

    expect(trimTraces('2026-03-01')).toBe(1)
    expect(readTraces().map((event) => event.at)).toEqual([at('2026-06-01')])
    expect(trimTraces('2026-03-01')).toBe(0)
  })

  it('reports and trims from the command', async () => {
    fileTraces.record({ at: at('2026-01-01'), event: 'turn', ok: true, ms: 1 })
    fileTraces.record({ at: at('2026-06-01'), event: 'model.request', ok: true, ms: 9, model: 'm' })

    const lines: string[] = []
    const code = await runLog(['log', 'status'], { out: (line) => lines.push(line), err: () => {}, confirm: async () => true })
    expect(code).toBe(0)
    expect(lines.join('\n')).toContain('2 event(s)')
    expect(lines.join('\n')).toContain('1 × model.request')

    const tailed: string[] = []
    await runLog(['log', 'tail', '1'], { out: (line) => tailed.push(line), err: () => {}, confirm: async () => true })
    expect(JSON.parse(tailed[0]!)).toMatchObject({ event: 'model.request' })

    const trimmed: string[] = []
    await runLog(['log', 'trim', '--before', '2026-03-01', '--yes'], { out: (line) => trimmed.push(line), err: () => {}, confirm: async () => true })
    expect(trimmed.join('\n')).toContain('Dropped 1 event(s)')
    expect(readTraces()).toHaveLength(1)
  })
})

describe('TracedProvider', () => {
  it('times a request and names its purpose, surface and cost', async () => {
    const seen: Record<string, unknown>[] = []
    const inner = {
      id: 'deepseek',
      async *stream(): AsyncGenerator<StreamEvent> {
        yield { type: 'reasoning', delta: 'think' }
        yield { type: 'text', delta: 'hi' }
        yield { type: 'usage', inputTokens: 10, outputTokens: 3, cachedInputTokens: 4, reasoningTokens: 1 }
        yield { type: 'done', finishReason: 'stop' }
      },
    }
    const provider = new TracedProvider(inner, { record: (entry) => seen.push(entry) })

    const events = []
    for await (const event of provider.stream({
      model: 'deepseek-v4.1-flash',
      messages: [],
      trace: { purpose: 'chat', surface: 'cli', session: 'calm-otter-7' },
    })) {
      events.push(event)
    }

    expect(events).toHaveLength(4)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      event: 'model.request',
      ok: true,
      purpose: 'chat',
      surface: 'cli',
      session: 'calm-otter-7',
      model: 'deepseek-v4.1-flash',
      provider: 'deepseek',
      inputTokens: 10,
      outputTokens: 3,
      cachedInputTokens: 4,
      reasoningTokens: 1,
      finish: 'stop',
    })
    expect(seen[0]).toMatchObject({ input: { model: 'deepseek-v4.1-flash', messages: [] }, output: expect.arrayContaining([{ type: 'reasoning', delta: 'think' }, { type: 'text', delta: 'hi' }]) })
    expect(typeof seen[0]!.ms).toBe('number')
    expect(typeof seen[0]!.ttftMs).toBe('number')
  })

  it('keeps the request and its attachment as they were when the call began', async () => {
    const attachment = path.join(home, 'photo.png')
    writeFileSync(attachment, Buffer.from('picture'))
    const seen: Record<string, unknown>[] = []
    const provider = new TracedProvider({
      id: 'test',
      async *stream(): AsyncGenerator<StreamEvent> {
        yield { type: 'text', delta: 'one' }
        yield { type: 'text', delta: ' two' }
        yield { type: 'done', finishReason: 'stop' }
      },
    }, { record: (entry) => seen.push(entry) })
    const messages: import('../src/core/providers/types.js').Message[] = [{ role: 'user', content: [{ type: 'image', mimeType: 'image/png', path: attachment, name: 'photo.png' }] }]
    for await (const _ of provider.stream({ model: 'm', messages })) {
      messages.push({ role: 'assistant', content: [{ type: 'text', text: 'later' }] })
      rmSync(attachment, { force: true })
    }
    expect(seen[0]).toMatchObject({
      input: { messages: [{ role: 'user' }] },
      attachments: [{ path: attachment, data: Buffer.from('picture').toString('base64') }],
      output: [{ type: 'text', delta: 'one two' }, { type: 'done', finishReason: 'stop' }],
    })
    expect(seen[0]).not.toHaveProperty('inputTokens')
  })

  it('links a background model request to the turn that started it', async () => {
    const seen: Record<string, unknown>[] = []
    const provider = new TracedProvider({ id: 'test', async *stream(): AsyncGenerator<StreamEvent> {
      yield { type: 'done', finishReason: 'stop' }
    } }, { record: (entry) => seen.push(entry) })
    await withTraceContext({ turn: 'turn-1', session: 'calm-otter-7', surface: 'web' }, async () => {
      for await (const _ of provider.stream({ model: 'm', messages: [], trace: { purpose: 'derive' } })) void _
    })
    expect(seen[0]).toMatchObject({ purpose: 'derive', turn: 'turn-1', session: 'calm-otter-7', surface: 'web' })
  })

  it('records a stream closed early as cancelled with its partial output', async () => {
    const seen: Record<string, unknown>[] = []
    const provider = new TracedProvider({ id: 'test', async *stream(): AsyncGenerator<StreamEvent> {
      yield { type: 'text', delta: 'partial' }
      yield { type: 'text', delta: 'unseen' }
    } }, { record: (entry) => seen.push(entry) })
    for await (const _ of provider.stream({ model: 'm', messages: [] })) break
    expect(seen[0]).toMatchObject({ ok: false, error: 'Request cancelled.', output: [{ type: 'text', delta: 'partial' }] })
  })

  it('records a request that failed as failed, and still throws', async () => {
    const seen: Record<string, unknown>[] = []
    const inner = {
      id: 'x',
      stream(): AsyncIterable<never> {
        return {
          [Symbol.asyncIterator]: () => ({
            next: async (): Promise<IteratorResult<never>> => {
              throw new Error('boom')
            },
          }),
        }
      },
    }
    const provider = new TracedProvider(inner, { record: (entry) => seen.push(entry) })

    await expect(
      (async () => {
        for await (const _ of provider.stream({ model: 'm', messages: [] })) void _
      })(),
    ).rejects.toThrow('boom')

    expect(seen[0]).toMatchObject({ event: 'model.request', ok: false, error: 'boom', purpose: 'chat' })
  })
})

describe('following the log', () => {
  it('prints the backlog, then each new event as it lands', async () => {
    fileTraces.record({ at: at('2026-06-01'), event: 'turn', ok: true, ms: 1 })
    const lines: string[] = []
    const controller = new AbortController()
    const running = followTraces({
      out: (line) => lines.push(line),
      backlog: 1,
      intervalMs: 5,
      signal: controller.signal,
    })

    await vi.waitFor(() => expect(lines).toHaveLength(1))

    fileTraces.record({ at: at('2026-06-02'), event: 'tool.call', ok: true, ms: 2, tool: 'read_file' })
    await vi.waitFor(() => expect(lines).toHaveLength(2))

    controller.abort()
    await running
    expect(lines.map((line) => JSON.parse(line).event)).toEqual(['turn', 'tool.call'])
  })

  it('stops when the signal aborts', async () => {
    const controller = new AbortController()
    const running = followTraces({ out: () => {}, intervalMs: 5, signal: controller.signal })
    controller.abort()
    await expect(running).resolves.toBeUndefined()
  })
})

describe('the classifier in the log', () => {
  it('records each request with its purpose, backend and cache state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ answers: { dangerous: { noul: 0.5 } } }), { status: 200 })),
    )
    const seen: Record<string, unknown>[] = []
    const classifier = new Classifier({
      baseURL: 'https://x.test/v1',
      model: 'typesafe/jev-latest',
      backend: 'openrouter',
      traces: { record: (entry) => seen.push(entry) },
    })

    const questions = { dangerous: DANGER_QUESTION }
    await withTraceContext({ turn: 'turn-1', session: 'calm-otter-7', surface: 'cli', callId: 'call-1' }, () => classifier.ask('rm -rf /', questions, { purpose: 'danger' }))
    await classifier.ask('rm -rf /', questions, { purpose: 'danger' })

    expect(seen[0]).toMatchObject({
      event: 'classifier.request',
      ok: true,
      purpose: 'danger',
      turn: 'turn-1',
      session: 'calm-otter-7',
      callId: 'call-1',
      backend: 'openrouter',
      model: 'typesafe/jev-latest',
      cached: false,
      answers: { dangerous: { noul: 0.5 } },
      input: { state: 'rm -rf /', questions },
      output: { dangerous: { noul: 0.5 } },
    })
    expect(seen[1]).toMatchObject({ cached: true, ms: 0 })
    expect(seen[1]).not.toHaveProperty('turn')
  })
})
