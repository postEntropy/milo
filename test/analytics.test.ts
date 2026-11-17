import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

const home = mkdtempSync(path.join(os.tmpdir(), 'milo-analytics-'))
process.env.MILO_HOME = home
const { fileTraces } = await import('../src/core/traces.js')
const { analyticsDetail, analyticsReport, sessionTraces } = await import('../src/core/analytics.js')
const file = path.join(home, 'traces.jsonl')

beforeEach(() => rmSync(file, { force: true }))

describe('analytics', () => {
  it('filters and paginates event summaries while counting matching requests', async () => {
    const at = new Date().toISOString()
    fileTraces.record({ id: 'one', at, event: 'model.request', ok: true, ms: 100, model: 'model-a', turn: 'turn-a', inputTokens: 50, outputTokens: 10, input: { system: 'private' } })
    fileTraces.record({ id: 'two', at, event: 'model.request', ok: false, ms: 300, model: 'model-a', turn: 'turn-a', inputTokens: 30, outputTokens: 4 })
    fileTraces.record({ at, event: 'tool.call', ok: true, ms: 40, tool: 'read_file', turn: 'turn-a', output: 'contents' })
    const page = await analyticsReport({ query: 'model-a', event: 'model.request', limit: 1, offset: 1, days: 1 })
    expect(page).toMatchObject({ total: 2, requests: 2, requestsWithUsage: 2, failures: 1, inputTokens: 80, outputTokens: 14, averageMs: 200 })
    expect(page.models).toEqual([{ model: 'model-a', requests: 2, failures: 1, inputTokens: 80, outputTokens: 14 }])
    expect(page.events).toHaveLength(1)
    expect(page.events[0]).toMatchObject({ id: 'one' })
    expect(page.events[0]).not.toHaveProperty('input')
    const detail = await analyticsDetail('one')
    expect(detail.event.input).toEqual({ system: 'private' })
    expect(detail.related).toHaveLength(2)
    expect(detail.related[1]!.event).not.toHaveProperty('output')
  })

  it('keeps old events readable and detects a damaged log', async () => {
    expect((await analyticsReport()).total).toBe(0)
    writeFileSync(file, `${JSON.stringify({ at: '2020-01-01T00:00:00.000Z', event: 'turn', ok: true, ms: 10 })}\n`)
    const event = (await analyticsReport()).events[0]!
    expect((await analyticsDetail(event.id)).event.event).toBe('turn')
    expect((await analyticsReport({ days: 1 })).total).toBe(0)
    writeFileSync(file, `${JSON.stringify({ at: '2020-01-01T00:00:00.000Z', event: 'turn', ok: true, ms: 10 })}\n{partial`)
    expect((await analyticsReport()).total).toBe(1)
    writeFileSync(file, '{bad}\n')
    await expect(analyticsReport()).rejects.toThrow('invalid JSON')
  })

  it('groups session traces into chronological turn timelines', async () => {
    const t0 = Date.parse('2026-11-16T12:00:00.000Z')
    const iso = (offsetMs: number) => new Date(t0 + offsetMs).toISOString()
    fileTraces.record({ id: 'req-1', session: 'sess-1', turn: 'turn-1', event: 'model.request', ok: true, startedAt: iso(0), at: iso(400), ms: 400, ttftMs: 120, model: 'model-a', inputTokens: 100, outputTokens: 20 })
    fileTraces.record({ id: 'tool-1', session: 'sess-1', turn: 'turn-1', event: 'tool.call', ok: true, startedAt: iso(410), at: iso(610), ms: 200, tool: 'read_file', callId: 'call-1' })
    fileTraces.record({ id: 'cls-1', session: 'sess-1', turn: 'turn-1', event: 'classifier.request', ok: true, startedAt: iso(450), at: iso(550), ms: 100, callId: 'call-1', purpose: 'classifier' })
    fileTraces.record({ id: 'turn-1-ev', session: 'sess-1', turn: 'turn-1', event: 'turn', ok: true, startedAt: iso(0), at: iso(700), ms: 700, model: 'model-a', surface: 'web' })
    fileTraces.record({ id: 'turn-2-req', session: 'sess-1', turn: 'turn-2', event: 'model.request', ok: false, startedAt: iso(5000), at: iso(5300), ms: 300, model: 'model-b', error: 'rate limit' })
    fileTraces.record({ id: 'other', session: 'sess-2', turn: 'turn-x', event: 'model.request', ok: true, startedAt: iso(100), at: iso(200), ms: 100, model: 'model-a' })

    const report = await sessionTraces('sess-1')
    expect(report).toMatchObject({
      session: 'sess-1',
      totalEvents: 5,
      turnsCount: 2,
      requests: 2,
      toolCalls: 1,
      failures: 1,
      inputTokens: 100,
      outputTokens: 20,
      totalMs: 1000,
    })
    expect(report.turns.map((turn) => turn.index)).toEqual([2, 1])
    expect(report.turns[0]).toMatchObject({ id: 'turn-2', ok: false, failures: 1 })
    expect(report.turns[1]!.events.map((event) => event.id)).toEqual(['turn-1-ev', 'req-1', 'tool-1', 'cls-1'])

    const filtered = await analyticsReport({ session: 'sess-2' })
    expect(filtered.total).toBe(1)
    expect(filtered.events[0]?.id).toBe('other')
  })

  it('groups legacy traces without turn IDs using turn time windows', async () => {
    const t0 = Date.parse('2026-11-16T09:35:17.000Z')
    const iso = (offsetMs: number) => new Date(t0 + offsetMs).toISOString()
    fileTraces.record({ id: 'old-req', session: 'legacy-1', event: 'model.request', ok: true, at: iso(2000), ms: 2000, model: 'gpt-6.1-terra' })
    fileTraces.record({ id: 'old-tool', session: 'legacy-1', event: 'tool.call', ok: true, at: iso(2050), ms: 50, tool: 'read_skill' })
    fileTraces.record({ id: 'old-turn', session: 'legacy-1', event: 'turn', ok: true, at: iso(2100), ms: 2100, model: 'gpt-6.1-terra' })

    const report = await sessionTraces('legacy-1')
    expect(report.turnsCount).toBe(1)
    expect(report.turns[0]?.events.map((item) => item.id)).toEqual(['old-turn', 'old-req', 'old-tool'])

    const detail = await analyticsDetail('old-turn')
    expect(detail.related.map((item) => item.id)).toEqual(['old-req', 'old-tool'])
  })
})

