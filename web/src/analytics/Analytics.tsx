import { useEffect, useState } from 'react'
import type { AnalyticsEvent, AnalyticsReport, SessionTraceReport, SessionTraceTurn } from '../../../src/core/analytics.js'
import { api } from '../lib/api.js'
import { message } from '../lib/format.js'
import { PageHeader } from '../ui/PageHeader.js'

export interface AnalyticsSessionTarget {
  id: string
  label: string
}

type Detail = { event: Record<string, unknown>; related: Array<{ id: string; event: Record<string, unknown> }> }
const number = (value: number) => new Intl.NumberFormat().format(value)
const duration = (ms: number) => ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`
const EVENT_LABELS: Record<string, string> = {
  'model.request': 'Model request',
  'embedding.request': 'Embedding request',
  'tool.call': 'Tool call',
  turn: 'Turn',
  'classifier.request': 'Classifier request',
  verification: 'Verification',
}
const eventLabel = (kind: string) => EVENT_LABELS[kind] ?? kind
const title = (event: Pick<AnalyticsEvent, 'event' | 'tool' | 'purpose'>) => {
  if (event.tool) return event.tool
  if (event.purpose) {
    const clean = event.purpose.replace(/[_-]+/g, ' ')
    const labeled = clean.charAt(0).toUpperCase() + clean.slice(1)
    if (event.event === 'model.request') return `${labeled} request`
    if (event.event === 'embedding.request') return `${labeled} embedding`
    return labeled
  }
  return eventLabel(event.event)
}
const labels: Record<string, string> = { id: 'ID', ok: 'Status', ms: 'Duration', ttftMs: 'First token', inputTokens: 'Input tokens', outputTokens: 'Output tokens', cachedInputTokens: 'Cached input tokens', cacheWriteTokens: 'Cache write tokens', reasoningTokens: 'Reasoning tokens', callId: 'Tool call ID' }
const fieldValue = (key: string, value: unknown) => key === 'ok' ? (value ? 'Succeeded' : 'Failed') : (key === 'ms' || key === 'ttftMs') && typeof value === 'number' ? duration(value) : pretty(value)
const pretty = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value, null, 2)

function eventStart(event: Pick<AnalyticsEvent, 'at' | 'startedAt' | 'ms'>): number {
  if (event.startedAt) {
    const parsed = Date.parse(event.startedAt)
    if (Number.isFinite(parsed)) return parsed
  }
  const end = Date.parse(event.at)
  return Number.isFinite(end) ? end - Math.max(0, event.ms) : 0
}

function turnSteps(turn: SessionTraceTurn): AnalyticsEvent[] {
  const nonTurn = turn.events.filter((item) => item.event !== 'turn')
  return nonTurn.length > 0 ? nonTurn : turn.events
}

export function Analytics({
  session = null,
  onSessionChange,
}: {
  session?: AnalyticsSessionTarget | null
  onSessionChange?: (next: AnalyticsSessionTarget | null) => void
} = {}) {
  const [report, setReport] = useState<AnalyticsReport | null>(null)
  const [sessionReport, setSessionReport] = useState<SessionTraceReport | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [event, setEvent] = useState('all')
  const [days, setDays] = useState('0')
  const [offset, setOffset] = useState(0)
  const [refresh, setRefresh] = useState(0)
  const [error, setError] = useState('')
  const [attachmentsOpen, setAttachmentsOpen] = useState(false)
  const [ascending, setAscending] = useState(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh explicitly reloads the report
  useEffect(() => {
    let active = true
    if (session) {
      setSessionReport(null)
      api<SessionTraceReport>('session-traces', { session: session.id }).then((value) => {
        if (!active) return
        setSessionReport(value)
        setError('')
        const firstStep = value.turns[0] ? turnSteps(value.turns[0])[0] : undefined
        setSelected((current) => current && value.turns.some((turn) => turn.events.some((item) => item.id === current)) ? current : (firstStep?.id ?? null))
      }).catch((reason: unknown) => { if (active) setError(message(reason)) })
      return () => { active = false }
    }
    api<AnalyticsReport>('analytics', { query, event, days: Number(days), offset }).then((value) => {
      if (active) { setReport(value); setError('') }
    }).catch((reason: unknown) => { if (active) setError(message(reason)) })
    return () => { active = false }
  }, [session?.id, query, event, days, offset, refresh])
  useEffect(() => {
    if (!selected) { setDetail(null); return }
    let active = true
    setDetail(null)
    setAttachmentsOpen(false)
    api<Detail>('analytics-detail', { id: selected }).then((value) => { if (active) { setDetail(value); setError('') } })
      .catch((reason: unknown) => { if (active) setError(message(reason)) })
    return () => { active = false }
  }, [selected])
  const update = (action: () => void) => { setOffset(0); action() }
  const openSessionTraces = (id: string, label?: string) => {
    setSelected(null)
    onSessionChange?.({ id, label: label || id })
  }
  const orderedTurns = sessionReport ? (ascending ? [...sessionReport.turns].reverse() : sessionReport.turns) : []
  return <main className="settings-workspace"><div className="settings-inner analytics">
    <PageHeader
      title={session ? `Traces · ${session.label}` : 'Analytics'}
      description={session ? `Execution timeline for Session ${session.id}.` : 'Requests, tools and turns across Milo.'}
      action={<div className="analytics-header-actions">
        {session && <button className="analytics-button" type="button" onClick={() => setAscending((prev) => !prev)}>{ascending ? 'Oldest first' : 'Newest first'}</button>}
        {session && onSessionChange && <button className="analytics-button" type="button" onClick={() => { setSelected(null); onSessionChange(null) }}>All traces</button>}
        <button className="analytics-button" type="button" onClick={() => setRefresh((n) => n + 1)}>Refresh</button>
      </div>}
    />
    {error && <p className="analytics-error" role="alert">{error}</p>}
    {session ? sessionReport && <div className="analytics-stats">
      <div><span>Turns</span><strong>{number(sessionReport.turnsCount)}</strong></div>
      <div><span>Model requests</span><strong>{number(sessionReport.requests)}</strong></div>
      <div><span>Tool calls</span><strong>{number(sessionReport.toolCalls)}</strong></div>
      <div><span>Input tokens</span><strong>{number(sessionReport.inputTokens)}</strong></div>
      <div><span>Output tokens</span><strong>{number(sessionReport.outputTokens)}</strong></div>
      <div><span>Total duration</span><strong>{duration(sessionReport.totalMs)}</strong></div>
      <div><span>Failed events</span><strong>{number(sessionReport.failures)}</strong></div>
    </div> : <>
      {report && <div className="analytics-stats">
        <div><span>Model requests</span><strong>{number(report.requests)}</strong></div>
        {report.embeddingRequests > 0 && <div><span>Embedding requests</span><strong>{number(report.embeddingRequests)}</strong></div>}
        <div><span>Input tokens</span><strong>{number(report.inputTokens)}</strong></div>
        <div><span>Output tokens</span><strong>{number(report.outputTokens)}</strong></div>
        <div><span>Average request</span><strong>{report.averageMs === null ? '—' : duration(report.averageMs)}</strong></div>
        <div><span>Failed events</span><strong>{number(report.failures)}</strong></div>
      </div>}
      {report && report.requestsWithUsage < report.requests && <p className="analytics-usage-note">Token counts are available for {number(report.requestsWithUsage)} of {number(report.requests)} requests.</p>}
      {report && report.models.length > 0 && <section className="analytics-models" aria-label="Models">
        <h3>Models</h3>
        <div>{report.models.map((model) => <button type="button" className="analytics-model" key={model.model} onClick={() => update(() => setQuery(model.model))}>
          <strong>{model.model}</strong><span>{number(model.requests)} requests · {number(model.inputTokens)} input · {number(model.outputTokens)} output{model.failures ? ` · ${number(model.failures)} failed` : ''}</span>
        </button>)}</div>
      </section>}
      <div className="analytics-filters">
        <input aria-label="Search traces" placeholder="Search model, Session or tool" value={query} onChange={(e) => update(() => setQuery(e.target.value))} />
        <select aria-label="Event type" value={event} onChange={(e) => update(() => setEvent(e.target.value))}>
          <option value="all">All events</option><option value="model.request">Model requests</option><option value="embedding.request">Embedding requests</option><option value="tool.call">Tool calls</option><option value="turn">Turns</option><option value="classifier.request">Classifier requests</option><option value="verification">Verification</option>
        </select>
        <select aria-label="Period" value={days} onChange={(e) => update(() => setDays(e.target.value))}>
          <option value="0">All time</option><option value="1">Last 24 hours</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option>
        </select>
      </div>
    </>}
    <div className="analytics-layout">
      <section aria-label={session ? 'Session turn timeline' : 'Trace history'} className="analytics-list">
        {session ? <>
          {!sessionReport && !error && <p>Loading session traces…</p>}
          {sessionReport?.turns.length === 0 && <p>No traces recorded for this Session yet.</p>}
          {orderedTurns.map((turn) => {
            const turnOrigin = Date.parse(turn.startedAt)
            const span = Math.max(1, turn.spanMs || turn.ms || 1)
            const steps = turnSteps(turn)
            const toolCallIds = new Set(steps.filter((item) => item.event === 'tool.call' && item.callId).map((item) => item.callId!))
            const turnSummaryEvent = turn.events.find((item) => item.event === 'turn')
            return <div className="analytics-turn-card" key={turn.id}>
              <div className="analytics-turn-head">
                <div>
                  <div className="analytics-turn-title">Turn {turn.index}</div>
                  <div className="analytics-turn-sub">{new Date(turn.startedAt).toLocaleString()} · {duration(turn.ms)}{turn.inputTokens || turn.outputTokens ? ` · ${number(turn.inputTokens)} in / ${number(turn.outputTokens)} out` : ''}</div>
                </div>
                <div className="analytics-turn-meta">
                  {!turn.ok && <span className="analytics-pill danger">Failed</span>}
                  {turnSummaryEvent && <button type="button" className={`analytics-pill-button ${selected === turnSummaryEvent.id ? 'selected' : ''}`} onClick={() => setSelected(turnSummaryEvent.id)}>Inspect turn</button>}
                </div>
              </div>
              <div className="analytics-timeline">
                <div className="analytics-timeline-legend">
                  <span>Chronological · Start → End</span>
                  <span>{steps.length} {steps.length === 1 ? 'step' : 'steps'}</span>
                </div>
                {steps.map((item, idx) => {
                  const start = eventStart(item)
                  const offsetMs = Math.max(0, start - turnOrigin)
                  const leftPct = Math.max(0, Math.min(96, (offsetMs / span) * 100))
                  const widthPct = Math.max(2, Math.min(100 - leftPct, (Math.max(0, item.ms) / span) * 100))
                  const ttftPct = item.event === 'model.request' && typeof item.ttftMs === 'number' && item.ms > 0
                    ? Math.max(0, Math.min(100, (item.ttftMs / item.ms) * 100))
                    : 0
                  const nested = item.event !== 'tool.call' && Boolean(item.callId && toolCallIds.has(item.callId))
                  return <button type="button" className={`analytics-timeline-step ${nested ? 'nested' : ''} ${selected === item.id ? 'selected' : ''}`} key={item.id} onClick={() => setSelected(item.id)}>
                    <div className="analytics-timeline-top">
                      <span className={`analytics-dot ${item.ok ? 'ok' : 'fail'}`} />
                      <span className="analytics-step-index">#{idx + 1}</span>
                      <span className="analytics-step-title">{title(item)}</span>
                      <span className="analytics-pill">{eventLabel(item.event)}</span>
                      <span className="analytics-step-ms">{duration(item.ms)}</span>
                    </div>
                    <div className="analytics-waterfall-row">
                      <span className="analytics-step-offset">+{duration(offsetMs)}</span>
                      <div className="analytics-waterfall-track" aria-hidden="true">
                        <span className={`analytics-waterfall-bar ${item.ok ? '' : 'fail'}`} style={{ left: `${leftPct}%`, width: `${widthPct}%` }}>
                          {ttftPct > 0 && <span className="analytics-waterfall-ttft" style={{ width: `${ttftPct}%` }} />}
                        </span>
                      </div>
                    </div>
                    <div className="analytics-step-meta">
                      {[item.model && item.model !== turn.model ? item.model : null, item.inputTokens !== undefined && item.outputTokens !== undefined ? `${number(item.inputTokens)} in / ${number(item.outputTokens)} out` : null, typeof item.ttftMs === 'number' ? `TTFT ${duration(item.ttftMs)}` : null].filter(Boolean).join(' · ')}
                    </div>
                  </button>
                })}
              </div>
            </div>
          })}
        </> : <>
          {!report && !error && <p>Loading traces…</p>}
          {report?.events.length === 0 && <p>No traces found.</p>}
          {report?.events.map((item) => <button type="button" className={`analytics-row ${selected === item.id ? 'selected' : ''}`} key={item.id} onClick={() => setSelected(item.id)}>
            <span className="analytics-row-title">{title(item)} <span>{item.ok ? '' : 'Failed'}</span></span>
            <span>{eventLabel(item.event)} · {new Date(item.at).toLocaleString()}</span>
            <span>{[item.model, item.session, item.surface, duration(item.ms)].filter(Boolean).join(' · ')}</span>
          </button>)}
          {report && <div className="analytics-pages"><button className="analytics-button" type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 30))}>Previous</button><span>{number(report.total)} events</span><button className="analytics-button" type="button" disabled={offset + 30 >= report.total} onClick={() => setOffset(offset + 30)}>Next</button></div>}
        </>}
      </section>
      <section aria-label="Trace details" className="analytics-detail">
        {!selected && <p>Select an event to inspect its details.</p>}
        {selected && !detail && !error && <p>Loading event…</p>}
        {detail && <><h3>{title(detail.event as unknown as AnalyticsEvent)}</h3><p>{eventLabel(String(detail.event.event))} · {new Date(String(detail.event.at)).toLocaleString()}</p>
          {typeof detail.event.session === 'string' && !session && onSessionChange && <button type="button" className="analytics-session-link" onClick={() => openSessionTraces(String(detail.event.session))}>Open Session timeline</button>}
          {Object.entries(detail.event).filter(([key]) => !['input', 'output', 'attachments', 'at', 'event'].includes(key)).map(([key, value]) => <div className="analytics-field" key={key}><span>{labels[key] ?? key}</span><span>{fieldValue(key, value)}</span></div>)}
          {(['input', 'output'] as const).map((key) => detail.event[key] !== undefined && <div key={key} className="analytics-payload"><h4>{key === 'input' ? 'Input' : 'Output'}</h4><pre>{pretty(detail.event[key])}</pre></div>)}
          {detail.event.attachments !== undefined && <details className="analytics-attachments" onToggle={(e) => setAttachmentsOpen(e.currentTarget.open)}><summary>Attachment data</summary>{attachmentsOpen && <pre>{pretty(detail.event.attachments)}</pre>}</details>}
          {!session && detail.related.length > 0 && <div className="analytics-related"><h4>Turn timeline</h4>{detail.related.map(({ id, event: related }) => <button className="analytics-row" type="button" key={id} onClick={() => setSelected(id)}><span className="analytics-row-title">{title(related as unknown as AnalyticsEvent)}</span><span>{eventLabel(String(related.event))} · {new Date(String(related.at)).toLocaleTimeString()}</span></button>)}</div>}
        </>}
      </section>
    </div>
  </div></main>
}
