import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { PermissionRequest, SendTarget, TranscriptMessage } from '@protocol'
import { api } from '../lib/api.js'
import { formatWhen, message } from '../lib/format.js'
import { Field } from '../ui/Form.js'
import { Icon } from '../ui/Icons.js'
import { MessageList, type ChatMessage } from '../chat/MessageList.js'
import { Permissions } from '../chat/Permissions.js'

export type RoutineSummary = {
  id: string
  name?: string
  prompt: string
  whenLabel: string
  targetLabel: string
  nextRunAt: number | null
  enabled: boolean
  allow?: string[]
  lastRunAt?: number
  lastResult?: 'ok' | 'error'
}

type Notice = { text: string; error: boolean }

/** A run of a routine, as the history lists it. */
type RunEntry = { id: string; at: number }

/**
 * The chat this screen makes routines through. The app owns the socket, so the
 * turn runs in the conversation the browser is already in and this screen draws
 * it: the field is a way to say what you want, not a form to fill.
 */
export interface RoutinesChat {
  messages: ChatMessage[]
  thinking: boolean
  busy: boolean
  connection: 'connecting' | 'online' | 'offline'
  /** Bumped when a turn ends, so the list is re-read from disk. */
  turnEnds: number
  pendingPermission: { id: string; request: PermissionRequest; expiresAt: number } | null
  send(text: string, target?: SendTarget): void
  decide(allowed: boolean): void
}

const GATEWAYS = [
  ['web', 'This web chat'],
  ['telegram', 'Telegram'],
  ['discord', 'Discord'],
] as const

/**
 * The routines surface: the list, one routine's own page — what it does, whether
 * it is on, and the runs it has produced — or the one field that makes a new one,
 * because turning a sentence into a schedule is the model's job, not the
 * person's. It lives here rather than in Settings because a routine is a thing
 * you use, not a setting you configure.
 */
export function Routines({ conversationId, chat, tick }: { conversationId: string; chat: RoutinesChat; tick: number }) {
  const [routines, setRoutines] = useState<RoutineSummary[] | null>(null)
  const [routineId, setRoutineId] = useState<string | null>(null)
  /** The run a timeline row asked for, opened when its routine's page mounts. */
  const [openedRun, setOpenedRun] = useState<string | null>(null)
  const [composing, setComposing] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try { setRoutines(await api<RoutineSummary[]>('routines')) }
    catch (error) { setNotice({ text: message(error), error: true }) }
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  // biome-ignore lint/correctness/useExhaustiveDependencies: the counter is the trigger, not a value read here — the turn it counts may have just made a routine
  useEffect(() => { void refresh() }, [chat.turnEnds, refresh])
  // biome-ignore lint/correctness/useExhaustiveDependencies: the tick is the trigger, not a value read here — the server said a routine ran
  useEffect(() => { void refresh() }, [tick, refresh])

  /** A routine that is gone leaves the page, rather than being drawn without one. */
  useEffect(() => {
    if (routines === null || routineId === null) return
    if (!routines.some((routine) => routine.id === routineId)) setRoutineId(null)
  }, [routines, routineId])

  /** Back to the list, from a routine's page or from the field that makes one. */
  function close(): void {
    setComposing(false)
    setRoutineId(null)
    setOpenedRun(null)
  }

  if (composing) return <NewRoutine conversationId={conversationId} chat={chat} onBack={close} />
  const routine = routines?.find((entry) => entry.id === routineId)
  if (routine) return <RoutineDetail
    key={routine.id}
    routine={routine}
    chat={chat}
    tick={tick}
    initialRun={openedRun ?? undefined}
    onBack={close}
    onChanged={() => void refresh()}
  />
  return <RoutineList
    routines={routines}
    notice={notice}
    tick={tick}
    onSelect={setRoutineId}
    onOpen={(id, runId) => { setOpenedRun(runId); setRoutineId(id) }}
    onCompose={() => { setNotice(null); setComposing(true) }}
    onRetry={() => { setNotice(null); void refresh() }}
  />
  
}

