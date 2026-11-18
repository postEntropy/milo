import { useCallback, useEffect, useRef, useState } from 'react'
import type { CrewAvatar, CrewBot } from '../../../src/core/crew.js'
import type { DelegatedWork } from '../../../src/core/delegated-work.js'
import { api } from '../lib/api.js'
import { formatDuration } from '../../../src/util/format.ts'
import { message } from '../lib/format.js'
import { Icon } from '../ui/Icons.js'
import { PageHeader } from '../ui/PageHeader.js'
import { SkeletonList } from '../ui/Skeleton.js'
import { Panel } from '../ui/Workspace.js'
import { Field } from '../ui/Form.js'
import { Select } from '../ui/Select.js'
import './crew.css'
import { MessageList } from '../chat/MessageList.js'
import type { ChatMessage } from '../chat/message.js'
import type { TranscriptMessage } from '@protocol'
import {
  ACCESSORY_LABELS,
  BotAvatar,
  botAvatarOf,
  COLOR_PALETTES,
  CREW_AVATAR_ACCESSORIES,
  CREW_AVATAR_EYES,
  CREW_AVATAR_SHAPES,
  EYES_LABELS,
  SHAPE_LABELS,
} from './BotAvatar.js'
import { colorPalettePreset } from '../theme/palettes.js'

type WorkView = DelegatedWork & { scheduleLabel: string }

