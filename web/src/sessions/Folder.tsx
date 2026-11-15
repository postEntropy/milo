import { useEffect, useRef, useState } from 'react'
import type { SessionBackendChoice, SessionBackendKind } from '../../../src/core/sessions/types.js'
import { api } from '../lib/api.js'
import type { ProjectView } from '../../../src/core/projects.js'
import { FolderPicker } from '../work/FolderInspector.js'
import { projectMark } from '../work/marks.js'
import { Icon } from '../ui/Icons.js'
import { message } from '../lib/format.js'

/** Optional Session context, selected directly or from remembered host folders. */
export function SessionFolder({ current, recent, disabled, onChoose, onInspect, onStart, onClose }: {
  current: ProjectView | null
  recent: ProjectView[]
  disabled: boolean
  onChoose(path: string | null): Promise<void>
  onInspect(id: string): void
  onStart(id: string, backend: SessionBackendKind): void
  onClose(): void
}) {
  const [backend, setBackend] = useState<SessionBackendKind>('milo')
  const [backends, setBackends] = useState<SessionBackendChoice[]>([{ id: 'milo', available: true }])
  useEffect(() => {
    let live = true
    void api<SessionBackendChoice[]>('session-backends').then((choices) => { if (live) setBackends(choices) }).catch((error) => { if (live) setError(message(error)) })
    return () => { live = false }
  }, [])
  const dialog = useRef<HTMLDialogElement>(null)
  const [path, setPath] = useState(current?.path ?? '')
  const [browsing, setBrowsing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const origin = document.activeElement
    dialog.current?.showModal()
    return () => { if (origin instanceof HTMLElement && origin.isConnected) origin.focus() }
  }, [])
  async function choose(path: string | null): Promise<void> {
    if (saving || disabled) return
    setSaving(true)
    setError(null)
    try { await onChoose(path); onClose() }
    catch (error) { setError(message(error)) }
    finally { setSaving(false) }
  }
  return <dialog className="session-folder-dialog" ref={dialog} aria-label="Session folder" onCancel={(event) => {
    event.preventDefault()
    if (!saving) onClose()
  }}>
    <header className="folder-picker-head"><h2 className="folder-picker-heading">Folder</h2><button className="icon-button" type="button" aria-label="Close" disabled={saving} onClick={onClose}><Icon name="x" size={16} /></button></header>
    {error && <p className="session-folder-error" role="alert">{error}</p>}
    {current && <section className="session-folder-current">
      <div className="session-folder-meta">
        <h3>{current.name}</h3>
        <p className={`session-folder-path ${current.error ? 'gone' : ''}`}>{current.error ?? current.path}</p>
      </div>
      <div className="save-actions">
        <button className="button" type="button" onClick={() => onInspect(current.id)}>Files, changes &amp; rules</button>
        <button className="button" type="button" disabled={saving || disabled} onClick={() => void choose(null)}>Clear folder</button>
        <button className="button primary" type="button" disabled={saving || !!current.error} onClick={() => onStart(current.id, backend)}>New session here</button>
      </div>
    </section>}
    <form className="session-folder-form" onSubmit={(event) => { event.preventDefault(); void choose(path.trim()) }}>
      <label className="field"><span>Folder on the host</span><input value={path} placeholder="/path/to/folder" onChange={(event) => setPath(event.target.value)} /></label>
      <div className="save-actions">
        <button className="button" type="button" disabled={saving || disabled} onClick={() => setBrowsing(true)}>Browse…</button>
        <button className="button primary" type="submit" disabled={saving || disabled || !path.trim()}>{saving ? 'Changing folder…' : 'Use folder'}</button>
      </div>
    </form>
    <fieldset className="session-folder-backends" disabled={saving}><legend>New Session backend</legend><div className="save-actions">{backends.map((choice) => <button key={choice.id} className="button session-folder-backend" type="button" disabled={!choice.available} title={choice.reason} aria-pressed={backend === choice.id} onClick={() => setBackend(choice.id)}>{choice.id === 'milo' ? 'Milo' : 'Command Code'}</button>)}</div></fieldset>
    {recent.length > 0 && <section className="session-folder-recent"><h3>Recent folders</h3><div className="session-folder-list">{recent.map((project) => <div className="entry-row" key={project.id}>
      <div className="session-folder-meta">
        <span className="session-folder-name"><Icon name={projectMark(project.icon)} size={14} /><span>{project.name}</span></span>
        <p className={`session-folder-path ${project.error ? 'gone' : ''}`}>{project.error ?? project.path}</p>
      </div>
      <div className="save-actions">
        <button className="button" type="button" disabled={saving || disabled || !!project.error} onClick={() => void choose(project.path)}>Use</button>
        <button className="icon-button" type="button" disabled={saving || !!project.error} title={`New session in ${project.name}`} aria-label={`New session in ${project.name}`} onClick={() => onStart(project.id, backend)}><Icon name="plus" size={16} /></button>
      </div>
    </div>)}</div></section>}
    {disabled && <p className="session-folder-note">Folder changes are unavailable during a turn or in a Command Code Session.</p>}
    {browsing && <FolderPicker onClose={() => setBrowsing(false)} onChoose={(path) => { setBrowsing(false); setPath(path); void choose(path) }} />}
  </dialog>
}
