import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { tracesFile } from './config/paths.js'
import type { TraceEvent } from './traces.js'

export interface AnalyticsEvent {
  id: string
  at: string
  startedAt?: string
  event: string
  ok: boolean
  ms: number
  model?: string
  provider?: string
  purpose?: string
  surface?: string
  session?: string
  turn?: string
  callId?: string
  tool?: string
  inputTokens?: number
  outputTokens?: number
  ttftMs?: number
  finish?: string
  error?: string
}

export interface AnalyticsReport {
  events: AnalyticsEvent[]
  total: number
  requests: number
  embeddingRequests: number
  requestsWithUsage: number
  failures: number
  inputTokens: number
  outputTokens: number
  averageMs: number | null
  models: Array<{ model: string; requests: number; failures: number; inputTokens: number; outputTokens: number }>
}

export interface SessionTraceTurn {
  id: string
  index: number
  startedAt: string
  endedAt: string
  ms: number
  spanMs: number
  ok: boolean
  session?: string
  model?: string
  surface?: string
  requests: number
  toolCalls: number
  failures: number
  inputTokens: number
  outputTokens: number
  events: AnalyticsEvent[]
}

export interface AnalyticsTurnsReport {
  turns: SessionTraceTurn[]
  total: number
  totalEvents: number
  requests: number
  embeddingRequests: number
  requestsWithUsage: number
  failures: number
  inputTokens: number
  outputTokens: number
  averageMs: number | null
  models: AnalyticsReport['models']
}

export interface SessionTraceReport {
  session: string
  totalEvents: number
  turnsCount: number
  requests: number
  toolCalls: number
  failures: number
  inputTokens: number
  outputTokens: number
  totalMs: number
  models: AnalyticsReport['models']
  turns: SessionTraceTurn[]
}

async function readEvents(detailId?: string): Promise<Array<{ id: string; event: AnalyticsEvent; full?: TraceEvent }>> {
  const entries: Array<{ id: string; event: AnalyticsEvent; full?: TraceEvent }> = []
  const stream = createReadStream(tracesFile(), { encoding: 'utf8' })
  let index = 0
  let pending = ''
  const readLine = (line: string, complete: boolean): void => {
    index += 1
    if (!line.trim()) return
    let event: TraceEvent
    try {
      event = JSON.parse(line) as TraceEvent
    } catch {
      if (!complete) return // A crash can leave the last append incomplete.
      throw new Error(`Execution log contains invalid JSON on line ${index}.`)
    }
    if (!event || typeof event.at !== 'string' || typeof event.event !== 'string' || typeof event.ok !== 'boolean' || typeof event.ms !== 'number') throw new Error(`Execution log contains an invalid event on line ${index}.`)
    const id = typeof event.id === 'string' ? event.id : `legacy-${createHash('sha256').update(line).digest('hex')}`
    entries.push({ id, event: summary(id, event), ...(id === detailId ? { full: event } : {}) })
  }
  try {
    for await (const chunk of stream) {
      pending += chunk
      let newline = pending.indexOf('\n')
      while (newline !== -1) {
        readLine(pending.slice(0, newline).replace(/\r$/, ''), true)
        pending = pending.slice(newline + 1)
        newline = pending.indexOf('\n')
      }
    }
    if (pending) readLine(pending, false)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  } finally {
    stream.destroy()
  }
  return entries
}

function summary(id: string, event: TraceEvent): AnalyticsEvent {
  const { input: _input, output: _output, attachments: _attachments, id: _id, ...rest } = event
  return { ...rest, id } as AnalyticsEvent
}

function summarizeModels(events: AnalyticsEvent[]): AnalyticsReport['models'] {
  const byModel = new Map<string, AnalyticsReport['models'][number]>()
  for (const event of events) {
    if (event.event !== 'model.request') continue
    const model = typeof event.model === 'string' ? event.model : 'Unknown'
    const item = byModel.get(model) ?? { model, requests: 0, failures: 0, inputTokens: 0, outputTokens: 0 }
    item.requests += 1
    if (!event.ok) item.failures += 1
    if (typeof event.inputTokens === 'number') item.inputTokens += event.inputTokens
    if (typeof event.outputTokens === 'number') item.outputTokens += event.outputTokens
    byModel.set(model, item)
  }
  return [...byModel.values()].sort((a, b) => b.requests - a.requests || a.model.localeCompare(b.model))
}

function sumTokens(events: AnalyticsEvent[], key: 'inputTokens' | 'outputTokens'): number {
  return events.reduce((total, event) => total + (event.event === 'model.request' && typeof event[key] === 'number' ? event[key] : 0), 0)
}