function formatTiming(startedAt?: number, finishedAt?: number): string {
  if (!startedAt) return ''
  const when = new Date(startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  if (finishedAt && finishedAt >= startedAt) {
    return `${when} · ${formatDuration(finishedAt - startedAt)}`
  }
  return when
}

export function Crew({ tick = 0 }: { tick?: number }) {
  const [bots, setBots] = useState<CrewBot[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [work, setWork] = useState<WorkView[] | null>(null)
  const [selectedWork, setSelectedWork] = useState<string | null>(null)
  const [customizing, setCustomizing] = useState(false)
  const [name, setName] = useState('')
  const [guidance, setGuidance] = useState('')
  const [objective, setObjective] = useState('')
  const [scheduleKind, setScheduleKind] = useState('every')
  const [scheduleValue, setScheduleValue] = useState('')
  const [openRun, setOpenRun] = useState<string | null>(null)
  const [transcript, setTranscript] = useState<ChatMessage[] | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const generation = useRef(0)

  const openBot = (entry: CrewBot) => {
    setSelectedWork(null)
    setOpenRun(null)
    setSelected(entry.id)
    setName(entry.name)
    setGuidance('')
    setCustomizing(false)
  }

  const openWorkItem = (entry: WorkView) => {
    setSelected(null)
    setCustomizing(false)
    setOpenRun(null)
    setSelectedWork(entry.id)
    setObjective(entry.objective)
    setScheduleKind(entry.schedule?.kind ?? 'once')
    setScheduleValue(
      entry.schedule?.kind === 'every'
        ? `${entry.schedule.minutes}m`
        : entry.schedule?.kind === 'at'
          ? entry.schedule.time
          : '',
    )
  }

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const mine = ++generation.current
    try {
      const [nextBots, nextWork] = await Promise.all([
        api<CrewBot[]>('crew', undefined, signal),
        api<WorkView[]>('delegated-work', undefined, signal),
      ])
      if (mine !== generation.current) return
      setBots(nextBots); setWork(nextWork); setError(null)
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return
      if (mine === generation.current) setError(message(cause))
    }
  }, [])

  useEffect(() => {
    let controller: AbortController | null = null
    const pull = () => {
      if (document.visibilityState === 'hidden') return
      controller?.abort()
      controller = new AbortController()
      void refresh(controller.signal)
    }
    pull()
    const timer = window.setInterval(pull, 3000)
    const onVisibility = () => { if (document.visibilityState === 'visible') pull() }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
      controller?.abort()
    }
  }, [refresh])

  useEffect(() => {
    if (!tick || document.visibilityState === 'hidden') return
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => controller.abort()
  }, [refresh, tick])

  useEffect(() => {
    if (!openRun) { setTranscript(null); setRunError(null); return }
    let live = true
    setTranscript(null)
    setRunError(null)
    void api<TranscriptMessage[]>('run-transcript', { id: openRun })
      .then((messages) => { if (live) setTranscript(messages.map((entry, index) => ({ ...entry, id: `run-${index}` }))) })
      .catch((cause) => { if (live) setRunError(message(cause)) })
    return () => { live = false }
  }, [openRun])

  const bot = bots?.find((entry) => entry.id === selected)
  const botAvatar = bot ? botAvatarOf(bot) : null
  const botState = bot?.assignments.at(-1)?.state
  const job = work?.find((entry) => entry.id === selectedWork)

  async function rename() {
    if (!bot || !name.trim()) return
    setSaving(true)
    try {
      const updated = await api<CrewBot>('crew-rename', { id: bot.id, name })
      generation.current += 1
      setBots((current) => current?.map((item) => (item.id === updated.id ? updated : item)) ?? current)
      setName(updated.name)
      setError(null)
    }
    catch (cause) { setError(message(cause)) }
    finally { setSaving(false) }
  }
  async function updateAvatar(patch: Partial<CrewAvatar> | { shuffle: true }) {
    if (!bot) return
    setSaving(true)
    try {
      const updated = await api<CrewBot>('crew-avatar', { id: bot.id, ...patch })
      generation.current += 1
      setBots((current) => current?.map((item) => (item.id === updated.id ? updated : item)) ?? current)
      setError(null)
    }
    catch (cause) { setError(message(cause)) }
    finally { setSaving(false) }
  }
  async function stop() {
    if (!bot) return
    setSaving(true)
    try { await api('crew-stop', { id: bot.id }); await refresh() }
    catch (cause) { setError(message(cause)) }
    finally { setSaving(false) }
  }
  async function guide() {
    if (!bot || !guidance.trim()) return
    setSaving(true)
    try { await api('crew-guide', { id: bot.id, text: guidance }); setGuidance(''); await refresh() }
    catch (cause) { setError(message(cause)) }
    finally { setSaving(false) }
  }
  async function control(action: 'pause' | 'resume' | 'cancel') {
    if (!job) return
    setSaving(true)
    try {
      const updated = await api<WorkView>('delegated-work-control', { id: job.id, action })
      generation.current += 1
      setWork((current) => current?.map((item) => (item.id === updated.id ? updated : item)) ?? current)
      setError(null)
    }
    catch (cause) { setError(message(cause)) }
    finally { setSaving(false) }
  }
  async function edit(patch: Record<string, unknown>) {
    if (!job) return
    setSaving(true)
    try {
      const updated = await api<WorkView>('delegated-work-edit', { id: job.id, ...patch })
      generation.current += 1
      setWork((current) => current?.map((item) => (item.id === updated.id ? updated : item)) ?? current)
      setObjective(updated.objective)
      setScheduleValue('')
      setError(null)
    }
    catch (cause) { setError(message(cause)) }
    finally { setSaving(false) }
  }

  const head = job
    ? <PageHeader title={job.name} description={job.scheduleLabel} back={<button className="settings-back" type="button" onClick={() => { setSelectedWork(null); setOpenRun(null) }}><Icon name="arrow-left" /><span>Crew</span></button>} />
    : bot
      ? <PageHeader title={bot.name} description="Bot assignments and appearance." back={<button className="settings-back" type="button" onClick={() => { setSelected(null); setCustomizing(false) }}><Icon name="arrow-left" /><span>Crew</span></button>} />
      : <PageHeader title="Crew" description="The work and bots Milo is looking after." />

  return <div className="crew-page"><Panel head={head}>
    {error && <div className="panel-state" role="alert">{error}</div>}
    {bots === null || work === null ? <SkeletonList rows={4} label="Loading Crew…" /> : job ? <>
      <div className="crew-work-hero">
        <div className="crew-work-hero-head">
          <h3>Objective</h3>
          <span className={`crew-badge ${job.state}`}>{job.state}{job.pauseAfterRun ? ' · pausing after this run' : ''}</span>
        </div>
        <p className="crew-work-objective">{job.objective}</p>
        <span className="routine-row-meta">{job.scheduleLabel} · Allowed tools: {job.allow.length ? job.allow.join(', ') : 'none'}</span>
        <div className="crew-actions-row">
          {(job.state === 'queued' || job.state === 'running' || job.state === 'waiting') && <button className="button" type="button" disabled={saving || job.pauseAfterRun} onClick={() => void control('pause')}>Pause</button>}
          {(['paused', 'failed', 'interrupted'] as string[]).includes(job.state) && <button className="button primary" type="button" disabled={saving} onClick={() => void control('resume')}>Resume</button>}
          {!['completed', 'cancelled'].includes(job.state) && <button className="button danger" type="button" disabled={saving} onClick={() => void control('cancel')}>Cancel work</button>}
        </div>
      </div>
      {!['running', 'completed', 'cancelled'].includes(job.state) && <div className="crew-edit-grid">
        <form className="crew-surface-card" onSubmit={(event) => { event.preventDefault(); void edit({ objective }) }}>
          <Field label="Objective"><textarea value={objective} onChange={(event) => setObjective(event.target.value)} /></Field>
          <button className="button primary" type="submit" disabled={saving || !objective.trim() || objective.trim() === job.objective.trim()}>Save objective</button>
        </form>
        <form className="crew-surface-card" onSubmit={(event) => { event.preventDefault(); void edit(scheduleKind === 'once' ? { once: true } : { [scheduleKind]: scheduleValue }) }}>
          <Field label="Schedule"><Select label="Schedule" value={scheduleKind} onChange={setScheduleKind} choices={[{ value: 'every', label: 'Interval' }, { value: 'at', label: 'Daily time' }, { value: 'once', label: 'Run once' }]} /></Field>
          {scheduleKind !== 'once' && <Field label={scheduleKind === 'every' ? 'Interval, for example 2h' : 'Time, for example 08:00'}><input value={scheduleValue} onChange={(event) => setScheduleValue(event.target.value)} /></Field>}
          <button className="button primary" type="submit" disabled={saving || (scheduleKind !== 'once' && !scheduleValue.trim())}>Save schedule</button>
        </form>
      </div>}
      <h3 className="crew-section-title">Runs</h3>
      {job.runs.length === 0 && <p>No runs yet.</p>}
      {[...job.runs].reverse().map((run) => {
        const timing = formatTiming(run.startedAt, run.finishedAt)
        const showTranscript = Boolean(run.sessionId && openRun === run.sessionId)
        return <section className="crew-history" key={run.id}><div className="routine-row-main">
          <div className="crew-card-head">
            <div className="crew-card-meta-group">
              <span className={`crew-badge ${run.result}`}>{run.result}</span>
              {timing && <span className="routine-row-meta">{timing}</span>}
            </div>
            {run.sessionId && <button className="button" type="button" onClick={() => setOpenRun(openRun === run.sessionId ? null : run.sessionId!)}>{openRun === run.sessionId ? 'Hide run' : 'Open run'}</button>}
          </div>
          {run.report && (!showTranscript || (transcript !== null && transcript.length === 0)) && <p>{run.report}</p>}
          {run.failure && <p role="alert">{run.failure}</p>}
          {run.deliveryError && <p role="alert">Could not deliver: {run.deliveryError}</p>}
          {showTranscript && (runError
            ? <p role="alert">{runError}</p>
            : transcript === null
              ? <p>Reading run…</p>
              : transcript.length === 0
                ? <p className="routine-row-meta">No transcript stored for this run.</p>
                : <MessageList messages={transcript} thinking="collapsed" />)}
          <div className="crew-chip-row">
            {bots.filter((entry) => entry.assignments.some((assignment) => assignment.sessionId === run.sessionId)).map((entry) => <button className="button crew-bot-chip" type="button" key={entry.id} onClick={() => openBot(entry)}><BotAvatar avatar={botAvatarOf(entry)} state={entry.assignments.at(-1)?.state} size={22} /><span>{entry.name}</span></button>)}
          </div>
        </div></section>
      })}
    </> : bots.length === 0 && work.length === 0 ? <div className="panel-empty">
      <h3>No bots yet</h3><p className="panel-empty-copy">Ask Milo for help with a task. When it delegates, the bots appear here.</p>
    </div> : bot && botAvatar ? <>
      <div className="crew-bot-hero">
        <BotAvatar avatar={botAvatar} state={botState} size={76} />
        <div className="crew-bot-hero-main">
          <div className="crew-card-head">
            <h3>{bot.name}</h3>
            {botState && <span className={`crew-badge ${botState}`}>{botState}</span>}
          </div>
          <span className="routine-row-meta">{SHAPE_LABELS[botAvatar.shape]} · {EYES_LABELS[botAvatar.eyes]} eyes{botAvatar.accessory !== 'none' ? ` · ${ACCESSORY_LABELS[botAvatar.accessory]}` : ''}</span>
          <form className="crew-inline-form" onSubmit={(event) => { event.preventDefault(); void rename() }}>
            <label className="sr-only" htmlFor="crew-name">Name</label>
            <input id="crew-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Bot name" />
            <button className="button primary" type="submit" disabled={saving || !name.trim() || name.trim() === bot.name}>Save</button>
          </form>
        </div>
        <div className="crew-hero-actions">
          <button className="button" type="button" disabled={saving} onClick={() => void updateAvatar({ shuffle: true })}>Shuffle avatar</button>
          <button className="button" type="button" onClick={() => setCustomizing((current) => !current)}>{customizing ? 'Done' : 'Customize'}</button>
        </div>
      </div>
      {customizing && <section className="crew-avatar-studio" aria-label="Bot appearance">
        <div className="crew-avatar-group">
          <span className="crew-avatar-label">Shape</span>
          <div className="crew-avatar-choices">
            {CREW_AVATAR_SHAPES.map((shape) => <button key={shape} type="button" aria-pressed={botAvatar.shape === shape} className={`crew-avatar-choice ${botAvatar.shape === shape ? 'active' : ''}`} disabled={saving} onClick={() => void updateAvatar({ shape })}><BotAvatar avatar={{ ...botAvatar, shape }} size={22} /><span>{SHAPE_LABELS[shape]}</span></button>)}
          </div>
        </div>
        <div className="crew-avatar-group">
          <span className="crew-avatar-label">Eyes</span>
          <div className="crew-avatar-choices">
            {CREW_AVATAR_EYES.map((eyes) => <button key={eyes} type="button" aria-pressed={botAvatar.eyes === eyes} className={`crew-avatar-choice ${botAvatar.eyes === eyes ? 'active' : ''}`} disabled={saving} onClick={() => void updateAvatar({ eyes })}><BotAvatar avatar={{ ...botAvatar, eyes }} size={22} /><span>{EYES_LABELS[eyes]}</span></button>)}
          </div>
        </div>
        <div className="crew-avatar-group">
          <span className="crew-avatar-label">Accessory</span>
          <div className="crew-avatar-choices">
            {CREW_AVATAR_ACCESSORIES.map((accessory) => <button key={accessory} type="button" aria-pressed={botAvatar.accessory === accessory} className={`crew-avatar-choice ${botAvatar.accessory === accessory ? 'active' : ''}`} disabled={saving} onClick={() => void updateAvatar({ accessory })}><BotAvatar avatar={{ ...botAvatar, accessory }} size={22} /><span>{ACCESSORY_LABELS[accessory]}</span></button>)}
          </div>
        </div>
        <div className="crew-avatar-group">
          <span className="crew-avatar-label">Color</span>
          <div className="crew-avatar-choices">
            {COLOR_PALETTES.map((palette) => {
              const [top, bottom] = colorPalettePreset(palette.id).logoColors
              return <button key={palette.id} type="button" aria-pressed={botAvatar.palette === palette.id} className={`crew-avatar-choice ${botAvatar.palette === palette.id ? 'active' : ''}`} disabled={saving} onClick={() => void updateAvatar({ palette: palette.id })}><span className="crew-color-dot" style={{ background: `linear-gradient(135deg, ${top}, ${bottom})` }} /><span>{palette.label}</span></button>
            })}
          </div>
        </div>
      </section>}
      {bot.assignments.some((entry) => entry.state === 'running') && <div className="crew-live-bar">
        {bot.assignments.some((entry) => entry.state === 'running' && !entry.stopRequestedAt) && <form className="crew-inline-form crew-guide-form" onSubmit={(event) => { event.preventDefault(); void guide() }}>
          <label htmlFor="crew-guidance">Guide bot</label>
          <input id="crew-guidance" value={guidance} onChange={(event) => setGuidance(event.target.value)} placeholder={`Steer ${bot.name} on its next step…`} />
          <button className="button primary" type="submit" disabled={saving || !guidance.trim()}>Send</button>
        </form>}
        {(() => {
          const stopping = bot.assignments.some((entry) => entry.state === 'running' && Boolean(entry.stopRequestedAt))
          return <button className="button danger" type="button" onClick={() => void stop()} disabled={saving || stopping}>{stopping ? 'Stopping…' : 'Stop bot'}</button>
        })()}
      </div>}
      <h3 className="crew-section-title">Assignments</h3>
      {[...bot.assignments].reverse().map((assignment) => {
        const timing = formatTiming(assignment.startedAt, assignment.finishedAt)
        return <section className="crew-history" key={assignment.id}>
          <div className="routine-row-main">
            <div className="crew-card-head">
              <strong>{assignment.mission}</strong>
              <span className={`crew-badge ${assignment.state}`}>{assignment.state}</span>
            </div>
            <span className="routine-row-meta">{assignment.provider ? `${assignment.provider} · ` : ''}{assignment.model}{timing ? ` · ${timing}` : ''}</span>
            {assignment.guidance?.map((item) => <p className="crew-guidance-pill" key={item.id}>{item.text} · {item.appliedAt ? 'Applied' : assignment.state === 'running' ? 'Queued' : 'Not applied'}</p>)}
            {assignment.report && <p>{assignment.report}</p>}
          </div>
        </section>
      })}
    </> : <>
    {bots.length > 0 && <>
      <h3 className="crew-section-title">Bots</h3>
      <div className="crew-grid">{bots.map((entry) => {
        const last = entry.assignments.at(-1)
        const avatar = botAvatarOf(entry)
        return <button className={`crew-bot-card ${last?.state === 'running' ? 'is-running' : ''}`} type="button" key={entry.id} onClick={() => openBot(entry)}>
          <div className="crew-bot-card-top">
            <BotAvatar avatar={avatar} state={last?.state} size={52} />
            <div className="crew-bot-card-identity">
              <div className="crew-card-head">
                <span className="routine-row-name">{entry.name}</span>
                {last?.state && <span className={`crew-badge ${last.state}`}>{last.state}</span>}
              </div>
              <span className="crew-bot-card-model">{last?.provider ? `${last.provider} · ` : ''}{last?.model ?? SHAPE_LABELS[avatar.shape]}</span>
            </div>
          </div>
          {last?.mission && <p className="crew-bot-card-mission">{last.mission}</p>}
          {last?.report && last.state !== 'running' && <p className="crew-bot-card-report">{last.report}</p>}
        </button>
      })}</div>
    </>}
    {work.length > 0 && <>
      <h3 className="crew-section-title">Delegated work</h3>
      <div className="crew-work-grid">{work.map((entry) => {
        const runIds = new Set(entry.runs.map((r) => r.sessionId).filter(Boolean))
        const assignedBots = bots.filter((b) => b.assignments.some((a) => runIds.has(a.sessionId)))
        return <button className="crew-work-card" type="button" key={entry.id} onClick={() => openWorkItem(entry)}>
          <div className="crew-card-head">
            <span className="routine-row-name">{entry.name}</span>
            <span className={`crew-badge ${entry.state}`}>{entry.state}</span>
          </div>
          <p className="crew-bot-card-mission">{entry.objective}</p>
          <div className="crew-work-card-foot">
            <span className="routine-row-meta">{entry.scheduleLabel}</span>
            {assignedBots.length > 0 && <span className="crew-avatar-stack">
              {assignedBots.slice(0, 4).map((b) => <BotAvatar key={b.id} avatar={botAvatarOf(b)} size={22} />)}
            </span>}
          </div>
        </button>
      })}</div>
    </>}</>}
  </Panel></div>
}
