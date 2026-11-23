import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
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
  normalizeBotHandle,
  shuffleBotAvatar,
  slugifyBotHandle,
} from '../../../src/core/crew-avatars.js'
import {
  ACCESSORY_LABELS,
  BotAvatar,
  botAvatarOf,
  botToneOf,
  COLOR_PALETTES,
  CREW_AVATAR_ACCESSORIES,
  CREW_AVATAR_EYES,
  CREW_AVATAR_SHAPES,
  EYES_LABELS,
  SHAPE_LABELS,
} from './BotAvatar.js'
import { colorPalettePreset } from '../theme/palettes.js'

const BOT_ROLE_STARTERS = [
  {
    name: 'Researcher',
    icon: 'search' as const,
    summary: 'Verify sources, compare options, and report concisely.',
    instructions: 'Verify facts against primary sources or files before concluding. Compare trade-offs clearly and keep reports concise with concrete findings.',
  },
  {
    name: 'Code reviewer',
    icon: 'shield' as const,
    summary: 'Inspect changes for edge cases and missing tests.',
    instructions: 'Review diffs for correctness, edge cases, regressions, and missing tests. Report concrete issues first with exact file references.',
  },
  {
    name: 'Planner',
    icon: 'list-check' as const,
    summary: 'Break goals into steps, risks, and next actions.',
    instructions: 'Turn open-ended goals into ordered, actionable steps. Surface dependencies, open questions, and risks before execution.',
  },
]

type WorkView = DelegatedWork & { scheduleLabel: string }