function eventEndMs(event: AnalyticsEvent): number {
  const parsed = Date.parse(event.at)
  return Number.isFinite(parsed) ? parsed : 0
}

function eventStartMs(event: AnalyticsEvent): number {
  if (typeof event.startedAt === 'string') {
    const parsed = Date.parse(event.startedAt)
    if (Number.isFinite(parsed)) return parsed
  }
  const end = eventEndMs(event)
  return end > 0 ? end - Math.max(0, event.ms) : 0
}

function summarizeEvents(events: AnalyticsEvent[]): Omit<AnalyticsReport, 'events' | 'total'> {
  const requests = events.filter((event) => event.event === 'model.request')
  return {
    requests: requests.length,
    embeddingRequests: events.filter((event) => event.event === 'embedding.request').length,
    requestsWithUsage: requests.filter((event) => typeof event.inputTokens === 'number' && typeof event.outputTokens === 'number').length,
    failures: events.filter((event) => !event.ok).length,
    inputTokens: sumTokens(events, 'inputTokens'),
    outputTokens: sumTokens(events, 'outputTokens'),
    averageMs: requests.length ? requests.reduce((total, event) => total + event.ms, 0) / requests.length : null,
    models: summarizeModels(events),
  }
}

function groupTurns(events: AnalyticsEvent[]): SessionTraceTurn[] {
  const legacyWindows = events
    .filter((event) => event.event === 'turn' && !event.turn)
    .map((event) => ({
      id: `legacy-turn:${event.id}`,
      session: event.session,
      start: eventStartMs(event) - 1000,
      end: eventEndMs(event) + 1000,
    }))

  const groups = new Map<string, { id: string; items: AnalyticsEvent[] }>()
  for (const event of events) {
    let turnId = typeof event.turn === 'string' && event.turn ? event.turn : ''
    if (!turnId) {
      const start = eventStartMs(event)
      const end = eventEndMs(event)
      const match = legacyWindows.find((win) => win.session === event.session && start >= win.start && end <= win.end)
      turnId = match ? match.id : `event:${event.id}`
    }
    const key = event.session ? `${event.session}\0${turnId}` : `\0${turnId}`
    const existing = groups.get(key)
    if (existing) existing.items.push(event)
    else groups.set(key, { id: turnId, items: [event] })
  }

  const orderedGroups = [...groups.values()].map(({ id, items }) => {
    const sorted = [...items].sort((a, b) => {
      const startDiff = eventStartMs(a) - eventStartMs(b)
      if (startDiff !== 0) return startDiff
      // Put the wrapping 'turn' summary event first when timestamps tie.
      if (a.event === 'turn' && b.event !== 'turn') return -1
      if (b.event === 'turn' && a.event !== 'turn') return 1
      return eventEndMs(a) - eventEndMs(b)
    })
    const turnEvent = sorted.find((item) => item.event === 'turn')
    const minStart = Math.min(...sorted.map(eventStartMs))
    const maxEnd = Math.max(...sorted.map(eventEndMs))
    const spanMs = Math.max(0, maxEnd - minStart)
    const session = turnEvent?.session ?? sorted.find((item) => typeof item.session === 'string')?.session
    return {
      id,
      session,
      minStart,
      maxEnd,
      spanMs,
      turnEvent,
      sorted,
    }
  }).sort((a, b) => a.minStart - b.minStart || a.maxEnd - b.maxEnd)

  const sessionIndices = new Map<string, number>()
  return orderedGroups.map((group) => {
    const sessionKey = group.session ?? ''
    const index = (sessionIndices.get(sessionKey) ?? 0) + 1
    sessionIndices.set(sessionKey, index)
    const requests = group.sorted.filter((item) => item.event === 'model.request')
    const toolCalls = group.sorted.filter((item) => item.event === 'tool.call').length
    const failures = group.sorted.filter((item) => !item.ok).length
    const model = group.turnEvent?.model ?? requests.find((item) => typeof item.model === 'string')?.model
    const surface = group.turnEvent?.surface ?? group.sorted.find((item) => typeof item.surface === 'string')?.surface
    return {
      id: group.id,
      index,
      startedAt: new Date(group.minStart).toISOString(),
      endedAt: new Date(group.maxEnd).toISOString(),
      ms: group.turnEvent ? group.turnEvent.ms : group.spanMs,
      spanMs: Math.max(group.spanMs, group.turnEvent?.ms ?? 0),
      ok: group.turnEvent ? group.turnEvent.ok && failures === 0 : failures === 0,
      ...(group.session ? { session: group.session } : {}),
      ...(model ? { model } : {}),
      ...(surface ? { surface } : {}),
      requests: requests.length,
      toolCalls,
      failures,
      inputTokens: sumTokens(group.sorted, 'inputTokens'),
      outputTokens: sumTokens(group.sorted, 'outputTokens'),
      events: group.sorted,
    }
  }).reverse()
}

