import { useEffect, useState } from 'react'
import type { AnalyticsEvent, AnalyticsReport, AnalyticsTurnsReport, SessionTraceReport, SessionTraceTurn } from '../../../src/core/analytics.js'
import { formatWhen } from '../../../src/core/time.js'
import { shortModel } from '../../../src/gateways/model-label.ts'
import { formatTokens } from '../../../src/util/format.ts'
import { api } from '../lib/api.js'
import { copyText } from '../lib/clipboard.js'
import { message } from '../lib/format.js'
import { Icon } from '../ui/Icons.js'
import { PageHeader } from '../ui/PageHeader.js'
import { Select } from '../ui/Select.js'

export interface AnalyticsSessionTarget {
  id: string
  label: string
}

type Detail = { event: Record<string, unknown>; related: Array<{ id: string; event: Record<string, unknown> }> }

const number = (value: number) => new Intl.NumberFormat().format(value)
const duration = (ms: number) => ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`

const EVENT_LABELS: Record<string, string> = {
  'model.request': 'Model',
  'embedding.request': 'Embedding',
  'tool.call': 'Tool',
  turn: 'Turn',
  'classifier.request': 'Classifier',
  verification: 'Verification',
}
const eventLabel = (kind: string) => EVENT_LABELS[kind] ?? kind

const eventTitle = (event: Pick<AnalyticsEvent, 'event' | 'tool' | 'purpose'>) => {
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

const FIELD_LABELS: Record<string, string> = {
  id: 'ID',
  ok: 'Status',
  ms: 'Duration',
  ttftMs: 'First token',
  inputTokens: 'Input tokens',
  outputTokens: 'Output tokens',
  cachedInputTokens: 'Cached input',
  cacheWriteTokens: 'Cache write',
  reasoningTokens: 'Reasoning tokens',
  callId: 'Tool call ID',
  finish: 'Finish reason',
  provider: 'Provider',
  model: 'Model',
  surface: 'Surface',
  session: 'Session',
  turn: 'Turn',
  purpose: 'Purpose',
  tool: 'Tool',
  error: 'Error',
  startedAt: 'Started',
}

const pretty = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value, null, 2)
const fieldValue = (key: string, value: unknown) =>
  key === 'ok' ? (value ? 'Succeeded' : 'Failed')
  : (key === 'ms' || key === 'ttftMs') && typeof value === 'number' ? duration(value)
  : typeof value === 'number' && key.toLowerCase().includes('token') ? number(value)
  : pretty(value)

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

function formatTime(iso: string): string {
  const parsed = Date.parse(iso)
  return Number.isFinite(parsed) ? formatWhen(parsed) : iso
}

function PayloadBlock({ label, value }: { label: string; value: unknown }) {
  const [copied, setCopied] = useState(false)
  const text = pretty(value)
  return (
    <div className="an-payload">
      <div className="an-payload-head">
        <h4>{label}</h4>
        <button
          type="button"
          className="an-copy-btn"
          onClick={() => {
            void copyText(text).then((ok) => {
              if (!ok) return
              setCopied(true)
              window.setTimeout(() => setCopied(false), 1500)
            })
          }}
        >
          <Icon name={copied ? 'check' : 'copy'} size={13} />
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      <pre>{text}</pre>
    </div>
  )
}

function TurnTimeline({
  turn,
  selected,
  showSession = false,
  onSelect,
  onOpenSession,
}: {
  turn: SessionTraceTurn
  selected: string | null
  showSession?: boolean
  onSelect: (id: string) => void
  onOpenSession?: (sessionId: string) => void
}) {
  const turnOrigin = Date.parse(turn.startedAt)
  const span = Math.max(1, turn.spanMs || turn.ms || 1)
  const steps = turnSteps(turn)
  const toolCallIds = new Set(steps.filter((item) => item.event === 'tool.call' && item.callId).map((item) => item.callId!))
  const turnSummaryEvent = turn.events.find((item) => item.event === 'turn')
  const metaParts = [
    formatTime(turn.startedAt),
    showSession && turn.model ? shortModel(turn.model) : null,
    showSession && turn.surface ? turn.surface : null,
    turn.inputTokens || turn.outputTokens ? `${formatTokens(turn.inputTokens)} / ${formatTokens(turn.outputTokens)}` : null,
  ].filter(Boolean)

  return (
    <article className="an-turn">
      <header className="an-turn-head">
        <div className="an-turn-info">
          <div className="an-turn-title-row">
            <span className={`an-dot ${turn.ok ? 'ok' : 'fail'}`} />
            <span className="an-turn-title">Turn {turn.index}</span>
            <span className="an-turn-ms">{duration(turn.ms)}</span>
            {!turn.ok && <span className="an-badge danger">Failed</span>}
          </div>
          <div className="an-turn-sub" title={new Date(turn.startedAt).toLocaleString()}>
            {metaParts.join(' · ')}
          </div>
        </div>
        <div className="an-turn-actions">
          {showSession && turn.session && onOpenSession && (
            <button type="button" className="an-mini-btn" onClick={() => onOpenSession(turn.session!)}>Session</button>
          )}
          {turnSummaryEvent && (
            <button
              type="button"
              className={`an-mini-btn${selected === turnSummaryEvent.id ? ' active' : ''}`}
              onClick={() => onSelect(turnSummaryEvent.id)}
            >
              Inspect
            </button>
          )}
        </div>
      </header>
      <div className="an-steps">
        {steps.map((item, idx) => {
          const start = eventStart(item)
          const offsetMs = Math.max(0, start - turnOrigin)
          const leftPct = Math.max(0, Math.min(96, (offsetMs / span) * 100))
          const widthPct = Math.max(2, Math.min(100 - leftPct, (Math.max(0, item.ms) / span) * 100))
          const ttftPct = item.event === 'model.request' && typeof item.ttftMs === 'number' && item.ms > 0
            ? Math.max(0, Math.min(100, (item.ttftMs / item.ms) * 100))
            : 0
          const nested = item.event !== 'tool.call' && Boolean(item.callId && toolCallIds.has(item.callId))
          const stepMeta = [
            `+${duration(offsetMs)}`,
            item.model && item.model !== turn.model ? shortModel(item.model) : null,
            item.inputTokens !== undefined && item.outputTokens !== undefined ? `${formatTokens(item.inputTokens)} / ${formatTokens(item.outputTokens)}` : null,
            typeof item.ttftMs === 'number' ? `TTFT ${duration(item.ttftMs)}` : null,
          ].filter(Boolean).join(' · ')

          return (
            <button
              type="button"
              key={item.id}
              className={`an-step${nested ? ' nested' : ''}${selected === item.id ? ' selected' : ''}`}
              onClick={() => onSelect(item.id)}
            >
              <div className="an-step-top">
                <span className={`an-dot ${item.ok ? 'ok' : 'fail'}`} />
                <span className="an-step-idx">{idx + 1}</span>
                <span className="an-step-name">{eventTitle(item)}</span>
                {eventTitle(item) !== eventLabel(item.event) && <span className="an-badge">{eventLabel(item.event)}</span>}
                <span className="an-step-ms">{duration(item.ms)}</span>
              </div>
              <div className="an-step-bottom">
                <div className="an-waterfall" aria-hidden="true">
                  <span className={`an-waterfall-bar${item.ok ? '' : ' fail'}`} style={{ left: `${leftPct}%`, width: `${widthPct}%` }}>
                    {ttftPct > 0 && <span className="an-waterfall-ttft" style={{ width: `${ttftPct}%` }} />}
                  </span>
                </div>
                <span className="an-step-meta">{stepMeta}</span>
              </div>
            </button>
          )
        })}
      </div>
    </article>
  )
}

function PaginationBar({ offset, total, pageSize = 30, singular, plural, onPage }: {
  offset: number
  total: number
  pageSize?: number
  singular: string
  plural: string
  onPage: (next: number) => void
}) {
  if (total === 0) return null
  const from = offset + 1
  const to = Math.min(total, offset + pageSize)
  return (
    <div className="an-pages">
      <span className="an-pages-count">
        {total <= pageSize
          ? `${number(total)} ${total === 1 ? singular : plural}`
          : `${number(from)}–${number(to)} of ${number(total)} ${plural}`}
      </span>
      {total > pageSize && (
        <div className="an-pages-actions">
          <button className="an-btn" type="button" disabled={offset === 0} onClick={() => onPage(Math.max(0, offset - pageSize))}>Previous</button>
          <button className="an-btn" type="button" disabled={offset + pageSize >= total} onClick={() => onPage(offset + pageSize)}>Next</button>
        </div>
      )}
    </div>
  )
}

export function Analytics({
  session = null,
  onSessionChange,
}: {
  session?: AnalyticsSessionTarget | null
  onSessionChange?: (next: AnalyticsSessionTarget | null) => void
} = {}) {
  const [view, setView] = useState<'traces' | 'turns'>('traces')
  const [report, setReport] = useState<AnalyticsReport | null>(null)
  const [turnsReport, setTurnsReport] = useState<AnalyticsTurnsReport | null>(null)
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
    if (view === 'turns') {
      api<AnalyticsTurnsReport>('analytics-turns', { query, event, days: Number(days), offset }).then((value) => {
        if (active) { setTurnsReport(value); setError('') }
      }).catch((reason: unknown) => { if (active) setError(message(reason)) })
      return () => { active = false }
    }
    api<AnalyticsReport>('analytics', { query, event, days: Number(days), offset }).then((value) => {
      if (active) { setReport(value); setError('') }
    }).catch((reason: unknown) => { if (active) setError(message(reason)) })
    return () => { active = false }
  }, [session?.id, view, query, event, days, offset, refresh])

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
  const switchView = (next: 'traces' | 'turns') => {
    if (next === view) return
    setSelected(null)
    setOffset(0)
    setView(next)
  }
  const openSessionTraces = (id: string, label?: string) => {
    setSelected(null)
    onSessionChange?.({ id, label: label || id })
  }

  const orderedTurns = sessionReport ? (ascending ? [...sessionReport.turns].reverse() : sessionReport.turns) : []
  const summary = view === 'turns' ? turnsReport : report

  // Detail inspector summary fields vs metadata table fields
  const detailEvent = detail?.event
  const detailSummaryKeys = new Set(['ms', 'ttftMs', 'inputTokens', 'outputTokens', 'ok'])
  const detailHiddenKeys = new Set(['input', 'output', 'attachments', 'at', 'event', ...detailSummaryKeys])
  const detailMetaEntries = detailEvent
    ? Object.entries(detailEvent).filter(([key, value]) => !detailHiddenKeys.has(key) && value !== undefined && value !== null && value !== '')
    : []

  return (
    <div className="settings-workspace">
      <div className="settings-inner analytics">
        <PageHeader
          back={session && onSessionChange ? (
            <button type="button" className="settings-back" onClick={() => { setSelected(null); onSessionChange(null) }}>
              <Icon name="arrow-left" size={15} />
              <span>All analytics</span>
            </button>
          ) : undefined}
          title={session ? session.label : 'Analytics'}
          description={session ? `Execution timeline for Session ${session.id}` : 'Model requests, tool calls, and turn latencies.'}
          action={
            <div className="an-head-actions">
              {!session && (
                <fieldset className="settings-segmented" aria-label="Analytics view">
                  <button type="button" aria-pressed={view === 'traces'} className={`settings-segmented-item${view === 'traces' ? ' active' : ''}`} onClick={() => switchView('traces')}>Traces</button>
                  <button type="button" aria-pressed={view === 'turns'} className={`settings-segmented-item${view === 'turns' ? ' active' : ''}`} onClick={() => switchView('turns')}>Turns</button>
                </fieldset>
              )}
              {session && (
                <button className="an-btn" type="button" onClick={() => setAscending((prev) => !prev)}>
                  {ascending ? 'Oldest first' : 'Newest first'}
                </button>
              )}
              <button className="an-btn an-btn-icon" type="button" title="Refresh" aria-label="Refresh analytics" onClick={() => setRefresh((n) => n + 1)}>
                <Icon name="refresh" size={15} />
              </button>
            </div>
          }
        />

        {error && <p className="an-error" role="alert">{error}</p>}

        {/* ── KPI Strip ─────────────────────────────────────────────── */}
        {session ? sessionReport && (
          <div className="an-kpis">
            <div className="an-kpi">
              <span className="an-kpi-label">Turns</span>
              <strong className="an-kpi-value">{number(sessionReport.turnsCount)}</strong>
              <span className="an-kpi-sub">{number(sessionReport.requests)} req · {number(sessionReport.toolCalls)} tools</span>
            </div>
            <div className="an-kpi">
              <span className="an-kpi-label">Tokens</span>
              <strong className="an-kpi-value">{formatTokens(sessionReport.inputTokens + sessionReport.outputTokens)}</strong>
              <span className="an-kpi-sub">{formatTokens(sessionReport.inputTokens)} in · {formatTokens(sessionReport.outputTokens)} out</span>
            </div>
            <div className="an-kpi">
              <span className="an-kpi-label">Total time</span>
              <strong className="an-kpi-value">{duration(sessionReport.totalMs)}</strong>
            </div>
            <div className="an-kpi">
              <span className="an-kpi-label">Errors</span>
              <strong className={`an-kpi-value${sessionReport.failures > 0 ? ' danger' : ''}`}>{number(sessionReport.failures)}</strong>
            </div>
          </div>
        ) : summary && (
          <div className="an-kpis">
            <div className="an-kpi">
              <span className="an-kpi-label">{view === 'turns' ? 'Turns' : 'Requests'}</span>
              <strong className="an-kpi-value">{number(view === 'turns' && turnsReport ? turnsReport.total : summary.requests)}</strong>
              {view === 'turns'
                ? <span className="an-kpi-sub">{number(summary.requests)} model req</span>
                : summary.embeddingRequests > 0
                  ? <span className="an-kpi-sub">{number(summary.embeddingRequests)} embeddings</span>
                  : null}
            </div>
            <div className="an-kpi">
              <span className="an-kpi-label">Tokens</span>
              <strong className="an-kpi-value">{formatTokens(summary.inputTokens + summary.outputTokens)}</strong>
              <span className="an-kpi-sub">
                {formatTokens(summary.inputTokens)} in · {formatTokens(summary.outputTokens)} out
                {summary.requestsWithUsage < summary.requests ? ` · ${number(summary.requestsWithUsage)}/${number(summary.requests)} tracked` : ''}
              </span>
            </div>
            <div className="an-kpi">
              <span className="an-kpi-label">Avg latency</span>
              <strong className="an-kpi-value">{summary.averageMs === null ? '—' : duration(summary.averageMs)}</strong>
            </div>
            <div className="an-kpi">
              <span className="an-kpi-label">Errors</span>
              <strong className={`an-kpi-value${summary.failures > 0 ? ' danger' : ''}`}>{number(summary.failures)}</strong>
            </div>
          </div>
        )}

        {/* ── Model Filter Strip & Toolbar ─────────────────────────── */}
        {!session && (
          <>
            {summary && summary.models.length > 0 && (
              <section className="an-models" aria-label="Models">
                {summary.models.map((item) => {
                  const active = query === item.model
                  return (
                    <button
                      type="button"
                      key={item.model}
                      title={`${item.model} · ${number(item.inputTokens)} in / ${number(item.outputTokens)} out`}
                      className={`an-model-chip${active ? ' active' : ''}`}
                      aria-pressed={active}
                      onClick={() => update(() => setQuery(active ? '' : item.model))}
                    >
                      <span className="an-model-chip-name">{shortModel(item.model)}</span>
                      <span className="an-model-chip-meta">{number(item.requests)}</span>
                      {item.failures > 0 && <span className="an-model-chip-fail">{number(item.failures)} err</span>}
                    </button>
                  )
                })}
              </section>
            )}

            <div className="an-toolbar">
              <div className="an-search">
                <Icon name="search" size={15} />
                <input
                  aria-label="Search traces"
                  placeholder="Filter by model, Session, or tool…"
                  value={query}
                  onChange={(e) => update(() => setQuery(e.target.value))}
                />
                {query && (
                  <button type="button" className="an-search-clear" aria-label="Clear search" onClick={() => update(() => setQuery(''))}>
                    <Icon name="x" size={13} />
                  </button>
                )}
              </div>
              <div className="an-toolbar-selects">
                <div className="an-select-wrap">
                  <Select
                    label="Event type"
                    value={event}
                    choices={[
                      { value: 'all', label: 'All events' },
                      { value: 'model.request', label: 'Model requests' },
                      { value: 'tool.call', label: 'Tool calls' },
                      { value: 'turn', label: 'Turns' },
                      { value: 'classifier.request', label: 'Classifier' },
                      { value: 'embedding.request', label: 'Embeddings' },
                      { value: 'verification', label: 'Verification' },
                    ]}
                    onChange={(next) => update(() => setEvent(next))}
                  />
                </div>
                <div className="an-select-wrap">
                  <Select
                    label="Period"
                    value={days}
                    choices={[
                      { value: '0', label: 'All time' },
                      { value: '1', label: 'Last 24 hours' },
                      { value: '7', label: 'Last 7 days' },
                      { value: '30', label: 'Last 30 days' },
                    ]}
                    onChange={(next) => update(() => setDays(next))}
                  />
                </div>
              </div>
            </div>
          </>
        )}

        {/* ── Master-Detail Workspace ───────────────────────────────── */}
        <div className="an-split">
          <section aria-label={session ? 'Session turn timeline' : view === 'turns' ? 'Turn history' : 'Trace history'} className="an-list-col">
            {session ? (
              <>
                {!sessionReport && !error && <div className="an-empty">Loading session traces…</div>}
                {sessionReport?.turns.length === 0 && <div className="an-empty">No traces recorded for this Session yet.</div>}
                <div className="an-turns-stack">
                  {orderedTurns.map((turn) => <TurnTimeline key={turn.id} turn={turn} selected={selected} onSelect={setSelected} />)}
                </div>
              </>
            ) : view === 'turns' ? (
              <>
                {!turnsReport && !error && <div className="an-empty">Loading turns…</div>}
                {turnsReport?.turns.length === 0 && <div className="an-empty">No turns match these filters.</div>}
                <div className="an-turns-stack">
                  {turnsReport?.turns.map((turn) => (
                    <TurnTimeline
                      key={`${turn.session ?? ''}:${turn.id}:${turn.startedAt}`}
                      turn={turn}
                      selected={selected}
                      showSession
                      onSelect={setSelected}
                      onOpenSession={onSessionChange ? openSessionTraces : undefined}
                    />
                  ))}
                </div>
                {turnsReport && <PaginationBar offset={offset} total={turnsReport.total} singular="turn" plural="turns" onPage={setOffset} />}
              </>
            ) : (
              <>
                {!report && !error && <div className="an-empty">Loading traces…</div>}
                {report?.events.length === 0 && <div className="an-empty">No traces match these filters.</div>}
                {report && report.events.length > 0 && (
                  <div className="an-list-surface">
                    {report.events.map((item) => {
                      const sub = [
                        item.model ? shortModel(item.model) : null,
                        item.surface,
                        formatTime(item.at),
                      ].filter(Boolean).join(' · ')
                      return (
                        <button
                          type="button"
                          key={item.id}
                          className={`an-row${selected === item.id ? ' selected' : ''}`}
                          onClick={() => setSelected(item.id)}
                        >
                          <div className="an-row-top">
                            <span className={`an-dot ${item.ok ? 'ok' : 'fail'}`} />
                            <span className="an-row-title">{eventTitle(item)}</span>
                            {eventTitle(item) !== eventLabel(item.event) && <span className="an-badge">{eventLabel(item.event)}</span>}
                            <span className="an-row-ms">{duration(item.ms)}</span>
                          </div>
                          <div className="an-row-sub" title={new Date(item.at).toLocaleString()}>
                            <span>{sub}</span>
                            {item.inputTokens !== undefined && item.outputTokens !== undefined && (
                              <span className="an-row-tokens">{formatTokens(item.inputTokens)} / {formatTokens(item.outputTokens)}</span>
                            )}
                          </div>
                        </button>
                      )
                    })}
                  </div>
                )}
                {report && <PaginationBar offset={offset} total={report.total} singular="event" plural="events" onPage={setOffset} />}
              </>
            )}
          </section>

          <aside aria-label="Trace details" className="an-inspector">
            {!selected && (
              <div className="an-inspector-empty">
                <Icon name="chart" size={24} />
                <p>Select a trace or step to inspect its latency, tokens, and payloads.</p>
              </div>
            )}
            {selected && !detail && !error && <div className="an-inspector-empty"><p>Loading event…</p></div>}
            {detail && detailEvent && (
              <div className="an-inspector-body">
                <header className="an-inspector-head">
                  <div className="an-inspector-title-row">
                    <span className={`an-dot ${detailEvent.ok ? 'ok' : 'fail'}`} />
                    <h3>{eventTitle(detailEvent as unknown as AnalyticsEvent)}</h3>
                    {eventTitle(detailEvent as unknown as AnalyticsEvent) !== eventLabel(String(detailEvent.event)) && (
                      <span className="an-badge">{eventLabel(String(detailEvent.event))}</span>
                    )}
                  </div>
                  <div className="an-inspector-sub">
                    <span>{new Date(String(detailEvent.at)).toLocaleString()}</span>
                    {typeof detailEvent.session === 'string' && !session && onSessionChange && (
                      <button type="button" className="an-inline-action" onClick={() => openSessionTraces(String(detailEvent.session))}>
                        Open Session timeline
                      </button>
                    )}
                  </div>
                </header>

                {/* Vital stats strip */}
                <div className="an-detail-metrics">
                  <div>
                    <span>Status</span>
                    <strong className={detailEvent.ok ? 'ok' : 'fail'}>{detailEvent.ok ? 'Succeeded' : 'Failed'}</strong>
                  </div>
                  {typeof detailEvent.ms === 'number' && (
                    <div>
                      <span>Duration</span>
                      <strong>{duration(detailEvent.ms)}</strong>
                    </div>
                  )}
                  {typeof detailEvent.ttftMs === 'number' && (
                    <div>
                      <span>First token</span>
                      <strong>{duration(detailEvent.ttftMs)}</strong>
                    </div>
                  )}
                  {(typeof detailEvent.inputTokens === 'number' || typeof detailEvent.outputTokens === 'number') && (
                    <div>
                      <span>Tokens</span>
                      <strong>
                        {number(Number(detailEvent.inputTokens ?? 0))} / {number(Number(detailEvent.outputTokens ?? 0))}
                      </strong>
                    </div>
                  )}
                </div>

                {/* Metadata key-value list */}
                {detailMetaEntries.length > 0 && (
                  <dl className="an-meta-grid">
                    {detailMetaEntries.map(([key, value]) => (
                      <div className="an-meta-row" key={key}>
                        <dt>{FIELD_LABELS[key] ?? key}</dt>
                        <dd className={key === 'error' ? 'an-meta-error' : ''}>{fieldValue(key, value)}</dd>
                      </div>
                    ))}
                  </dl>
                )}

                {/* Input / Output payloads */}
                {detailEvent.input !== undefined && <PayloadBlock label="Input" value={detailEvent.input} />}
                {detailEvent.output !== undefined && <PayloadBlock label="Output" value={detailEvent.output} />}

                {detailEvent.attachments !== undefined && (
                  <details className="settings-disclosure an-attachments" onToggle={(e) => setAttachmentsOpen(e.currentTarget.open)}>
                    <summary className="settings-disclosure-summary">
                      <span className="settings-disclosure-label">Attachments</span>
                    </summary>
                    {attachmentsOpen && (
                      <div className="settings-disclosure-body">
                        <PayloadBlock label="Attachment data" value={detailEvent.attachments} />
                      </div>
                    )}
                  </details>
                )}

                {/* Related steps in the same turn */}
                {!session && view === 'traces' && detail.related.length > 0 && (
                  <div className="an-related">
                    <h4>Turn timeline</h4>
                    <div className="an-related-list">
                      {detail.related.map(({ id, event: related }) => (
                        <button
                          type="button"
                          key={id}
                          className={`an-related-row${id === selected ? ' selected' : ''}`}
                          onClick={() => setSelected(id)}
                        >
                          <span className={`an-dot ${related.ok === false ? 'fail' : 'ok'}`} />
                          <span className="an-related-name">{eventTitle(related as unknown as AnalyticsEvent)}</span>
                          {eventTitle(related as unknown as AnalyticsEvent) !== eventLabel(String(related.event)) && (
                            <span className="an-badge">{eventLabel(String(related.event))}</span>
                          )}
                          <span className="an-related-time">{new Date(String(related.at)).toLocaleTimeString()}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </aside>
        </div>
      </div>
    </div>
  )
}