function formatTiming(startedAt?: number, finishedAt?: number): string {
  if (!startedAt) return ''
  const when = new Date(startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  if (finishedAt && finishedAt >= startedAt) {
    return `${when} · ${formatDuration(finishedAt - startedAt)}`
  }
  return when
}

export function Crew({ tick = 0, onChatWithBot }: { tick?: number; onChatWithBot?: (botId: string) => void }) {
  const [bots, setBots] = useState<CrewBot[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [work, setWork] = useState<WorkView[] | null>(null)
  const [selectedWork, setSelectedWork] = useState<string | null>(null)
  const [customizing, setCustomizing] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newHandle, setNewHandle] = useState('')
  const [newInstructions, setNewInstructions] = useState('')
  const [newAvatar, setNewAvatar] = useState<CrewAvatar>(() => shuffleBotAvatar())
  const [name, setName] = useState('')
  const [handle, setHandle] = useState('')
  const [instructions, setInstructions] = useState('')
  const [guidance, setGuidance] = useState('')
  const [objective, setObjective] = useState('')
  const [scheduleKind, setScheduleKind] = useState('every')
  const [scheduleValue, setScheduleValue] = useState('')
  const [openRun, setOpenRun] = useState<string | null>(null)
  const [transcript, setTranscript] = useState<ChatMessage[] | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const generation = useRef(0)

  const openBot = (entry: CrewBot) => {
    setSelectedWork(null)
    setOpenRun(null)
    setCreating(false)
    setSelected(entry.id)
    setName(entry.name)
    setHandle(entry.handle ?? '')
    setInstructions(entry.instructions ?? '')
    setGuidance('')
    setCustomizing(false)
  }

  const openWorkItem = (entry: WorkView) => {
    setSelected(null)
    setCustomizing(false)
    setOpenRun(null)
    setSelectedWork(entry.id)
    setObjective(entry.objective)
    const restricted = entry.schedule?.kind === 'at' && Boolean(entry.schedule.days || entry.schedule.dayOfMonth || entry.schedule.month)
    setScheduleKind(restricted ? 'existing' : entry.schedule?.kind ?? 'once')
    setScheduleValue(
      entry.schedule?.kind === 'every'
        ? entry.scheduleLabel.replace(/^every /, '')
        : entry.schedule?.kind === 'at'
          ? entry.schedule.time
          : '',
    )
  }

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const mine = ++generation.current
    const [botsResult, workResult] = await Promise.allSettled([
      api<CrewBot[]>('crew', { includeArchived: true }, signal),
      api<WorkView[]>('delegated-work', undefined, signal),
    ])
    if (mine !== generation.current) return
    const aborted = [botsResult, workResult].some(
      (result) => result.status === 'rejected' && result.reason instanceof DOMException && result.reason.name === 'AbortError',
    )
    if (aborted) return
    if (botsResult.status === 'fulfilled') setBots(botsResult.value)
    if (workResult.status === 'fulfilled') setWork(workResult.value)
    else if (botsResult.status === 'fulfilled') setWork((current) => current ?? [])
    const failed = [botsResult, workResult].find((result): result is PromiseRejectedResult => result.status === 'rejected')
    setRefreshError(failed ? message(failed.reason) : null)
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
  const botRunning = bot?.assignments.some((entry) => entry.state === 'running') ?? false
  const activeBots = bots?.filter((entry) => entry.archivedAt === undefined) ?? []
  const archivedBots = bots?.filter((entry) => entry.archivedAt !== undefined) ?? []
  const job = work?.find((entry) => entry.id === selectedWork)

  const renderBotCard = (entry: CrewBot) => {
    const last = entry.assignments.at(-1)
    const avatar = botAvatarOf(entry)
    return <button className={`crew-bot-card ${last?.state === 'running' ? 'is-running' : ''} ${entry.archivedAt !== undefined ? 'is-archived' : ''}`} type="button" key={entry.id} onClick={() => openBot(entry)}>
      <div className="crew-bot-card-top">
        <span className="crew-bot-stage" style={{ '--bot-tone': botToneOf(avatar) } as CSSProperties}>
          <BotAvatar avatar={avatar} state={last?.state} size={62} />
        </span>
        <div className="crew-bot-card-identity">
          <div className="crew-card-head">
            <span className="routine-row-name">{entry.name}</span>
            {last?.state && <span className={`crew-badge ${last.state}`}>{last.state}</span>}
          </div>
          <span className="crew-bot-card-model">
            {entry.handle && entry.archivedAt === undefined ? `@${entry.handle} · ` : ''}
            {last?.provider ? `${last.provider} · ` : ''}{last?.model ?? SHAPE_LABELS[avatar.shape]}
          </span>
        </div>
      </div>
      {entry.instructions && !last?.mission && <p className="crew-instructions-preview">{entry.instructions}</p>}
      {last?.mission && <p className="crew-bot-card-mission">{last.mission}</p>}
      {last?.report && last.state !== 'running' && <p className="crew-bot-card-report">{last.report}</p>}
    </button>
  }

  async function createBot() {
    if (!newName.trim()) return
    setSaving(true)
    try {
      const created = await api<CrewBot>('crew-create', {
        name: newName,
        ...(newHandle.trim() ? { handle: newHandle } : {}),
        ...(newInstructions.trim() ? { instructions: newInstructions } : {}),
        avatar: newAvatar,
      })
      generation.current += 1
      setBots((current) => [created, ...(current ?? [])])
      setCreating(false)
      setNewName('')
      setNewHandle('')
      setNewInstructions('')
      openBot(created)
      setError(null)
    }
    catch (cause) { setError(message(cause)) }
    finally { setSaving(false) }
  }
  async function saveProfile() {
    if (!bot || !name.trim()) return
    setSaving(true)
    try {
      const updated = await api<CrewBot>('crew-update', {
        id: bot.id,
        name,
        handle,
        instructions,
      })
      generation.current += 1
      setBots((current) => current?.map((item) => (item.id === updated.id ? updated : item)) ?? current)
      setName(updated.name)
      setHandle(updated.handle ?? '')
      setInstructions(updated.instructions ?? '')
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
  async function keepBot() {
    if (!bot) return
    setSaving(true)
    try {
      const updated = await api<CrewBot>('crew-keep', { id: bot.id })
      generation.current += 1
      setBots((current) => current?.map((item) => (item.id === updated.id ? updated : item)) ?? current)
      setError(null)
    }
    catch (cause) { setError(message(cause)) }
    finally { setSaving(false) }
  }
  async function removeBot() {
    if (!bot || botRunning) return
    if (!window.confirm(`Remove bot “${bot.name}” and its assignment history?`)) return
    setSaving(true)
    try {
      await api('crew-remove', { id: bot.id })
      generation.current += 1
      setBots((current) => current?.filter((item) => item.id !== bot.id) ?? current)
      setSelected(null)
      setCustomizing(false)
      setError(null)
    }
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
      setScheduleKind(updated.schedule?.kind === 'at' && (updated.schedule.days || updated.schedule.dayOfMonth || updated.schedule.month) ? 'existing' : updated.schedule?.kind ?? 'once')
      setScheduleValue(updated.schedule?.kind === 'every' ? updated.scheduleLabel.replace(/^every /, '') : updated.schedule?.kind === 'at' ? updated.schedule.time : '')
      setError(null)
    }
    catch (cause) { setError(message(cause)) }
    finally { setSaving(false) }
  }

  const openCreate = () => {
    setError(null)
    setNewName('')
    setNewHandle('')
    setNewInstructions('')
    setNewAvatar(shuffleBotAvatar())
    setCreating(true)
  }

  const head = job
    ? <PageHeader title={job.name} description={job.scheduleLabel} back={<button className="settings-back" type="button" onClick={() => { setSelectedWork(null); setOpenRun(null) }}><Icon name="arrow-left" /><span>Crew</span></button>} />
    : bot
      ? <PageHeader title={bot.name} description="Bot assignments and appearance." back={<button className="settings-back" type="button" onClick={() => { setSelected(null); setCustomizing(false) }}><Icon name="arrow-left" /><span>Crew</span></button>} />
      : <PageHeader title="Crew" description="The work and bots Milo is looking after." />

  return <div className="crew-page"><Panel head={head}>
    {((!creating && error) || refreshError) && <div className="panel-state" role="alert">{(!creating && error) || refreshError}{!creating && error && <button className="button" type="button" onClick={() => setError(null)}>Dismiss</button>}</div>}
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
        <form className="crew-surface-card" onSubmit={(event) => { event.preventDefault(); const schedule = job.schedule; void edit(scheduleKind === 'once' ? { once: true } : scheduleKind === 'existing' && schedule?.kind === 'at' ? { at: scheduleValue, ...(schedule.days ? { days: schedule.days.map(String) } : {}), ...(schedule.dayOfMonth ? { dayOfMonth: schedule.dayOfMonth.map(String) } : {}), ...(schedule.month ? { month: schedule.month.map(String) } : {}) } : { [scheduleKind]: scheduleValue }) }}>
          <Field label="Schedule"><Select label="Schedule" value={scheduleKind} onChange={setScheduleKind} choices={[...(job.schedule?.kind === 'at' && (job.schedule.days || job.schedule.dayOfMonth || job.schedule.month) ? [{ value: 'existing', label: job.scheduleLabel }] : []), { value: 'every', label: 'Interval' }, { value: 'at', label: 'Daily time' }, { value: 'once', label: 'Run once' }]} /></Field>
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
            {bots.filter((entry) => entry.assignments.some((assignment) => assignment.sessionId === run.sessionId)).map((entry) => <button className="button crew-bot-chip" type="button" key={entry.id} onClick={() => openBot(entry)}><BotAvatar avatar={botAvatarOf(entry)} state={entry.assignments.at(-1)?.state} size={28} /><span>{entry.name}</span></button>)}
          </div>
        </div></section>
      })}
    </> : !creating && bots.length === 0 && work.length === 0 ? <div className="panel-empty">
      <h3>No bots yet</h3>
      <p className="panel-empty-copy">Create a bot with permanent instructions to chat with it or mention it with @, or ask Milo to delegate a task.</p>
      <button className="button primary" type="button" onClick={() => setCreating(true)}>New bot</button>
    </div> : bot && botAvatar ? <>
      <div className="crew-bot-hero">
        <span className="crew-bot-stage is-hero" style={{ '--bot-tone': botToneOf(botAvatar) } as CSSProperties}>
          <BotAvatar avatar={botAvatar} state={botState} size={92} animated />
        </span>
        <div className="crew-bot-hero-main">
          <div className="crew-card-head">
            <h3>{bot.name}</h3>
            <div className="crew-card-meta-group">
              {bot.archivedAt !== undefined && <span className="crew-badge">archived</span>}
              {botState && <span className={`crew-badge ${botState}`}>{botState}</span>}
            </div>
          </div>
          <span className="routine-row-meta">
            {bot.handle ? <><span className="crew-handle">@{bot.handle}</span> · </> : null}
            {SHAPE_LABELS[botAvatar.shape]} · {EYES_LABELS[botAvatar.eyes]} eyes{botAvatar.accessory !== 'none' ? ` · ${ACCESSORY_LABELS[botAvatar.accessory]}` : ''}
          </span>
        </div>
        <div className="crew-hero-actions">
          {bot.archivedAt !== undefined
            ? <button className="button primary" type="button" disabled={saving} onClick={() => void keepBot()}>Keep in Crew</button>
            : onChatWithBot && <button className="button primary" type="button" disabled={saving} onClick={() => onChatWithBot(bot.id)}>Chat with bot</button>}
          <button className="button" type="button" disabled={saving} onClick={() => void updateAvatar({ shuffle: true })}>Shuffle avatar</button>
          <button className="button" type="button" onClick={() => setCustomizing((current) => !current)}>{customizing ? 'Done' : 'Customize'}</button>
          <button
            className="button danger"
            type="button"
            disabled={saving || botRunning}
            title={botRunning ? 'Stop the bot before removing it.' : 'Remove this bot and its assignment history'}
            onClick={() => void removeBot()}
          >
            Remove bot
          </button>
        </div>
      </div>
      <form className="crew-profile-card" onSubmit={(event) => { event.preventDefault(); void saveProfile() }}>
        <div className="crew-profile-grid">
          <Field label="Display name"><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Bot display name" /></Field>
          <Field label="Mention handle (@name)"><input value={handle} onChange={(event) => setHandle(event.target.value)} placeholder="e.g. researcher" /></Field>
        </div>
        <Field label="Permanent instructions">
          <textarea value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder="Define this bot's role, perspective, and style. Folder rules and Session permissions still apply." />
        </Field>
        <div className="crew-actions-row">
          <button
            className="button primary"
            type="submit"
            disabled={
              saving ||
              !name.trim() ||
              (name.trim() === bot.name &&
                handle.trim().replace(/^@+/, '').toLowerCase() === (bot.handle ?? '') &&
                instructions.trim() === (bot.instructions ?? ''))
            }
          >
            Save profile
          </button>
        </div>
      </form>
      {customizing && <section className="crew-avatar-studio" aria-label="Bot appearance">
        <div className="crew-avatar-group">
          <span className="crew-avatar-label">Shape</span>
          <div className="crew-avatar-choices">
            {CREW_AVATAR_SHAPES.map((shape) => <button key={shape} type="button" aria-pressed={botAvatar.shape === shape} className={`crew-avatar-choice ${botAvatar.shape === shape ? 'active' : ''}`} disabled={saving} onClick={() => void updateAvatar({ shape })}><BotAvatar avatar={{ ...botAvatar, shape }} size={34} /><span>{SHAPE_LABELS[shape]}</span></button>)}
          </div>
        </div>
        <div className="crew-avatar-group">
          <span className="crew-avatar-label">Eyes</span>
          <div className="crew-avatar-choices">
            {CREW_AVATAR_EYES.map((eyes) => <button key={eyes} type="button" aria-pressed={botAvatar.eyes === eyes} className={`crew-avatar-choice ${botAvatar.eyes === eyes ? 'active' : ''}`} disabled={saving} onClick={() => void updateAvatar({ eyes })}><BotAvatar avatar={{ ...botAvatar, eyes }} size={34} /><span>{EYES_LABELS[eyes]}</span></button>)}
          </div>
        </div>
        <div className="crew-avatar-group">
          <span className="crew-avatar-label">Accessory</span>
          <div className="crew-avatar-choices">
            {CREW_AVATAR_ACCESSORIES.map((accessory) => <button key={accessory} type="button" aria-pressed={botAvatar.accessory === accessory} className={`crew-avatar-choice ${botAvatar.accessory === accessory ? 'active' : ''}`} disabled={saving} onClick={() => void updateAvatar({ accessory })}><BotAvatar avatar={{ ...botAvatar, accessory }} size={34} /><span>{ACCESSORY_LABELS[accessory]}</span></button>)}
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
      {bot.assignments.length === 0 && <p className="routine-row-meta">No missions yet. Mention @{bot.handle ?? bot.name.toLowerCase()} in a Session or click Chat with bot above.</p>}
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
    {bots.length === 0 && work.length === 0 ? <div className="crew-empty-card">
      <h3>No bots yet</h3>
      <p>Create a bot with permanent instructions to chat with it or mention it with @, or ask Milo to delegate a task.</p>
      <div className="crew-actions-row">
        <button className="button primary" type="button" onClick={openCreate}><Icon name="plus" size={15} /> New bot</button>
      </div>
    </div> : <div className="crew-toolbar">
      <button className="button primary" type="button" onClick={openCreate}><Icon name="plus" size={15} /> New bot</button>
    </div>}
    {activeBots.length > 0 && <>
      <h3 className="crew-section-title">Bots</h3>
      <div className="crew-grid">{activeBots.map(renderBotCard)}</div>
    </>}
    {archivedBots.length > 0 && <div className="crew-archived-section">
      <button
        className="crew-archived-toggle"
        type="button"
        aria-expanded={showArchived}
        onClick={() => setShowArchived((current) => !current)}
      >
        <Icon name="chevron" size={14} />
        <span>Archived task bots ({archivedBots.length})</span>
      </button>
      {showArchived && <div className="crew-grid">{archivedBots.map(renderBotCard)}</div>}
    </div>}
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
              {assignedBots.slice(0, 4).map((b) => <BotAvatar key={b.id} avatar={botAvatarOf(b)} size={28} />)}
            </span>}
          </div>
        </button>
      })}</div>
    </>}</>}
  </Panel>
  {creating && <NewBotDrawer
    name={newName}
    handle={newHandle}
    instructions={newInstructions}
    avatar={newAvatar}
    saving={saving}
    error={error}
    onNameChange={setNewName}
    onHandleChange={setNewHandle}
    onInstructionsChange={setNewInstructions}
    onShuffleAvatar={() => setNewAvatar((current) => shuffleBotAvatar(current))}
    onDismissError={() => setError(null)}
    onClose={() => setCreating(false)}
    onSubmit={() => void createBot()}
  />}
  </div>
}