export async function analyticsReport(options: { query?: string; event?: string; session?: string; offset?: number; limit?: number; days?: number } = {}): Promise<AnalyticsReport> {
  const query = options.query?.trim().toLowerCase() ?? ''
  const session = options.session?.trim() ?? ''
  const since = options.days ? Date.now() - options.days * 86_400_000 : 0
  const entries = (await readEvents()).filter(({ event: item }) => {
    return (!since || Date.parse(item.at) >= since)
      && (!session || item.session === session)
      && (!options.event || options.event === 'all' || item.event === options.event)
      && (!query || JSON.stringify(item).toLowerCase().includes(query))
  }).reverse()
  const allEvents = entries.map(({ event }) => event)
  const offset = Math.max(0, Math.floor(options.offset ?? 0))
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 30)))
  return {
    events: allEvents.slice(offset, offset + limit),
    total: entries.length,
    ...summarizeEvents(allEvents),
  }
}

export async function analyticsTurns(options: { query?: string; event?: string; session?: string; offset?: number; limit?: number; days?: number } = {}): Promise<AnalyticsTurnsReport> {
  const query = options.query?.trim().toLowerCase() ?? ''
  const session = options.session?.trim() ?? ''
  const since = options.days ? Date.now() - options.days * 86_400_000 : 0
  const events = (await readEvents())
    .map(({ event }) => event)
    .filter((event) => !session || event.session === session)

  const turns = groupTurns(events).filter((turn) => {
    if (since && Date.parse(turn.endedAt) < since) return false
    if (options.event && options.event !== 'all' && !turn.events.some((item) => item.event === options.event)) return false
    if (!query) return true
    return (turn.session?.toLowerCase().includes(query) ?? false)
      || (turn.model?.toLowerCase().includes(query) ?? false)
      || (turn.surface?.toLowerCase().includes(query) ?? false)
      || turn.events.some((item) => JSON.stringify(item).toLowerCase().includes(query))
  })

  const matchingEvents = turns.flatMap((turn) => turn.events)
  const offset = Math.max(0, Math.floor(options.offset ?? 0))
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 30)))
  return {
    turns: turns.slice(offset, offset + limit),
    total: turns.length,
    totalEvents: matchingEvents.length,
    ...summarizeEvents(matchingEvents),
  }
}

export async function sessionTraces(sessionId: string): Promise<SessionTraceReport> {
  const session = sessionId.trim()
  if (!session) {
    return {
      session: '',
      totalEvents: 0,
      turnsCount: 0,
      requests: 0,
      toolCalls: 0,
      failures: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalMs: 0,
      models: [],
      turns: [],
    }
  }

  const events = (await readEvents())
    .map(({ event }) => event)
    .filter((event) => event.session === session)

  const turns = groupTurns(events)

  return {
    session,
    totalEvents: events.length,
    turnsCount: turns.length,
    requests: events.filter((event) => event.event === 'model.request').length,
    toolCalls: events.filter((event) => event.event === 'tool.call').length,
    failures: events.filter((event) => !event.ok).length,
    inputTokens: sumTokens(events, 'inputTokens'),
    outputTokens: sumTokens(events, 'outputTokens'),
    totalMs: turns.reduce((total, turn) => total + turn.ms, 0),
    models: summarizeModels(events),
    turns,
  }
}

export async function analyticsDetail(id: string): Promise<{ event: TraceEvent; related: Array<{ id: string; event: AnalyticsEvent }> }> {
  const entries = await readEvents(id)
  const found = entries.find((entry) => entry.id === id)
  if (!found?.full) throw new Error('This trace is no longer in the execution log. Refresh the list.')
  const turn = found.event.turn
  if (typeof turn === 'string') {
    return {
      event: found.full,
      related: entries.filter((entry) => entry.event.turn === turn && entry.id !== id).map((entry) => ({ id: entry.id, event: entry.event })),
    }
  }
  if (found.event.event === 'turn' && typeof found.event.session === 'string') {
    const winStart = eventStartMs(found.event) - 1000
    const winEnd = eventEndMs(found.event) + 1000
    return {
      event: found.full,
      related: entries
        .filter((entry) =>
          entry.id !== id
          && !entry.event.turn
          && entry.event.session === found.event.session
          && eventStartMs(entry.event) >= winStart
          && eventEndMs(entry.event) <= winEnd,
        )
        .map((entry) => ({ id: entry.id, event: entry.event })),
    }
  }
  return { event: found.full, related: [] }
}