it('serves full details only through the authenticated analytics API', async () => {
  const { startWebServer } = await import('../src/gateways/web/http.js')
  const { TracedProvider } = await import('../src/core/traces.js')
  const provider = new TracedProvider({ id: 'test', async *stream() {
    yield { type: 'text' as const, delta: 'answer' }
    yield { type: 'done' as const, finishReason: 'stop' as const }
  } }, fileTraces)
  for await (const _ of provider.stream({ model: 'test-model', system: 'instructions', messages: [], trace: { purpose: 'chat', session: 'sess-api', turn: 'turn-api' } })) void _
  const runtime = { onSessionsChanged: () => () => {}, onWorkChanged: () => () => {}, onSessionFolderChanged: () => () => {} } as never
  const server = await startWebServer({ runtime, cwd: home, host: '127.0.0.1', port: 0, token: 'test-token' })
  try {
    const address = new URL(server.url)
    const call = (action: string, token: string, body: object) => fetch(`${address.origin}/api/${action}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    expect((await call('analytics-detail', 'wrong', { id: 'request-1' })).status).toBe(401)
    expect((await call('session-traces', 'wrong', { session: 'sess-api' })).status).toBe(401)
    const list = await (await call('analytics', 'test-token', {})).json() as { events: Array<{ id: string }> }
    expect(list.events[0]).not.toHaveProperty('input')
    const detail = await (await call('analytics-detail', 'test-token', { id: list.events[0]!.id })).json() as { event: Record<string, unknown> }
    expect(detail.event).toMatchObject({ input: { system: 'instructions' }, output: expect.arrayContaining([{ type: 'text', delta: 'answer' }]) })
    const sessionReport = await (await call('session-traces', 'test-token', { session: 'sess-api' })).json() as { session: string; turnsCount: number }
    expect(sessionReport).toMatchObject({ session: 'sess-api', turnsCount: 1 })
  } finally {
    await server.stop()
  }
})