/** The main area's frame, so every state of this view sits in the same place. */
function Shell({ head, notice, children }: { head?: ReactNode; notice?: Notice | null; children: ReactNode }) {
  return <main className="settings-workspace routines-workspace">
    <div className="settings-inner routines-inner">
      <div className="settings-panel-stack">
        <section className="settings-section routines-section">
          {head}
          <div className="panel-body">
            {notice && <p className={`notice ${notice.error ? 'error' : 'success'}`} role="status">{notice.text}</p>}
            {children}
          </div>
        </section>
      </div>
    </div>
  </main>
}

function RoutineList({
  routines,
  notice,
  tick,
  onSelect,
  onOpen,
  onCompose,
  onRetry,
}: {
  /** Null until the list has been read once: "none" and "not yet" are not the same. */
  routines: RoutineSummary[] | null
  notice: Notice | null
  tick: number
  onSelect(id: string): void
  /** Open one routine on one of its runs, which is what a timeline row points at. */
  onOpen(id: string, runId: string): void
  onCompose(): void
  onRetry(): void
}) {
  const enabled = routines?.filter((routine) => routine.enabled).length ?? 0
  const [feed, setFeed] = useState<FeedEntry[]>([])

  // What the routines said last, as one list: the front page's answer to "what
  // have they been up to", re-read whenever one of them runs.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the tick is the trigger, not a value read here
  useEffect(() => {
    let live = true
    void api<FeedEntry[]>('routine-feed')
      .then((entries) => { if (live) setFeed(entries) })
      .catch(() => { if (live) setFeed([]) })
    return () => { live = false }
  }, [tick, routines])
  return <Shell
    notice={notice}
    head={<div className="panel-head routine-page-head">
      <div>
        <h2>Routines</h2>
        <p>Scheduled work, with each run kept here to read back.</p>
      </div>
      {routines && routines.length > 0 && <div className="routine-count"><strong>{enabled}</strong><span>active</span><span className="routine-count-divider" /><strong>{routines.length}</strong><span>total</span></div>}
    </div>}
  >
    {routines === null ? notice?.error
      ? <div className="routine-state"><p>Could not read routines.</p><button className="button" type="button" onClick={onRetry}>Try again</button></div>
      : <p className="list-empty">Reading routines…</p>
      : routines.length === 0 ? <div className="routine-empty">
        <span className="routine-empty-mark"><Icon name="repeat" size={22} /></span>
        <h3>No routines yet</h3>
        <p className="routine-empty-copy">Describe a task and when to run it. Milo will work out the schedule.</p>
        <button className="button primary" type="button" onClick={onCompose}><Icon name="plus" size={15} /> New routine</button>
      </div>
      : <div className="routine-list">
        {routines.map((routine) => <button key={routine.id} type="button" className="routine-row" onClick={() => onSelect(routine.id)}>
          <span className={`routine-state-mark ${routine.enabled ? 'enabled' : 'paused'}`} aria-hidden="true" />
          <span className="routine-row-main">
            <span className="routine-row-name">{routine.name ?? routine.prompt}</span>
            <span className="routine-row-meta">{routine.whenLabel}<span className="routine-meta-separator">·</span>{routine.targetLabel}</span>
          </span>
          <span className="routine-row-next">
            <span className="routine-row-next-label">{routine.lastRunAt ? 'Last run' : routine.enabled ? 'Next run' : 'Status'}</span>
            <span className={`routine-row-state${routine.lastResult === 'error' ? ' failed' : ''}`}>
              {routine.lastResult === 'error' ? 'Failed' : routine.enabled ? routine.lastRunAt ? formatWhen(routine.lastRunAt) : routine.nextRunAt ? formatWhen(routine.nextRunAt) : 'Enabled' : 'Paused'}
            </span>
          </span>
          <Icon className="routine-row-chevron" name="chevron" size={16} />
        </button>)}
      </div>}
    {feed.length > 0 && <section className="routine-feed" aria-labelledby="routine-feed-title">
      <div className="routine-section-head">
        <div><h3 id="routine-feed-title">Recent outputs</h3><p className="routine-section-subtitle">The latest runs across every routine, newest first.</p></div>
      </div>
      <div className="routine-feed-list">
        {feed.map((entry) => <button className="routine-feed-row" key={entry.runId} type="button" onClick={() => onOpen(entry.id, entry.runId)}>
          <span className="routine-feed-head"><strong>{entry.routine}</strong><span className="routine-feed-when">{formatWhen(entry.at, true)}</span></span>
          <span className="routine-feed-text">{entry.answer || 'No words — the run sent a file.'}</span>
        </button>)}
      </div>
    </section>}
    {routines && routines.length > 0 && <div className="routine-list-footer">
      <span>{routines.length} {routines.length === 1 ? 'routine' : 'routines'}</span>
      <button className="button primary" type="button" onClick={onCompose}><Icon name="plus" size={15} /> New routine</button>
    </div>}
  </Shell>
}