function NewBotDrawer({
  name,
  handle,
  instructions,
  avatar,
  saving,
  error,
  onNameChange,
  onHandleChange,
  onInstructionsChange,
  onShuffleAvatar,
  onDismissError,
  onClose,
  onSubmit,
}: {
  name: string
  handle: string
  instructions: string
  avatar: CrewAvatar
  saving: boolean
  error: string | null
  onNameChange: (value: string) => void
  onHandleChange: (value: string) => void
  onInstructionsChange: (value: string) => void
  onShuffleAvatar: () => void
  onDismissError: () => void
  onClose: () => void
  onSubmit: () => void
}) {
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const previous = document.activeElement
    nameRef.current?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeRef.current()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])

  const trimmedName = name.trim()
  const normalizedHandle = normalizeBotHandle(handle)
  const previewHandle = normalizedHandle || (trimmedName ? slugifyBotHandle(trimmedName) : 'bot')

  return <div className="routine-drawer-layer" role="dialog" aria-modal="true" aria-label="New bot">
    <button className="routine-drawer-scrim" type="button" aria-label="Close new bot" onClick={onClose} />
    <div className="routine-drawer">
      <Panel head={<PageHeader
        back={<button className="settings-back" type="button" onClick={onClose}><Icon name="x" /><span>Close</span></button>}
        title="New bot"
        description="Give your teammate a name, @handle, and permanent instructions."
      />}>
        <form className="crew-new-form" onSubmit={(event) => { event.preventDefault(); onSubmit() }}>
          {error && <div className="panel-state" role="alert">{error}<button className="button" type="button" onClick={onDismissError}>Dismiss</button></div>}
          <div className="crew-new-preview">
            <span className="crew-bot-stage" style={{ '--bot-tone': botToneOf(avatar) } as CSSProperties}>
              <BotAvatar avatar={avatar} size={62} animated />
            </span>
            <div className="crew-new-preview-copy">
              <strong className={trimmedName ? '' : 'is-placeholder'}>{trimmedName || 'New teammate'}</strong>
              <span className="crew-handle">@{previewHandle}</span>
            </div>
            <button className="button crew-shuffle-button" type="button" onClick={onShuffleAvatar} aria-label="Shuffle avatar">
              <Icon name="shuffle" size={15} />
              <span>Shuffle</span>
            </button>
          </div>
          <div className="crew-profile-card crew-new-identity">
            <Field label="Display name">
              <input ref={nameRef} value={name} onChange={(event) => onNameChange(event.target.value)} placeholder="e.g. Scout" />
            </Field>
            <Field label="Mention handle">
              <div className="crew-handle-input">
                <span className="crew-handle-prefix" aria-hidden="true">@</span>
                <input value={handle} onChange={(event) => onHandleChange(event.target.value)} placeholder="optional" />
              </div>
            </Field>
          </div>
          <div className="crew-new-instructions">
            <Field label="Permanent instructions">
              <textarea
                rows={4}
                value={instructions}
                onChange={(event) => onInstructionsChange(event.target.value)}
                placeholder="Role, perspective, tone, or rules to follow in every Session…"
              />
            </Field>
            {!instructions.trim() && <div className="crew-starter-list">
              {BOT_ROLE_STARTERS.map((starter) => <button
                key={starter.name}
                type="button"
                className="crew-starter-card"
                onClick={() => {
                  if (!trimmedName) onNameChange(starter.name)
                  onInstructionsChange(starter.instructions)
                }}
              >
                <span className="crew-starter-icon"><Icon name={starter.icon} size={15} /></span>
                <span className="crew-starter-copy">
                  <strong>{starter.name}</strong>
                  <span>{starter.summary}</span>
                </span>
              </button>)}
            </div>}
          </div>
          <div className="crew-actions-row">
            <button className="button primary" type="submit" disabled={saving || !trimmedName}>
              <Icon name="plus" size={15} />
              <span>{saving ? 'Creating…' : 'Create bot'}</span>
            </button>
            <button className="button" type="button" onClick={onClose}>Cancel</button>
          </div>
        </form>
      </Panel>
    </div>
  </div>
}
