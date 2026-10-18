import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { api } from '../lib/api.js'
import { formatWhen, message } from '../lib/format.js'
import { sessionLabel } from '../../../src/core/sessions/format.ts'
import { Field } from '../ui/Form.js'
import { Icon } from '../ui/Icons.js'
import { Notice, useAutoDismiss } from '../ui/Notice.js'
import { PageHeader } from '../ui/PageHeader.js'
import { SkeletonList } from '../ui/Skeleton.js'

/** A folder a session may work in, as the daemon reports it. */
type Project = { id: string; name: string; path: string; createdAt: number; error?: string }
/** A directory of the machine Milo runs on, as the daemon lists it. */
type FolderListing = {
  path: string
  name: string
  parent?: string
  folders: Array<{ name: string; path: string }>
  truncated: boolean
}
/** The part of a session this screen reads: which project it works in, and what it is. */
type WorkSession = {
  id: string
  title?: string
  preview: string
  messageCount: number
  updatedAt: number
  project?: string
  running?: boolean
}

/**
 * Work: the folders a session may work in, and the sessions that ran in one.
 *
 * A project is the only thing that makes a session work somewhere other than the
 * install's own folder, so this is where a piece of work is set up and opened —
 * and the chat it opens into is the ordinary one, with the ordinary composer.
 * The screen is drawn like its sibling workspaces: the projects as a panel, and
 * one project's own page a level in.
 */