function RoutineDetail({
  routine,
  chat,
  tick,
  initialRun,
  onBack,
  onChanged,
}: {
  routine: RoutineSummary
  chat: RoutinesChat
  tick: number
  /** A run to open on arrival, when the front page's timeline named one. */
  initialRun?: string
  onBack(): void
  onChanged(): void
}) {
  const [runs, setRuns] = useState<RunEntry[] | null>(null)
  const [keep, setKeep] = useState(0)
  const [openRun, setOpenRun] = useState<string | null>(null)
  const [run, setRun] = useState<ChatMessage[] | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  const [runsError, setRunsError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)

  const loadRuns = useCallback(async (): Promise<void> => {
    setRunsError(null)
    const history = await api<{ runs: RunEntry[]; keep: number }>('routine-runs', { id: routine.id })
    setRuns(history.runs)
    setKeep(history.keep)
    setOpenRun((current) => current ?? history.runs[0]?.id ?? null)
  }, [routine.id])

  // biome-ignore lint/correctness/useExhaustiveDependencies: the tick is the trigger, not a value read here — the server said a routine ran
  useEffect(() => {
    void loadRuns().catch((error) => setRunsError(message(error)))
  }, [loadRuns])

  async function retryRuns(): Promise<void> {
    try { await loadRuns() }
    catch (error) { setRunsError(message(error)) }
  }

  // The run's own turn, read back whole. A run is a session of its own, so this
  // is the same transcript a conversation draws, not a second rendering of it.
  useEffect(() => {
    if (!openRun) {
      setRun(null)
      setRunError(null)
      return
    }
    let live = true
    setRun(null)
    setRunError(null)
    void api<TranscriptMessage[]>('run-transcript', { id: openRun })
      .then((messages) => { if (live) setRun(messages.map((entry, index) => ({ ...entry, id: `run-${index}` }))) })
      .catch((error) => { if (live) setRunError(message(error)) })
    return () => { live = false }
  }, [openRun])

  /** Fires it now and opens the run it made — one way to see what a run said. */
  async function runNow(): Promise<void> {
    setNotice(null)
    setWorking(true)
    try {
      const result = await api<{ runId?: string; answer: string; failure: string | null }>('routine-run', { id: routine.id })
      if (result.runId) setOpenRun(result.runId)
      await loadRuns()
      if (!result.runId && result.failure) setNotice({ text: result.failure, error: true })
      onChanged()
    } catch (error) {
      setNotice({ text: message(error), error: true })
    } finally {
      setWorking(false)
    }
  }

  async function toggle(): Promise<void> {
    try {
      await api('routine-enable', { id: routine.id, enabled: !routine.enabled })
      onChanged()
    } catch (error) {
      setNotice({ text: message(error), error: true })
    }
  }

  async function remove(): Promise<void> {
    if (!window.confirm(`Remove the routine “${routine.name ?? routine.prompt}”?`)) return
    try {
      await api('routine-remove', { id: routine.id })
      onBack()
      onChanged()
    } catch (error) {
      setNotice({ text: message(error), error: true })
    }
  }

  const next = routine.enabled
    ? routine.nextRunAt ? formatWhen(routine.nextRunAt, true) : 'Enabled'
    : 'Paused'
  const selectedRun = runs?.find((entry) => entry.id === openRun)

  return <Shell
    notice={notice}
    head={<div className="panel-head routine-detail-head">
      <button className="settings-back" type="button" onClick={onBack}><Icon name="arrow-left" /><span>Routines</span></button>
      <div className="routine-detail-title-row">
        <span className={`routine-state-mark ${routine.enabled ? 'enabled' : 'paused'}`} aria-hidden="true" />
        <h2 className="routine-detail-heading">{routine.name ?? routine.prompt}</h2>
      </div>
      <p className="routine-detail-prompt">{routine.prompt}</p>
    </div>}
  >
    <div className="routine-overview">
      <div className="routine-overview-data">
        <div className="routine-fact"><span className="routine-fact-label">Schedule</span><strong className="routine-fact-value">{routine.whenLabel}</strong></div>
        <div className="routine-fact"><span className="routine-fact-label">Deliver to</span><strong className="routine-fact-value">{routine.targetLabel}</strong></div>
        <div className="routine-fact"><span className="routine-fact-label">{routine.lastRunAt ? 'Last run' : 'Next run'}</span><strong className={`routine-fact-value${routine.lastResult === 'error' ? ' failed' : ''}`}>{routine.lastRunAt ? `${formatWhen(routine.lastRunAt)}${routine.lastResult === 'error' ? ' · failed' : ''}` : next}</strong></div>
      </div>
      <div className="routine-actions">
        <button className="button primary" type="button" disabled={working} onClick={() => void runNow()}><Icon name="play" size={13} /> {working ? 'Running…' : 'Run now'}</button>
        <button className="button" type="button" onClick={() => void toggle()}>{routine.enabled ? 'Pause' : 'Enable'}</button>
        <button className="button danger" type="button" onClick={() => void remove()}>Remove</button>
      </div>
    </div>
    {routine.allow?.length ? <p className="routine-grants"><Icon name="shield" size={14} /><span>May use {routine.allow.join(', ')} while unattended</span></p> : null}

    <section className="routine-runs" aria-labelledby="routine-runs-title">
      <div className="routine-section-head">
        <div><h3 id="routine-runs-title">Runs</h3><p className="routine-section-subtitle">{runs === null ? 'Reading run history' : `${runs.length} of the last ${keep} runs`}</p></div>
        {runs && runs.length > 0 && <span className="routine-runs-count">{runs.length}</span>}
      </div>
      {runsError ? <div className="routine-state"><p>Could not read run history: {runsError}</p><button className="button" type="button" onClick={() => void retryRuns()}>Try again</button></div>
        : runs === null ? <p className="list-empty">Reading runs…</p>
        : runs.length === 0 ? <div className="routine-runs-empty"><Icon name="clock" size={18} /><span>No runs yet. Run it now or wait for its next scheduled time.</span></div>
        : <div className="routine-runs-layout">
          <div className="run-list">
            {runs.map((entry, index) => <button
              key={entry.id}
              type="button"
              className={`run-row ${entry.id === openRun ? 'active' : ''}`}
              aria-current={entry.id === openRun ? 'true' : undefined}
              onClick={() => setOpenRun(entry.id)}
            >
              <span className="run-row-marker" aria-hidden="true" />
              <span className="run-row-copy"><strong>{index === 0 ? 'Latest run' : `Run ${runs.length - index}`}</strong><span className="run-when">{formatWhen(entry.at, true)}</span></span>
              <Icon className="run-row-chevron" name="chevron" size={15} />
            </button>)}
          </div>
          <div className="run-output" aria-live="polite">
            <div className="run-output-head"><span>{selectedRun ? formatWhen(selectedRun.at, true) : 'Select a run'}</span>{selectedRun && <span>Run output</span>}</div>
            {runError ? <div className="routine-state"><p>Could not read this run: {runError}</p></div>
              : run === null ? <p className="list-empty">Reading run…</p>
              : run.length > 0
                ? <div className="routines-thread"><MessageList messages={run} thinking={chat.thinking} /></div>
                : <p className="list-empty">This run has no transcript.</p>}
          </div>
        </div>}
    </section>
  </Shell>
}

