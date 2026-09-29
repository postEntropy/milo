import { useCallback, useEffect, useState } from 'react'
import type { PermissionRequest, SendTarget } from '@protocol'
import { api } from '../lib/api.js'
import { formatWhen, message } from '../lib/format.js'
import { Field } from '../ui/Form.js'
import { Icon } from '../ui/Icons.js'
import { MessageList, type ChatMessage } from '../chat/MessageList.js'
import { Permissions } from '../chat/Permissions.js'

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
 * The chat this screen makes routines through. The app owns the socket, so the
 * turn runs in the conversation the browser is already in and this screen draws
 * it: the field below is a way to say what you want, not a form to fill.
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
 * The routines surface: the prompts Milo runs on a timer, with their actions and
 * the one field that makes a new one — said in your own words, because turning a
 * sentence into a schedule is the model's job, not the person's. It lives here
 * rather than in Settings because a routine is a thing you use, not a setting you
 * configure — Settings keeps only what changes Milo's behaviour.
 */
export function Routines({ conversationId, chat }: { conversationId: string; chat: RoutinesChat }) {
  const [routines, setRoutines] = useState<Routine[] | null>(null)
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null)
  const [runResult, setRunResult] = useState<{ text: string; error: boolean } | null>(null)
  const [ask, setAsk] = useState('')
  const [gateway, setGateway] = useState<SendTarget['gateway']>('web')
  const [target, setTarget] = useState(conversationId)
  /** Where the creation turn starts in the chat's transcript; null until asked. */
  const [createdFrom, setCreatedFrom] = useState<number | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try { setRoutines(await api<Routine[]>('routines')) }
    catch (error) { setNotice({ text: message(error), error: true }) }
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  // biome-ignore lint/correctness/useExhaustiveDependencies: the counter is the trigger, not a value read here — the turn it counts may have just made a routine
  useEffect(() => { void refresh() }, [chat.turnEnds, refresh])

  function create(): void {
    const text = ask.trim()
    if (!text) return
    setNotice(null)
    // Taken before the turn starts: everything from here on is this ask and Milo's
    // answer to it, so the wait and the permission prompt stay beside the field.
    setCreatedFrom((from) => from ?? chat.messages.length)
    setAsk('')
    // The destination is the one thing the sentence does not have to carry. It is
    // pinned on the turn, so a routine named for Telegram is made for Telegram
    // even though the chat it was asked in is this one.
    chat.send(text, gateway === 'web'
      ? { gateway: 'web', conversationId }
      : { gateway, conversationId: target.trim() })
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

  /** What has been asked here and answered here: nothing until the first ask. */
  const thread = createdFrom === null ? [] : chat.messages.slice(createdFrom)

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
              <Field className="full" label="Ask for it in your own words">
                <textarea value={ask} onChange={(event) => setAsk(event.target.value)} rows={2} placeholder="Every weekday at 8, look at the repo and tell me what moved." />
              </Field>
              <Field label="Deliver to"><select value={gateway} onChange={(event) => {
                const next = event.target.value as SendTarget['gateway']
                setGateway(next)
                setTarget(next === 'web' ? conversationId : '')
              }}>{GATEWAYS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
              <Field label="Conversation id"><input value={target} onChange={(event) => setTarget(event.target.value)} placeholder="a chat or channel id" disabled={gateway === 'web'} /><small>{gateway === 'web' ? 'This browser’s conversation.' : 'The chat to post into.'}</small></Field>
            </div>
            <div className="ask-actions">
              <button className="button primary" type="button" disabled={!ask.trim() || chat.busy || chat.connection !== 'online'} onClick={create}>{chat.busy ? 'Milo is on it…' : 'Create it'}</button>
              {chat.connection !== 'online' && <span className={`connection-status ${chat.connection}`}><span />{chat.connection === 'offline' ? 'Reconnecting…' : 'Connecting…'}</span>}
            </div>
            {thread.length > 0 && <div className="routines-thread">
              <MessageList messages={thread} thinking={chat.thinking} />
              {chat.pendingPermission && <article className="message assistant">
                <Permissions request={chat.pendingPermission.request} expiresAt={chat.pendingPermission.expiresAt} onDecision={(allowed) => chat.decide(allowed)} />
              </article>}
            </div>}
            <p className="panel-note">Say what it should do and when, in your own words — Milo works out the time and what the routine may use. It fires only while <code className="mono">milo serve</code> is running, and anything that writes, runs or sends is granted when the routine is made: Milo asks you right here, because a scheduled run has nobody to ask.</p>
          </div>
        </section>
      </div>
    </div>
  </main>
}