export function Work({ tick, sessions, onOpenSession, onStartSession }: {
  /** Bumped when a turn ends, so a project's sessions re-read as they grow. */
  tick: number
  /** Every session this client knows about — the same list the drawer draws. */
  sessions: WorkSession[]
  onOpenSession(id: string): void
  /** Start a work session in a project and open it. False when it could not. */
  onStartSession(projectId: string): Promise<boolean>
}) {
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  useAutoDismiss(notice, setNotice)
  const [saving, setSaving] = useState(false)
  /** Why the projects could not be read, held apart from the transient notice so a
      failed read keeps its own sentence and its way to try again. */
  const [loadError, setLoadError] = useState<string | null>(null)
  /** Whether the folder picker is up — how a project is added. */
  const [picking, setPicking] = useState(false)

  /** Bumped per read, so a slower earlier answer cannot overwrite a newer one. */
  const loadSeq = useRef(0)
  const refresh = useCallback(async (): Promise<void> => {
    const mine = ++loadSeq.current
    try {
      const next = await api<Project[]>('projects')
      if (mine !== loadSeq.current) return
      setProjects(next)
      setSelectedId((current) => (current && next.some((project) => project.id === current) ? current : null))
      setLoadError(null)
    } catch (error) {
      if (mine !== loadSeq.current) return
      setLoadError(message(error))
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  // A chat turn may have started a session in a project through Milo; redraw the
  // list it changed rather than what this screen remembered.
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick is a change signal only
  useEffect(() => { void refresh() }, [tick, refresh])

  /** One action, the whole list back: the store is the one that decides. */
  const act = useCallback(async (body: Record<string, unknown>): Promise<boolean> => {
    setSaving(true)
    setNotice(null)
    try {
      const result = await api<{ result: string; projects: Project[] }>('project-action', body)
      setProjects(result.projects)
      setSelectedId((current) => (current && result.projects.some((project) => project.id === current) ? current : null))
      setNotice({ text: result.result, error: false })
      return true
    } catch (error) {
      setNotice({ text: message(error), error: true })
      return false
    } finally {
      setSaving(false)
    }
  }, [])

  const selected = projects?.find((project) => project.id === selectedId) ?? null
  if (selected) {
    return <ProjectPage
      key={selected.id}
      project={selected}
      sessions={sessions.filter((session) => session.project === selected.id)}
      notice={notice}
      saving={saving}
      onDismiss={() => setNotice(null)}
      onBack={() => setSelectedId(null)}
      onOpenSession={onOpenSession}
      onStartSession={onStartSession}
      onAct={act}
    />
  }
  return <WorkIndex
    projects={projects}
    sessions={sessions}
    notice={notice}
    loadError={loadError}
    saving={saving}
    onDismiss={() => setNotice(null)}
    onSelect={setSelectedId}
    onNew={() => setPicking(true)}
    onRetry={() => { setLoadError(null); void refresh() }}
    picker={picking ? <FolderPicker
      onClose={() => setPicking(false)}
      onChoose={(path) => { setPicking(false); void act({ action: 'add', path }) }}
    /> : undefined}
  />
}

/** The workspace frame, so both levels of this view sit in the same place. */
function Shell({ head, notice, onDismiss, children }: { head: ReactNode; notice: Notice | null; onDismiss(): void; children: ReactNode }) {
  return <main className="settings-workspace">
    <div className="settings-inner">
      <div className="settings-panel-stack">
        <section className="settings-section">
          {head}
          <Notice notice={notice} onDismiss={onDismiss} />
          <div className="panel-body">
            {children}
          </div>
        </section>
      </div>
    </div>
  </main>
}

function WorkIndex({
  projects,
  sessions,
  notice,
  loadError,
  saving,
  onDismiss,
  onSelect,
  onNew,
  onRetry,
  picker,
}: {
  /** Null until the projects have been read once: "none" and "not yet" are not the same. */
  projects: Project[] | null
  sessions: WorkSession[]
  notice: Notice | null
  /** Set when the projects could not be read; null once they have been. */
  loadError: string | null
  saving: boolean
  onDismiss(): void
  onSelect(id: string): void
  /** Adding a project, which is choosing a folder on the machine Milo runs on. */
  onNew(): void
  onRetry(): void
  /** The folder picker, drawn over this screen while it is up. */
  picker?: ReactNode
}) {
  return <>
    <Shell
    notice={notice}
    onDismiss={onDismiss}
    head={<PageHeader
      title="Work"
      description="The folders a session can work in, and the sessions that ran there."
      action={projects && projects.length > 0 ? <div className="panel-count"><strong>{projects.length}</strong><span>{projects.length === 1 ? 'project' : 'projects'}</span></div> : undefined}
    />}
  >
    {projects === null
      ? loadError
        ? <div className="panel-state"><p>Could not read your projects: {loadError}</p><button className="button" type="button" onClick={onRetry}>Try again</button></div>
        : <SkeletonList rows={3} label="Reading your projects…" />
      : projects.length === 0
        ? <div className="panel-empty">
          <span className="panel-empty-mark"><Icon name="folder" size={22} /></span>
          <h3>No projects yet</h3>
          <p className="panel-empty-copy">A project is a folder a session works in. Point one at a repository and every session started in it reads, writes and runs commands there — not in Milo's own directory.</p>
          <NewProject saving={saving} label="New project" onNew={onNew} />
        </div>
        : <div className="work-list">
          {projects.map((project) => <ProjectRow key={project.id} project={project} sessions={sessions.filter((session) => session.project === project.id)} onClick={() => onSelect(project.id)} />)}
        </div>}
    {projects && projects.length > 0 && <div className="work-footer">
      <NewProject saving={saving} label="New project" onNew={onNew} />
    </div>}
    </Shell>
    {picker}
  </>
}

/** One project as the index draws it: its name, its folder, and how much work is there. */
function ProjectRow({ project, sessions, onClick }: { project: Project; sessions: WorkSession[]; onClick(): void }) {
  const running = sessions.some((session) => session.running)
  return <button className="work-card" type="button" onClick={onClick}>
    <span className="work-card-main">
      <span className="work-card-name">{project.name}</span>
      {/* A folder that is gone is said here rather than left as a project that looks
          workable: a session started in it would not work there. */}
      <span className={`work-card-meta ${project.error ? 'gone' : ''}`}>{project.error ?? project.path}</span>
    </span>
    <span className="work-card-count">
      {running && <span className="session-running" />}
      <span className="work-open">{sessions.length}</span>
      <span>{sessions.length === 1 ? 'session' : 'sessions'}</span>
    </span>
    <Icon className="work-card-chevron" name="chevron" size={16} />
  </button>
}

/**
 * Adding a project, which is choosing a folder: the picker is raised rather than a path
 * typed, because the folder that matters is on the machine Milo runs on and the browser
 * has no way to reach it — see `FolderPicker`.
 */
function NewProject({ saving, label, onNew }: { saving: boolean; label: string; onNew(): void }) {
  return <button className="button primary" type="button" disabled={saving} onClick={onNew}>
    <Icon name="plus" size={15} /> {label}
  </button>
}

/**
 * The folders of the machine Milo runs on, walked a level at a time: the one being shown,
 * the way up, and what is inside it. Choosing one answers its path — what the *daemon* sees,
 * never what this browser or the phone sees, which is why there is no platform file dialog
 * anywhere in this.
 */
function FolderPicker({ onChoose, onClose }: { onChoose(path: string): void; onClose(): void }) {
  const [listing, setListing] = useState<FolderListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** Bumped per read, so a slower earlier folder cannot replace one chosen after it. */
  const seq = useRef(0)

  const open = useCallback(async (path?: string): Promise<void> => {
    const mine = ++seq.current
    setBusy(true)
    try {
      const next = await api<FolderListing>('browse-folders', path ? { path } : {})
      if (mine !== seq.current) return
      setListing(next)
      setError(null)
    } catch (failure) {
      if (mine !== seq.current) return
      setError(message(failure))
    } finally {
      if (mine === seq.current) setBusy(false)
    }
  }, [])

  useEffect(() => { void open() }, [open])

  return <div className="folder-picker" role="dialog" aria-label="Choose a folder">
    <button className="folder-picker-scrim" type="button" aria-label="Close" onClick={onClose} />
    <div className="folder-picker-inner">
      <header className="folder-picker-head">
        {/* Which machine these folders are is the thing to be plain about: the person
            is looking at their computer's files from a browser or a phone. */}
        <div>
          <h2 className="folder-picker-heading">Choose a folder</h2>
          <p className="folder-picker-sub">On the machine Milo runs on.</p>
        </div>
        <button className="icon-button" type="button" aria-label="Close" onClick={onClose}><Icon name="x" size={16} /></button>
      </header>

      <div className="folder-picker-where">
        <button className="folder-picker-up" type="button" disabled={!listing?.parent || busy} onClick={() => listing?.parent && void open(listing.parent)}>
          <Icon name="arrow-left" size={15} /> Up
        </button>
        <span className="folder-picker-path" title={listing?.path}>{listing?.path ?? '…'}</span>
      </div>

      {error && <p className="folder-picker-error">{error}</p>}

      {listing === null
        ? <SkeletonList rows={5} label="Reading folders…" />
        : listing.folders.length === 0
          ? <p className="list-empty">No folders inside this one.</p>
          : <div className="folder-picker-list">
            {listing.folders.map((folder) => <button className="folder-picker-row" key={folder.path} type="button" onClick={() => void open(folder.path)}>
              <Icon name="folder" size={16} />
              <span className="folder-picker-name">{folder.name}</span>
              <Icon name="chevron" size={14} />
            </button>)}
          </div>}

      {listing?.truncated && <p className="folder-picker-note">Only the first folders are shown — there are more than fit here.</p>}

      <footer className="folder-picker-foot">
        <span className="folder-picker-name-line">{listing ? listing.name : ''}</span>
        <button className="button primary" type="button" disabled={!listing || busy} onClick={() => listing && onChoose(listing.path)}>
          Use this folder
        </button>
      </footer>
    </div>
  </div>
}

/** One project's own page: what it is, the sessions that ran there, and the ways out. */
function ProjectPage({
  project,
  sessions,
  notice,
  saving,
  onDismiss,
  onBack,
  onOpenSession,
  onStartSession,
  onAct,
}: {
  project: Project
  /** This project's sessions, newest first — the caller's list, filtered. */
  sessions: WorkSession[]
  notice: Notice | null
  saving: boolean
  onDismiss(): void
  onBack(): void
  onOpenSession(id: string): void
  onStartSession(projectId: string): Promise<boolean>
  onAct(body: Record<string, unknown>): Promise<boolean>
}) {
  const [renaming, setRenaming] = useState(false)
  const [rename, setRename] = useState(project.name)

  function saveRename(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const next = rename.trim()
    if (!next || next === project.name) { setRenaming(false); return }
    void onAct({ action: 'update', id: project.id, name: next }).then((ok) => { if (ok) setRenaming(false) })
  }

  function removeProject(): void {
    if (window.confirm(`Remove “${project.name}” from the list? Its sessions stay.`)) {
      void onAct({ action: 'remove', id: project.id })
    }
  }

  return <Shell
    notice={notice}
    onDismiss={onDismiss}
    head={<PageHeader
      back={<button className="settings-back" type="button" onClick={onBack}><Icon name="arrow-left" /><span>Work</span></button>}
      title={project.name}
      description={project.error ?? project.path}
      action={<div className="work-actions">
        <button className="button" type="button" onClick={() => { setRename(project.name); setRenaming(true) }}><Icon name="edit" size={14} /> Rename</button>
        <button className="button danger" type="button" disabled={saving} onClick={removeProject}><Icon name="trash" size={14} /> Remove</button>
      </div>}
    />}
  >
    {renaming && <form className="work-rename" onSubmit={saveRename}>
      <Field label="Project name"><input value={rename} onChange={(event) => setRename(event.target.value)} maxLength={80} /></Field>
      <div className="save-actions">
        <button className="button" type="button" onClick={() => setRenaming(false)}>Cancel</button>
        <button className="button primary" type="submit" disabled={saving || !rename.trim()}>Save name</button>
      </div>
    </form>}
    <div className="work-start">
      <button className="button primary" type="button" disabled={saving || project.error !== undefined} onClick={() => void onStartSession(project.id)}>
        <Icon name="plus" size={15} /> New session here
      </button>
      <span className="work-start-note">Opens a chat that works in {project.path}.</span>
    </div>
    {sessions.length === 0
      ? <p className="list-empty">No sessions have worked here yet. Start one above, or ask Milo for something that needs this folder.</p>
      : <div className="work-sessions">
        {sessions.map((session) => <button className="work-session" key={session.id} type="button" onClick={() => onOpenSession(session.id)}>
          {session.running && <span className="session-running" />}
          <span className="work-session-label">{sessionLabel(session) || session.id}</span>
          <span className="work-session-meta">{session.messageCount} msgs · {formatWhen(session.updatedAt)}</span>
        </button>)}
      </div>}
  </Shell>
}
