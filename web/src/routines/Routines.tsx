import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api.js'
import { formatWhen, message, splitNames } from '../lib/format.js'
import { Field } from '../ui/Form.js'
import { Icon } from '../ui/Icons.js'

type Routine = {
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

/**
 * The routines surface: the prompts Milo runs on a timer, with their actions
 * and the form that creates one. It lives here rather than in Settings because
 * a routine is a thing you use, not a setting you configure — Settings keeps
 * only what changes Milo's behaviour.
 */
export function Routines({ conversationId }: { conversationId: string }) {
  const [routines, setRoutines] = useState<Routine[] | null>(null)
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null)
  const [runResult, setRunResult] = useState<{ text: string; error: boolean } | null>(null)
  const [prompt, setPrompt] = useState('')
  const [every, setEvery] = useState('')
  const [at, setAt] = useState('')
  const [days, setDays] = useState('')
  const [allow, setAllow] = useState('')
  const [gateway, setGateway] = useState<'web' | 'telegram' | 'discord'>('web')
  const [target, setTarget] = useState(conversationId)
  const [creating, setCreating] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    try { setRoutines(await api<Routine[]>('routines')) }
    catch (error) { setNotice({ text: message(error), error: true }) }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  async function create(): Promise<void> {
    setNotice(null)
    setCreating(true)
    try {
      await api('routine-add', {
        prompt,
        every: every || undefined,
        at: at || undefined,
        days: days ? splitNames(days) : undefined,
        allow: allow ? splitNames(allow) : undefined,
        target: { gateway, conversationId: target },
      })
      setPrompt('')
      setEvery('')
      setAt('')
      setDays('')
      setAllow('')
      await refresh()
      setNotice({ text: 'Routine created.', error: false })
    } catch (error) { setNotice({ text: message(error), error: true }) }
    finally { setCreating(false) }
  }

  async function run(id: string): Promise<void> {
    setRunResult({ text: 'Running…', error: false })
    try {
      const { answer, failure } = await api<{ answer: string; failure: string | null }>('routine-run', { id })
      setRunResult({ text: failure ?? (answer || '(no answer)'), error: Boolean(failure) })
    } catch (error) { setRunResult({ text: message(error), error: true }) }
  }

  async function toggle(routine: Routine): Promise<void> {
    try { await api('routine-enable', { id: routine.id, enabled: !routine.enabled }); await refresh() }
    catch (error) { setNotice({ text: message(error), error: true }) }
  }

  async function remove(routine: Routine): Promise<void> {
    if (!window.confirm(`Remove the routine “${routine.name ?? routine.prompt}”?`)) return
    try { await api('routine-remove', { id: routine.id }); await refresh() }
    catch (error) { setNotice({ text: message(error), error: true }) }
  }

  return <main className="settings-workspace">
    <div className="settings-inner">
      {notice && <p className={`notice ${notice.error ? 'error' : 'success'}`} role="status">{notice.text}</p>}
      <div className="settings-panel-stack">
        <section className="settings-section">
          <div className="panel-head"><h2>Routines</h2><p>Prompts Milo runs on a timer, with nobody there when they fire.</p></div>
          <div className="panel-body">
            {routines === null ? <p className="list-empty">Reading…</p>
              : routines.length === 0 ? <p className="list-empty">No routines yet.</p>
              : routines.map((routine) => <div className="entry-row" key={routine.id}>
                <div>
                  <div className="secret-name">{routine.name ?? routine.prompt}</div>
                  <div className="secret-state">{routine.whenLabel} → {routine.targetLabel}{routine.allow?.length ? ` · may use ${routine.allow.join(', ')}` : ''}</div>
                  <div className="secret-state">{routine.enabled ? routine.nextRunAt ? `next ${formatWhen(routine.nextRunAt, true)}` : 'enabled' : 'paused'}{routine.lastRunAt ? ` · last ${routine.lastResult ?? 'ok'}` : ' · never run'}</div>
                </div>
                <div className="row-actions">
                  <button className="button" type="button" onClick={() => void run(routine.id)}><Icon name="play" size={13} /> Run now</button>
                  <button className="button" type="button" onClick={() => void toggle(routine)}>{routine.enabled ? 'Pause' : 'Enable'}</button>
                  <button className="button danger" type="button" onClick={() => void remove(routine)}>Remove</button>
                </div>
              </div>)}
            {runResult && <pre className={`job-log ${runResult.error ? 'error' : ''}`}>{runResult.text}</pre>}

            <h3 className="section-label" style={{ paddingInline: 0 }}>New routine</h3>
            <div className="form-grid">
              <Field className="full" label="Prompt"><input value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="look at the repo and tell me what moved" /></Field>
              <Field label="Every"><input value={every} onChange={(event) => setEvery(event.target.value)} placeholder="2h or 30m" /></Field>
              <Field label="Or at"><input value={at} onChange={(event) => setAt(event.target.value)} placeholder="08:00" /></Field>
              <Field label="Days (for a clock time)"><input value={days} onChange={(event) => setDays(event.target.value)} placeholder="mon-fri" /></Field>
              <Field label="May use (unattended)"><input value={allow} onChange={(event) => setAllow(event.target.value)} placeholder="shell_command, write_file" /></Field>
              <Field label="Deliver to"><select value={gateway} onChange={(event) => {
                const next = event.target.value as typeof gateway
                setGateway(next)
                setTarget(next === 'web' ? conversationId : '')
              }}><option value="web">This web chat</option><option value="telegram">Telegram</option><option value="discord">Discord</option></select></Field>
              <Field label="Conversation id"><input value={target} onChange={(event) => setTarget(event.target.value)} placeholder="a chat or channel id" disabled={gateway === 'web'} /><small>{gateway === 'web' ? 'This browser’s conversation.' : 'The chat to post into.'}</small></Field>
            </div>
            <button className="button primary" type="button" disabled={!prompt.trim() || creating} onClick={() => void create()}>{creating ? 'Creating…' : 'Create routine'}</button>
            <p className="panel-note">A routine fires only while <code className="mono">milo serve</code> is running. Anything that writes or runs a command must be named above — a scheduled run has nobody to ask.</p>
          </div>
        </section>
      </div>
    </div>
  </main>
}
