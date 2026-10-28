import { useCallback, useEffect, useRef, useState } from 'react'
import type { PermissionRequest, SendTarget, ThinkingDisplay, TranscriptMessage } from '@protocol'
import { api } from '../lib/api.js'
import type { ConnectionState } from '../lib/connection.js'
import { message } from '../lib/format.js'
import { formatIn, formatWhen } from '../../../src/core/time.js'
import { usePhone } from '../lib/phone.js'
import { Field } from '../ui/Form.js'
import { Icon, type IconName } from '../ui/Icons.js'
import { Notice, useAutoDismiss } from '../ui/Notice.js'
import { PageHeader } from '../ui/PageHeader.js'
import { Select } from '../ui/Select.js'
import { SkeletonList } from '../ui/Skeleton.js'
import { Panel, SplitWorkspace } from '../ui/Workspace.js'
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
  /** Whether its own ceiling stopped it, which is not the person pausing it. */
  finished: boolean
  allow?: string[]
  /** What a run that had nothing to report does, in the daemon's words; null when every run speaks. */
  silentLabel: string | null
  lastRunAt?: number
  lastResult?: 'ok' | 'error'
}

/** What the row's own state cell is labelled: a word is a status, a time is a run. */
function stateLabel(routine: RoutineSummary): string {
  if (routine.finished) return 'Status'
  return routine.lastRunAt ? 'Last run' : routine.enabled ? 'Next run' : 'Status'
}

/**
 * How a routine reads as a state: a failure first, then the two words that mean not
 * running — finished, which its own ceiling did, and paused, which the person did —
 * and otherwise the time of its last or next run.
 */
function stateWord(routine: RoutineSummary): string {
  if (routine.lastResult === 'error') return 'Failed'
  if (routine.finished) return 'Finished'
  if (!routine.enabled) return 'Paused'
  if (routine.lastRunAt) return formatWhen(routine.lastRunAt)
  return routine.nextRunAt ? formatIn(routine.nextRunAt) : 'Enabled'
}

/** A run of a routine, as the history lists it. */
type RunEntry = { id: string; at: number }

/** How many runs a page of the history holds; the rest arrive as the list scrolls. */
const RUN_PAGE = 20

/** One run as the front page's timeline lists it, across every routine. */
type FeedEntry = { id: string; runId: string; routine: string; at: number; answer: string }

/**
 * The chat this screen makes routines through. The app owns the socket, so the
 * turn runs in the conversation the browser is already in and this screen draws
 * it: the field is a way to say what you want, not a form to fill.
 */
export interface RoutinesChat {
  messages: ChatMessage[]
  thinking: ThinkingDisplay
  busy: boolean
  connection: ConnectionState
  /** Bumped when a turn ends, so the list is re-read from disk. */
  turnEnds: number
  pendingPermission: { id: string; request: PermissionRequest; expiresAt: number } | null
  send(text: string, target?: SendTarget): void
  decide(action: 'allow' | 'always' | 'deny'): void
}

const GATEWAYS = [
  ['web', 'This web chat'],
  ['telegram', 'Telegram'],
  ['discord', 'Discord'],
  ['none', 'Routines screen only'],
] as const

/** Starter schedules offered on the empty state and above a blank creation prompt. */
const ROUTINE_STARTERS: ReadonlyArray<{ icon: IconName; title: string; detail: string; prompt: string }> = [
  {
    icon: 'mail',
    title: 'Morning inbox brief',
    detail: 'Summarize unread mail every weekday morning',
    prompt: 'Every weekday at 8am, check my inbox and summarize anything that needs a reply.',
  },
  {
    icon: 'branch',
    title: 'Daily repo digest',
    detail: 'Check what changed in the repository each evening',
    prompt: 'Every weekday at 6pm, look at the repo and summarize what moved today.',
  },
  {
    icon: 'list-check',
    title: 'Weekly open tasks',
    detail: 'Review open task lists every Monday morning',
    prompt: 'Every Monday at 9am, go through my task lists and shape a plan for the week.',
  },
]

/**
 * The routines surface: the list, one routine's own page — what it does, whether
 * it is on, and the runs it has produced — or the one field that makes a new one,
 * because turning a sentence into a schedule is the model's job, not the
 * person's. It lives here rather than in Settings because a routine is a thing
 * you use, not a setting you configure.
 */