function NewRoutine({ conversationId, chat, onBack }: { conversationId: string; chat: RoutinesChat; onBack(): void }) {
  const [ask, setAsk] = useState('')
  const [gateway, setGateway] = useState<SendTarget['gateway']>('web')
  const [target, setTarget] = useState(conversationId)
  /** Where the creation turn starts in the chat's transcript; null until asked. */
  const [createdFrom, setCreatedFrom] = useState<number | null>(null)

  function create(): void {
    const text = ask.trim()
    if (!text) return
    // Taken before the turn starts: everything from here on is this ask and
    // Milo's answer to it, so the wait and the permission prompt stay beside it.
    setCreatedFrom((from) => from ?? chat.messages.length)
    setAsk('')
    // The destination is the one thing the sentence does not have to carry. It
    // is pinned on the turn, so a routine named for Telegram is made for
    // Telegram even though the chat it was asked in is this one.
    chat.send(text, gateway === 'web'
      ? { gateway: 'web', conversationId }
      : { gateway, conversationId: target.trim() })
  }

  /** What has been asked here and answered here: nothing until the first ask. */
  const thread = createdFrom === null ? [] : chat.messages.slice(createdFrom)

  return <Shell head={<div className="panel-head routine-detail-head">
    <button className="settings-back" type="button" onClick={onBack}><Icon name="arrow-left" /><span>Routines</span></button>
    <h2>New routine</h2>
    <p>Describe the task and schedule. Milo will turn your request into a routine.</p>
  </div>}>
    <div className="routine-create-form">
      <Field className="full" label="What should Milo do, and when?">
        <textarea value={ask} onChange={(event) => setAsk(event.target.value)} rows={3} placeholder="Every weekday at 8, look at the repo and tell me what moved." />
      </Field>
      <div className="routine-destination">
        <div className="routine-form-heading"><Icon name="globe" size={15} /><span>Delivery destination</span></div>
        <div className="form-grid">
          <Field label="Service"><select value={gateway} onChange={(event) => {
            const next = event.target.value as SendTarget['gateway']
            setGateway(next)
            setTarget(next === 'web' ? conversationId : '')
          }}>{GATEWAYS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
          <Field label="Conversation id"><input value={target} onChange={(event) => setTarget(event.target.value)} placeholder="a chat or channel id" disabled={gateway === 'web'} /><small>{gateway === 'web' ? 'This browser’s conversation.' : 'The chat to post into.'}</small></Field>
        </div>
      </div>
      <div className="ask-actions">
        <button className="button primary" type="button" disabled={!ask.trim() || chat.busy || chat.connection !== 'online'} onClick={create}>{chat.busy ? 'Milo is on it…' : 'Create routine'}</button>
        {chat.connection !== 'online' && <span className={`connection-status ${chat.connection}`}><span />{chat.connection === 'offline' ? 'Reconnecting…' : 'Connecting…'}</span>}
      </div>
    </div>
    {thread.length > 0 && <div className="routines-thread">
      <div className="routine-thread-heading"><h3>Routine setup</h3><p className="routine-thread-subtitle">Milo’s questions and confirmation appear here.</p></div>
      <MessageList messages={thread} thinking={chat.thinking} />
      {chat.pendingPermission && <article className="message assistant">
        <Permissions request={chat.pendingPermission.request} expiresAt={chat.pendingPermission.expiresAt} onDecision={(allowed) => chat.decide(allowed)} />
      </article>}
    </div>}
  </Shell>
}