export function Routines({ chatId, chat, tick }: { chatId: string; chat: RoutinesChat; tick: number }) {
  const [routines, setRoutines] = useState<RoutineSummary[] | null>(null)
  const [feed, setFeed] = useState<FeedEntry[]>([])
  const [routineId, setRoutineId] = useState<string | null>(null)
  /** The run a timeline row asked for, opened when its routine's page mounts. */
  const [openedRun, setOpenedRun] = useState<string | null>(null)
  const [composing, setComposing] = useState(false)
  const [initialAsk, setInitialAsk] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)
  useAutoDismiss(notice, setNotice)
  const phone = usePhone()

  /** Bumped per read, so a slower earlier answer cannot overwrite a newer one. */
  const loadSeq = useRef(0)
  const refresh = useCallback(async (): Promise<void> => {
    const mine = ++loadSeq.current
    try {
      const next = await api<RoutineSummary[]>('routines')
      if (mine !== loadSeq.current) return
      setRoutines(next)
    } catch (error) {
      if (mine !== loadSeq.current) return
      setNotice({ text: message(error), error: true })
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

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

  /** Run one now, straight from the list, without opening it. */
  const runNow = useCallback(async (id: string): Promise<void> => {
    try {
      await api('routine-run', { id })
      setNotice({ text: 'Ran it now — open it to read what it said.', error: false })
      await refresh()
    } catch (error) { setNotice({ text: message(error), error: true }) }
  }, [refresh])

  /** Pause or resume one, straight from the list. */
  const toggle = useCallback(async (id: string, enabled: boolean): Promise<void> => {
    try {
      await api('routine-enable', { id, enabled })
      await refresh()
    } catch (error) { setNotice({ text: message(error), error: true }) }
  }, [refresh])
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
    setInitialAsk('')
    setRoutineId(null)
    setOpenedRun(null)
  }

  function openCompose(seed = ''): void {
    setNotice(null)
    setInitialAsk(seed)
    setComposing(true)
  }

  const enabled = routines?.filter((entry) => entry.enabled).length ?? 0
  const selected = routines?.find((entry) => entry.id === routineId)

  // On a phone, or before there are routines to split beside a detail pane, the
  // screen is a single column that pushes one level in.
  if (phone || routines === null || (routines.length === 0 && !composing)) {
    if (composing) return <NewRoutine key={initialAsk} chatId={chatId} chat={chat} initialAsk={initialAsk} onBack={close} />
    if (selected) return <RoutineDetail
      key={selected.id}
      routine={selected}
      chat={chat}
      tick={tick}
      initialRun={openedRun ?? undefined}
      onBack={close}
      onChanged={() => void refresh()}
    />
    return <RoutineList
      routines={routines}
      feed={feed}
      notice={notice}
      onDismiss={() => setNotice(null)}
      onSelect={(id) => { setOpenedRun(null); setRoutineId(id) }}
      onOpen={(id, runId) => { setOpenedRun(runId); setRoutineId(id) }}
      onCompose={openCompose}
      onRetry={() => { setNotice(null); void refresh() }}
      onRun={runNow}
      onToggle={toggle}
    />
  }

  // On a wide screen with routines, the list stays on the left and the detail —
  // the selected routine, the creation prompt, or the recent runs feed — sits
  // beside it. When no run history exists yet and nothing is picked, the first
  // routine opens automatically so the detail pane never sits empty.
  const activeRoutine = !composing ? (selected ?? (feed.length === 0 ? routines[0] : undefined)) : undefined

  const rail = <>
    <PageHeader
      title="Routines"
      description="Scheduled work, with each run kept here to read back."
      action={<button className="button primary" type="button" onClick={() => openCompose()}><Icon name="plus" size={15} /> New</button>}
    />
    {routines.length > 0 && <div className="workspace-rail-meta">
      <div className="panel-count"><strong>{enabled}</strong><span>active</span><span className="panel-count-divider" /><strong>{routines.length}</strong><span>total</span></div>
      {feed.length > 0 && (activeRoutine !== undefined || composing) && <button className="workspace-rail-link" type="button" onClick={close}>Recent outputs</button>}
    </div>}
    <RoutineCards
      routines={routines}
      activeId={activeRoutine?.id ?? null}
      onSelect={(id) => {
        setComposing(false)
        setOpenedRun(null)
        setRoutineId(id)
      }}
      onRun={runNow}
      onToggle={toggle}
    />
  </>

  return <SplitWorkspace label="Routines" rail={rail}>
    <Notice notice={notice} onDismiss={() => setNotice(null)} />
    {composing ? <NewRoutine
      key={initialAsk}
      chatId={chatId}
      chat={chat}
      initialAsk={initialAsk}
      onBack={close}
      inSplit
    /> : activeRoutine ? <RoutineDetail
      key={activeRoutine.id}
      routine={activeRoutine}
      chat={chat}
      tick={tick}
      initialRun={openedRun ?? undefined}
      onChanged={() => void refresh()}
      inSplit
    /> : <RoutineFeedSection
      feed={feed}
      onOpen={(id, runId) => { setComposing(false); setOpenedRun(runId); setRoutineId(id) }}
      inSplit
    />}
  </SplitWorkspace>
}

function RoutineCards({
  routines,
  activeId,
  onSelect,
  onRun,
  onToggle,
}: {
  routines: RoutineSummary[]
  activeId: string | null
  onSelect(id: string): void
  onRun(id: string): void
  onToggle(id: string, enabled: boolean): void
}) {
  return <div className="routine-list">
    {routines.map((routine) => <div className={`routine-row${routine.id === activeId ? ' active' : ''}`} key={routine.id}>
      <span className={`routine-state-mark ${routine.enabled ? 'enabled' : 'paused'}`} aria-hidden="true" />
      <button type="button" className="routine-row-open" aria-current={routine.id === activeId ? 'true' : undefined} onClick={() => onSelect(routine.id)}>
        <span className="routine-row-main">
          <span className="routine-row-name">{routine.name ?? routine.prompt}</span>
          <span className="routine-row-meta">{routine.whenLabel}<span className="routine-meta-separator">·</span>{routine.targetLabel}</span>
        </span>
        <span className="routine-row-next">
          <span className="routine-row-next-label">{stateLabel(routine)}</span>
          <span className={`routine-row-state${routine.lastResult === 'error' ? ' failed' : ''}`}>
            {stateWord(routine)}
          </span>
        </span>
      </button>
      <span className="routine-row-actions">
        <button className="routine-row-action" type="button" title="Run now" aria-label={`Run ${routine.name ?? routine.prompt} now`} onClick={() => onRun(routine.id)}><Icon name="play" size={13} /></button>
        <button className="routine-row-action" type="button" title={routine.enabled ? 'Pause' : 'Resume'} aria-label={routine.enabled ? `Pause ${routine.name ?? routine.prompt}` : `Resume ${routine.name ?? routine.prompt}`} onClick={() => onToggle(routine.id, !routine.enabled)}><Icon name={routine.enabled ? 'pause' : 'play'} size={13} /></button>
      </span>
      <Icon className="routine-row-chevron" name="chevron" size={16} />
    </div>)}
  </div>
}

function RoutineFeedSection({
  feed,
  onOpen,
  inSplit,
}: {
  feed: FeedEntry[]
  onOpen(id: string, runId: string): void
  inSplit?: boolean
}) {
  const list = <div className="routine-feed-list">
    {feed.map((entry) => <button className="routine-feed-row" key={entry.runId} type="button" onClick={() => onOpen(entry.id, entry.runId)}>
      <span className="routine-feed-head"><strong>{entry.routine}</strong><span className="routine-feed-when">{formatWhen(entry.at, 'absolute')}</span></span>
      <span className="routine-feed-text">{entry.answer || 'No words — the run sent a file.'}</span>
    </button>)}
  </div>
  if (inSplit) {
    return <Panel
      inSplit
      head={<PageHeader
        title="Recent outputs"
        description="The latest runs across every routine, newest first."
      />}
    >
      {list}
    </Panel>
  }
  return <section className="routine-feed" aria-labelledby="routine-feed-title">
    <div className="routine-section-head">
      <div><h3 id="routine-feed-title">Recent outputs</h3><p className="routine-section-subtitle">The latest runs across every routine, newest first.</p></div>
    </div>
    {list}
  </section>
}

function RoutineList({
  routines,
  feed,
  notice,
  onDismiss,
  onSelect,
  onOpen,
  onCompose,
  onRetry,
  onRun,
  onToggle,
}: {
  /** Null until the list has been read once: "none" and "not yet" are not the same. */
  routines: RoutineSummary[] | null
  feed: FeedEntry[]
  notice: Notice | null
  onDismiss(): void
  onSelect(id: string): void
  /** Open one routine on one of its runs, which is what a timeline row points at. */
  onOpen(id: string, runId: string): void
  onCompose(seed?: string): void
  onRetry(): void
  onRun(id: string): void
  onToggle(id: string, enabled: boolean): void
}) {
  const enabled = routines?.filter((routine) => routine.enabled).length ?? 0
  return <Panel
    notice={notice}
    onDismiss={onDismiss}
    head={<PageHeader
      title="Routines"
      description="Scheduled work, with each run kept here to read back."
      action={routines && routines.length > 0 ? <>
        <div className="panel-count"><strong>{enabled}</strong><span>active</span><span className="panel-count-divider" /><strong>{routines.length}</strong><span>total</span></div>
        <button className="button primary" type="button" onClick={() => onCompose()}><Icon name="plus" size={15} /> New routine</button>
      </> : undefined}
    />}
  >
    {routines === null ? notice?.error
      ? <div className="panel-state"><p>Could not read routines.</p><button className="button" type="button" onClick={onRetry}>Try again</button></div>
      : <SkeletonList rows={4} label="Reading routines…" />
      : routines.length === 0 ? <div className="panel-empty">
        <span className="panel-empty-mark"><Icon name="repeat" size={22} /></span>
        <h3>No routines yet</h3>
        <p className="panel-empty-copy">Describe a recurring task in plain words — Milo sets the schedule and keeps each run here.</p>
        <button className="button primary" type="button" onClick={() => onCompose()}><Icon name="plus" size={15} /> New routine</button>
        <div className="suggestion-grid empty-starters">
          {ROUTINE_STARTERS.map((starter) => <button
            key={starter.title}
            type="button"
            className="suggestion"
            title={starter.detail}
            onClick={() => onCompose(starter.prompt)}
          >
            <Icon name={starter.icon} size={16} />
            <span>{starter.title}</span>
          </button>)}
        </div>
      </div>
      : <RoutineCards routines={routines} activeId={null} onSelect={onSelect} onRun={onRun} onToggle={onToggle} />}
    {feed.length > 0 && <RoutineFeedSection feed={feed} onOpen={onOpen} />}
  </Panel>
}

function RoutineDetail({
  routine,
  chat,
  tick,
  initialRun,
  onBack,
  onChanged,
  inSplit,
}: {
  routine: RoutineSummary
  chat: RoutinesChat
  tick: number
  /** A run to open on arrival, when the front page's timeline named one. */
  initialRun?: string
  onBack?(): void
  onChanged(): void
  inSplit?: boolean
}) {
  const [runs, setRuns] = useState<RunEntry[] | null>(null)
  const [total, setTotal] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLSpanElement>(null)
  /** Whether a page is in flight, so the observer cannot ask for the same one twice. */
  const loadingMore = useRef(false)
  const [openRun, setOpenRun] = useState<string | null>(initialRun ?? null)
  const [run, setRun] = useState<ChatMessage[] | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  const [runsError, setRunsError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  useAutoDismiss(notice, setNotice)

  const loadRuns = useCallback(async (): Promise<void> => {
    setRunsError(null)
    const history = await api<{ runs: RunEntry[]; total: number }>('routine-runs', { id: routine.id, limit: RUN_PAGE })
    setRuns(history.runs)
    setTotal(history.total)
    setOpenRun((current) => current ?? history.runs[0]?.id ?? null)
  }, [routine.id])

  // biome-ignore lint/correctness/useExhaustiveDependencies: the tick is the trigger, not a value read here — the server said a routine ran
  useEffect(() => {
    void loadRuns().catch((error) => setRunsError(message(error)))
  }, [loadRuns, tick])

  /** The next page, asked for as the list's end comes into view. */
  const loadMoreRuns = useCallback(async (): Promise<void> => {
    const loaded = runs?.length ?? 0
    if (loadingMore.current || loaded === 0 || loaded >= total) return
    loadingMore.current = true
    try {
      const page = await api<{ runs: RunEntry[]; total: number }>('routine-runs', { id: routine.id, offset: loaded, limit: RUN_PAGE })
      setRuns((current) => [...(current ?? []), ...page.runs])
      setTotal(page.total)
    } catch {
      // A page that failed is asked for again on the next scroll rather than said
      // twice: the list already carries whatever it did load.
    } finally {
      loadingMore.current = false
    }
  }, [routine.id, runs?.length, total])

  useEffect(() => {
    const list = listRef.current
    const sentinel = sentinelRef.current
    if (!list || !sentinel || runs === null || runs.length >= total) return
    const observer = new IntersectionObserver(
      (entries) => { if (entries.some((entry) => entry.isIntersecting)) void loadMoreRuns() },
      { root: list },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [runs, total, loadMoreRuns])

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
      onBack?.()
      onChanged()
    } catch (error) {
      setNotice({ text: message(error), error: true })
    }
  }

  const next = routine.enabled
    ? routine.nextRunAt ? formatWhen(routine.nextRunAt, 'absolute') : 'Enabled'
    : 'Paused'
  const selectedRun = runs?.find((entry) => entry.id === openRun)

  return <Panel
    inSplit={inSplit}
    notice={notice}
    onDismiss={() => setNotice(null)}
    head={<PageHeader
      back={!inSplit && onBack ? <button className="settings-back" type="button" onClick={onBack}><Icon name="arrow-left" /><span>Routines</span></button> : undefined}
      title={<><span className={`routine-state-mark ${routine.enabled ? 'enabled' : 'paused'}`} aria-hidden="true" />{routine.name ?? routine.prompt}</>}
      description={routine.name ? routine.prompt : undefined}
    />}
  >
    <div className="routine-overview">
      <div className="routine-overview-data">
        <div className="routine-fact"><span className="routine-fact-label">Schedule</span><strong className="routine-fact-value">{routine.whenLabel}</strong></div>
        <div className="routine-fact"><span className="routine-fact-label">Deliver to</span><strong className="routine-fact-value">{routine.targetLabel}</strong></div>
        <div className="routine-fact"><span className="routine-fact-label">{routine.finished ? 'State' : routine.lastRunAt ? 'Last run' : 'Next run'}</span><strong className={`routine-fact-value${routine.lastResult === 'error' ? ' failed' : ''}`}>{routine.finished ? 'Finished' : routine.lastRunAt ? `${formatWhen(routine.lastRunAt)}${routine.lastResult === 'error' ? ' · failed' : ''}` : next}</strong></div>
      </div>
      <div className="routine-actions">
        <button className="button primary" type="button" disabled={working} onClick={() => void runNow()}><Icon name="play" size={13} /> {working ? 'Running…' : 'Run now'}</button>
        <button className="button" type="button" onClick={() => void toggle()}>{routine.enabled ? 'Pause' : 'Enable'}</button>
        <button className="button danger" type="button" onClick={() => void remove()}>Remove</button>
      </div>
    </div>
    {routine.allow?.length ? <p className="routine-grants"><Icon name="shield" size={14} /><span>May use {routine.allow.join(', ')} while unattended</span></p> : null}
    {routine.silentLabel ? <p className="routine-grants"><Icon name="bell-off" size={14} /><span>{routine.silentLabel}</span></p> : null}

    <section className="routine-runs" aria-labelledby="routine-runs-title">
      <div className="routine-section-head">
        <div><h3 id="routine-runs-title">Runs</h3><p className="routine-section-subtitle">{runs === null ? 'Reading run history' : runs.length >= total ? `${total} ${total === 1 ? 'run' : 'runs'}` : `${runs.length} of ${total} runs`}</p></div>
        {runs && runs.length > 0 && <span className="routine-runs-count">{runs.length}</span>}
      </div>
      {runsError ? <div className="panel-state"><p>Could not read run history: {runsError}</p><button className="button" type="button" onClick={() => void retryRuns()}>Try again</button></div>
        : runs === null ? <p className="list-empty">Reading runs…</p>
        : runs.length === 0 ? <div className="routine-runs-empty"><Icon name="clock" size={18} /><span>No runs yet. Run it now or wait for its next scheduled time.</span></div>
        : <div className="routine-runs-layout">
          <div className="run-list" ref={listRef}>
            {runs.map((entry, index) => <button
              key={entry.id}
              type="button"
              className={`run-row ${entry.id === openRun ? 'active' : ''}`}
              aria-current={entry.id === openRun ? 'true' : undefined}
              onClick={() => setOpenRun(entry.id)}
            >
              <span className="run-row-marker" aria-hidden="true" />
              <span className="run-row-copy"><strong>{index === 0 ? 'Latest run' : `Run ${total - index}`}</strong><span className="run-when">{formatWhen(entry.at, 'absolute')}</span></span>
              <Icon className="run-row-chevron" name="chevron" size={15} />
            </button>)}
            {/* The last thing in the list is the ask for more: scrolled into view,
                it brings the next page, so the history loads as it is read. */}
            {runs.length < total && <span ref={sentinelRef} className="run-list-sentinel" aria-hidden="true" />}
          </div>
          <div className="run-output" aria-live="polite">
            <div className="run-output-head"><span>{selectedRun ? formatWhen(selectedRun.at, 'absolute') : 'Select a run'}</span>{selectedRun && <span>Run output</span>}</div>
            {runError ? <div className="panel-state"><p>Could not read this run: {runError}</p></div>
              : run === null ? <p className="list-empty">Reading run…</p>
              : run.length > 0
                ? <div className="routines-thread"><MessageList messages={run} thinking={chat.thinking} /></div>
                : <p className="list-empty">This run has no transcript.</p>}
          </div>
        </div>}
    </section>
  </Panel>
}

function NewRoutine({ chatId, chat, initialAsk = '', onBack, inSplit }: { chatId: string; chat: RoutinesChat; initialAsk?: string; onBack(): void; inSplit?: boolean }) {
  const [ask, setAsk] = useState(initialAsk)
  const [gateway, setGateway] = useState<SendTarget['gateway']>('web')
  const [target, setTarget] = useState(chatId)
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
      ? { gateway: 'web', chatId }
      : { gateway, chatId: gateway === 'none' ? chatId : target.trim() })
  }

  /** What has been asked here and answered here: nothing until the first ask. */
  const thread = createdFrom === null ? [] : chat.messages.slice(createdFrom)

  return <Panel inSplit={inSplit} head={<PageHeader
    back={!inSplit ? <button className="settings-back" type="button" onClick={onBack}><Icon name="arrow-left" /><span>Routines</span></button> : undefined}
    title="New routine"
    description="Describe the task and schedule. Milo will turn your request into a routine."
  />}>
    <div className="routine-create-form">
      <Field className="full" label="What should Milo do, and when?">
        <textarea value={ask} onChange={(event) => setAsk(event.target.value)} rows={3} placeholder="Every weekday at 8, look at the repo and tell me what moved." />
      </Field>
      {createdFrom === null && <div className="suggestion-grid routine-starters">
        {ROUTINE_STARTERS.map((starter) => <button
          key={starter.title}
          type="button"
          className="suggestion"
          title={starter.detail}
          onClick={() => setAsk(starter.prompt)}
        >
          <Icon name={starter.icon} size={16} />
          <span>{starter.title}</span>
        </button>)}
      </div>}
      <div className="routine-destination">
        <div className="routine-form-heading"><Icon name="globe" size={15} /><span>Delivery destination</span></div>
        <div className="form-grid">
          <Field label="Service"><Select
            label="Service"
            value={gateway}
            choices={GATEWAYS.map(([value, label]) => ({ value, label }))}
            onChange={(next) => {
              const picked = next as SendTarget['gateway']
              setGateway(picked)
              setTarget(picked === 'web' ? chatId : '')
            }}
          /></Field>
          <Field label="Chat id"><input value={target} onChange={(event) => setTarget(event.target.value)} placeholder="a chat or channel id" disabled={gateway === 'web' || gateway === 'none'} /><small>{gateway === 'web' ? 'This browser’s chat.' : gateway === 'none' ? 'Kept on the Routines screen — no chat.' : 'The chat to post into.'}</small></Field>
        </div>
      </div>
      <div className="ask-actions">
        <button className="button primary" type="button" disabled={!ask.trim() || chat.busy || chat.connection !== 'online'} onClick={create}>{chat.busy ? 'Milo is on it…' : 'Create routine'}</button>
        {inSplit && <button className="button" type="button" onClick={onBack}>Cancel</button>}
        {chat.connection !== 'online' && <span className={`connection-status ${chat.connection}`}><span />{chat.connection === 'refused' ? 'Disconnected' : chat.connection === 'offline' ? 'Reconnecting…' : 'Connecting…'}</span>}
      </div>
    </div>
    {thread.length > 0 && <div className="routines-thread">
      <div className="routine-thread-heading"><h3>Routine setup</h3><p className="routine-thread-subtitle">Milo’s questions and confirmation appear here.</p></div>
      <MessageList messages={thread} thinking={chat.thinking} />
      {chat.pendingPermission && <article className="message assistant">
        <Permissions request={chat.pendingPermission.request} expiresAt={chat.pendingPermission.expiresAt} onDecision={(action) => chat.decide(action)} />
      </article>}
    </div>}
  </Panel>
}
