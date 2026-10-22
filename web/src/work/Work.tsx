import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { api } from '../lib/api.js'
import { message } from '../lib/format.js'
import { languageOf } from '../../../src/core/highlight.ts'
import { humanSize } from '../../../src/util/format.ts'
import type { ProjectView } from '../../../src/core/projects.ts'
import {
  DEFAULT_PROJECT_ICON,
  PROJECT_ICONS,
  isProjectIcon,
} from '../../../src/core/project-icons.ts'
import { SessionMark, SessionRow } from '../sessions/SessionRow.js'
import type { SessionSummary } from '../sessions/types.js'
import { inlineSessions } from './sessions.js'
import { Code } from '../ui/Code.js'
import { Field } from '../ui/Form.js'
import { Icon } from '../ui/Icons.js'
import { Notice, useAutoDismiss, type Report } from '../ui/Notice.js'
import { PageHeader } from '../ui/PageHeader.js'
import { SkeletonList } from '../ui/Skeleton.js'
import { WaitLine } from '../ui/WaitLine.js'
import { projectMark } from './marks.js'

/** A directory of the machine Milo runs on, as the daemon lists it. */
type FolderListing = {
  path: string
  name: string
  parent?: string
  folders: Array<{ name: string; path: string }>
  truncated: boolean
}
/** Which projects the person folded shut, by id: expanded is the default, so only that is kept. */
const COLLAPSED_KEY = 'milo-work-collapsed'

/** The projects folded shut on this client. No stored preference reads as all expanded. */
function readCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

function writeCollapsed(ids: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...ids]))
  } catch {
    // A folded project that does not survive a reload is a preference, not data lost.
  }
}
/** One entry of a project's folder, as the daemon nests it. */
type WorkNode = {
  kind: 'folder' | 'file'
  name: string
  /** Path relative to the project's folder — what opening it asks for. */
  rel: string
  size?: number
  mtimeMs?: number
  children?: WorkNode[]
}
/** A project's folder as the daemon walked it, cut and all. */
type WorkTree = {
  nodes: WorkNode[]
  files: number
  /** The walk hit its ceiling: what is drawn is the first part of the tree. */
  truncated: boolean
  /** Folders the walk could not read, in its own words. */
  warnings: string[]
}
/** One page of a project's file, cut where the agent's own reader cuts it. */
type FilePage = {
  rel: string
  name: string
  size: number
  text: string
  from: number
  total: number
  next?: number
}
/** One line of a hunk, with the line it is on in either file. */
type DiffLine = { kind: 'add' | 'remove' | 'context'; text: string; old?: number; new?: number }
/** One hunk of a changed file. */
type DiffHunk = { header: string; lines: DiffLine[] }
/** One changed file, as git sees it. */
type DiffFile = {
  path: string
  from?: string
  additions: number
  deletions: number
  hunks: DiffHunk[]
  note?: string
}
/** What a project has changed: read from git, or nothing to read at all. */
type WorkDiff =
  | { ok: true; source: 'git'; files: DiffFile[]; truncated: boolean; committed: boolean }
  | { ok: true; source: 'none'; reason: string }
/** Whether a project's folder carries rules of its own, and the words that ask for them. */
type ProjectRules = {
  kind: 'present' | 'absent' | 'unreadable'
  /** Which file carries the rules: `AGENTS.md`, or `CLAUDE.md` when it is the fallback. */
  file?: string
  /** Why the file could not be read, when it could not. */
  error?: string
  /** What a session is told to write or improve the file — one wording, every surface. */
  prompt: string
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
export function Work({
  tick,
  projects,
  loadError,
  pickProject,
  sessions,
  sessionId,
  projectId,
  onProject,
  onProjects,
  onRetry,
  onPicked,
  onOpenSession,
  onStartSession,
  onRenameSession,
  onExportSession,
  onCopySessionId,
  onDeleteSession,
}: {
  /** Bumped when the daemon says to re-read a folder: a turn ended, or a step wrote. */
  tick: number
  /** The projects this client knows of, read once in `App` for this screen and the drawer. */
  projects: ProjectView[] | null
  /** Why the projects could not be read; null once they have been. */
  loadError: string | null
  /** Set by the drawer's New project: raise the folder picker for the person. */
  pickProject: boolean
  /** Every session this client knows about — the same list the drawer draws. */
  sessions: SessionSummary[]
  /** The session the chat is in, marked where Work draws it. */
  sessionId?: string
  /** The project whose own page is open on top of the index; null draws the index. */
  projectId: string | null
  /** Opening a project's page, and going back to the index with null. */
  onProject(id: string | null): void
  /** The list a change here answered with, so the drawer draws it too. */
  onProjects(next: ProjectView[]): void
  onRetry(): void
  onPicked(): void
  onOpenSession(id: string): void
  /** Start a work session in a project and open it. False when it could not. */
  onStartSession(projectId: string, firstMessage?: string): Promise<boolean>
  onRenameSession(id: string, title: string, report: Report): Promise<void>
  onExportSession(id: string, report: Report): Promise<void>
  onCopySessionId(id: string, report: Report): void
  onDeleteSession(id: string, report: Report): Promise<void>
}) {
  const [notice, setNotice] = useState<Notice | null>(null)
  useAutoDismiss(notice, setNotice)
  const [saving, setSaving] = useState(false)
  /** Whether the folder picker is up — how a project is added. */
  const [picking, setPicking] = useState(false)

  // The drawer's New project is the same act as this screen's own button: it asks for
  // the picker here, where adding a project lives, and the ask is answered once.
  useEffect(() => {
    if (!pickProject) return
    setNotice(null)
    setPicking(true)
    onPicked()
  }, [pickProject, onPicked])

  // A project removed here or on another surface stops being the one this screen
  // shows, rather than leaving a page whose project is gone.
  useEffect(() => {
    if (projects && projectId && !projects.some((project) => project.id === projectId)) onProject(null)
  }, [projects, projectId, onProject])

  /** One action, the whole list back: the store is the one that decides. */
  const act = useCallback(async (body: Record<string, unknown>): Promise<boolean> => {
    setSaving(true)
    setNotice(null)
    try {
      const result = await api<{ result: string; projects: ProjectView[] }>('project-action', body)
      onProjects(result.projects)
      setNotice({ text: result.result, error: false })
      return true
    } catch (error) {
      setNotice({ text: message(error), error: true })
      return false
    } finally {
      setSaving(false)
    }
  }, [onProjects])

  const actions: SessionActions = {
    activeId: sessionId,
    rename: onRenameSession,
    exportSession: onExportSession,
    copyId: onCopySessionId,
    remove: onDeleteSession,
  }

  const selected = projects?.find((project) => project.id === projectId) ?? null
  if (selected) {
    return <ProjectPage
      key={selected.id}
      project={selected}
      sessions={sessions.filter((session) => session.project === selected.id).sort((a, b) => b.updatedAt - a.updatedAt)}
      tick={tick}
      notice={notice}
      saving={saving}
      actions={actions}
      report={setNotice}
      onDismiss={() => setNotice(null)}
      onBack={() => onProject(null)}
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
    actions={actions}
    report={setNotice}
    onDismiss={() => setNotice(null)}
    onSelect={onProject}
    onOpenSession={onOpenSession}
    onNew={() => setPicking(true)}
    onRetry={onRetry}
    picker={picking ? <FolderPicker
      onClose={() => setPicking(false)}
      onChoose={(path) => { setPicking(false); void act({ action: 'add', path }) }}
    /> : undefined}
  />
}

/** The session actions a row offers, wherever Work draws one. The report says where the
 *  answer lands: the drawer shows its notice in the chat, Work shows it on this screen. */
type SessionActions = {
  activeId?: string
  rename(id: string, title: string, report: Report): Promise<void>
  exportSession(id: string, report: Report): Promise<void>
  copyId(id: string, report: Report): void
  remove(id: string, report: Report): Promise<void>
}

/**
 * The body of a project. It stays in the grid, folded to nothing, so the card grows and
 * shrinks instead of snapping — the same fold the reasoning panel keeps. The clip is
 * released once the body is open, so a session's menu can lift past it, and a folded body
 * is `inert`: nothing inside it can be tabbed to or pressed while it is shut.
 */
function ProjectSessions({ open, id, children }: { open: boolean; id: string; children: ReactNode }) {
  const [settled, setSettled] = useState(open)

  useEffect(() => {
    if (!open) {
      setSettled(false)
      return
    }
    const timer = window.setTimeout(() => setSettled(true), 260)
    return () => window.clearTimeout(timer)
  }, [open])

  return <div
    className={`work-project-sessions ${open ? 'open' : ''} ${settled ? 'settled' : ''}`}
    id={id}
    aria-hidden={!open}
    inert={!open}
  >
    <div className="work-project-clip">{children}</div>
  </div>
}

/** One project's sessions, drawn as the drawer draws them — the same row, the same actions. */
function SessionList({ sessions, actions, report, onOpen }: {
  sessions: SessionSummary[]
  actions: SessionActions
  report: Report
  onOpen(id: string): void
}) {
  return <>
    {sessions.map((session) => <SessionRow
      key={session.id}
      session={session}
      active={session.id === actions.activeId}
      onClick={() => onOpen(session.id)}
      onRename={(id, title) => actions.rename(id, title, report)}
      onExport={(id) => actions.exportSession(id, report)}
      onCopy={(id) => actions.copyId(id, report)}
      onDelete={(id) => actions.remove(id, report)}
    />)}
  </>
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
  actions,
  report,
  onDismiss,
  onSelect,
  onOpenSession,
  onNew,
  onRetry,
  picker,
}: {
  /** Null until the projects have been read once: "none" and "not yet" are not the same. */
  projects: ProjectView[] | null
  sessions: SessionSummary[]
  notice: Notice | null
  /** Set when the projects could not be read; null once they have been. */
  loadError: string | null
  saving: boolean
  actions: SessionActions
  /** Where a row's own action says what it did: this screen's notice, not the chat's. */
  report: Report
  onDismiss(): void
  onSelect(id: string): void
  onOpenSession(id: string): void
  /** Adding a project, which is choosing a folder on the machine Milo runs on. */
  onNew(): void
  onRetry(): void
  /** The folder picker, drawn over this screen while it is up. */
  picker?: ReactNode
}) {
  /** Folded shut here, on this client. Expanded is the default, so only that is kept. */
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed)

  function toggle(id: string): void {
    const next = new Set(collapsed)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setCollapsed(next)
    writeCollapsed(next)
  }

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
          {projects.map((project) => {
            const mine = sessions.filter((session) => session.project === project.id)
            const shown = inlineSessions(mine)
            // A project with nothing in it has nothing to fold: its count says zero and the
            // card stays shut, rather than opening onto a line that says the same thing.
            const open = mine.length > 0 && !collapsed.has(project.id)
            return <div className="work-project" key={project.id}>
              {/* One card, not two: the header opens the project's page, and the chevron at its
                  own edge folds the sessions in and out. The body is the same surface, so what
                  belongs to the project reads as one object rather than a card and loose rows. */}
              <div className="work-project-head">
                <ProjectRow
                  project={project}
                  sessions={mine.length}
                  running={mine.some((session) => session.running)}
                  unread={mine.some((session) => session.unread)}
                  onClick={() => onSelect(project.id)}
                />
                {mine.length > 0 && <button
                  className="work-twist"
                  type="button"
                  aria-expanded={open}
                  aria-controls={open ? `work-sessions-${project.id}` : undefined}
                  aria-label={`${open ? 'Collapse' : 'Expand'} ${project.name}`}
                  onClick={() => toggle(project.id)}
                ><Icon className="work-twist-mark" name="chevron" size={16} /></button>}
              </div>
              {mine.length > 0 && <ProjectSessions open={open} id={`work-sessions-${project.id}`}>
                <div className="work-project-body">
                  <SessionList sessions={shown} actions={actions} report={report} onOpen={onOpenSession} />
                  {mine.length > shown.length && <button className="work-all" type="button" onClick={() => onSelect(project.id)}>
                    <span>All {mine.length} sessions</span>
                    <Icon name="chevron" size={15} />
                  </button>}
                </div>
              </ProjectSessions>}
            </div>
          })}
        </div>}
    {projects && projects.length > 0 && <div className="work-footer">
      <NewProject saving={saving} label="New project" onNew={onNew} />
    </div>}
    </Shell>
    {picker}
  </>
}

/** One project as the index draws it: its name, its folder, and how much work is there. */
function ProjectRow({ project, sessions, running, unread, onClick }: { project: ProjectView; sessions: number; running: boolean; unread: boolean; onClick(): void }) {
  return <button className="work-card" type="button" onClick={onClick}>
    <span className="work-card-mark"><Icon name={projectMark(project.icon)} size={20} /></span>
    <span className="work-card-main">
      <span className="work-card-name">{project.name}</span>
      {/* A folder that is gone is said here rather than left as a project that looks
          workable: a session started in it would not work there. */}
      <span className={`work-card-meta ${project.error ? 'gone' : ''}`}>{project.error ?? project.path}</span>
    </span>
    <span className="work-card-count">
      {/* The card's own mark, because a project's rows may be folded shut: something
          running there, or something waiting to be read, is never hidden behind the
          count. */}
      <SessionMark running={running} unread={unread} />
      <span className="work-open">{sessions}</span>
      <span>{sessions === 1 ? 'session' : 'sessions'}</span>
    </span>
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
  tick,
  notice,
  saving,
  actions,
  report,
  onDismiss,
  onBack,
  onOpenSession,
  onStartSession,
  onAct,
}: {
  project: ProjectView
  /** This project's sessions, newest first — the caller's list, filtered. */
  sessions: SessionSummary[]
  /** Bumped when the daemon says to re-read a folder: a turn ended, or a step wrote. */
  tick: number
  notice: Notice | null
  saving: boolean
  actions: SessionActions
  /** Where a row's own action says what it did: this screen's notice, not the chat's. */
  report: Report
  onDismiss(): void
  onBack(): void
  onOpenSession(id: string): void
  onStartSession(projectId: string, firstMessage?: string): Promise<boolean>
  onAct(body: Record<string, unknown>): Promise<boolean>
}) {
  const [renaming, setRenaming] = useState(false)
  const [rename, setRename] = useState(project.name)
  /** Whether the marks are open: the palette sits under the bar, a press away. */
  const [choosingIcon, setChoosingIcon] = useState(false)
  /** The mark this project wears now — an id this build does not know reads as the neutral one. */
  const chosenIcon = isProjectIcon(project.icon) ? project.icon : DEFAULT_PROJECT_ICON
  const [tree, setTree] = useState<WorkTree | null>(null)
  const [treeError, setTreeError] = useState<string | null>(null)
  /** The file being read, by its project-relative path. */
  const [open, setOpen] = useState<WorkNode | null>(null)
  const [diff, setDiff] = useState<WorkDiff | null>(null)
  const [diffError, setDiffError] = useState<string | null>(null)
  /** What the folder carries as its own rules, and whether it carries any at all. */
  const [rules, setRules] = useState<ProjectRules | null>(null)
  const [rulesError, setRulesError] = useState<string | null>(null)
  /** The changed file whose hunks are drawn, by its own path. */
  const [openDiff, setOpenDiff] = useState<string | null>(null)
  /** Recording the folder as it is now, which is what makes the changes readable at all. */
  const [tracking, setTracking] = useState(false)
  /** The folder name being typed, or null while the form is closed. */
  const [folderName, setFolderName] = useState<string | null>(null)
  const [folderBusy, setFolderBusy] = useState(false)
  const [folderError, setFolderError] = useState<string | null>(null)

  /** Bumped per read, so a slower earlier walk cannot overwrite a newer one. */
  const treeSeq = useRef(0)
  const readTree = useCallback(async (): Promise<void> => {
    const mine = ++treeSeq.current
    try {
      const next = await api<WorkTree>('project-tree', { id: project.id })
      if (mine !== treeSeq.current) return
      setTree(next)
      setTreeError(null)
    } catch (error) {
      if (mine !== treeSeq.current) return
      setTreeError(message(error))
    }
  }, [project.id])

  const diffSeq = useRef(0)
  const readDiff = useCallback(async (): Promise<void> => {
    const mine = ++diffSeq.current
    try {
      const next = await api<WorkDiff>('project-diff', { id: project.id })
      if (mine !== diffSeq.current) return
      setDiff(next)
      setDiffError(null)
    } catch (error) {
      if (mine !== diffSeq.current) return
      setDiffError(message(error))
    }
  }, [project.id])

  /** The folder's own rules, and the words that ask for them — read once for this page. */
  const rulesSeq = useRef(0)
  const readRules = useCallback(async (): Promise<void> => {
    const mine = ++rulesSeq.current
    try {
      const next = await api<ProjectRules>('project-rules', { id: project.id })
      if (mine !== rulesSeq.current) return
      setRules(next)
      setRulesError(null)
    } catch (error) {
      if (mine !== rulesSeq.current) return
      setRulesError(message(error))
    }
  }, [project.id])

  useEffect(() => { void readTree(); void readDiff(); void readRules() }, [readTree, readDiff, readRules])
  // A turn running in this project may have written in its folder — and does, step by step,
  // while it runs — so the tree, the changes and the rules are re-read rather than drawn from
  // what this screen remembered.
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick is a change signal only
  useEffect(() => { void readTree(); void readDiff(); void readRules() }, [tick, readTree, readDiff, readRules])

  /**
   * Recording what the folder holds now as its first state: their folder, their
   * repository, so nothing asks. What it answered is the changes themselves — empty,
   * because there is now something to compare against — and the section draws that
   * instead of asking for the read again.
   */
  const track = useCallback(async (): Promise<void> => {
    setTracking(true)
    try {
      const next = await api<WorkDiff>('project-track', { id: project.id })
      setDiff(next)
      setDiffError(null)
      setTreeError(null)
    } catch (error) {
      setDiffError(message(error))
    } finally {
      setTracking(false)
    }
  }, [project.id])

  /**
   * A folder made in the project's own folder. The daemon answers with the whole tree
   * after the write — a folder holding no file is still drawn — so the section shows it
   * without a second read.
   */
  const createFolder = useCallback(async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const name = folderName?.trim() ?? ''
    if (!name) return
    setFolderBusy(true)
    setFolderError(null)
    try {
      const next = await api<WorkTree>('project-folder', { id: project.id, name })
      setTree(next)
      setFolderName(null)
    } catch (error) {
      setFolderError(message(error))
    } finally {
      setFolderBusy(false)
    }
  }, [folderName, project.id])

  function saveRename(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const next = rename.trim()
    if (!next || next === project.name) { setRenaming(false); return }
    void onAct({ action: 'update', id: project.id, name: next }).then((ok) => { if (ok) setRenaming(false) })
  }

  /**
   * Choosing a mark: the daemon is the store, so the palette waits for its answer and
   * closes only when the list came back changed. A press on the mark already worn is a
   * way out, not a write.
   */
  function chooseIcon(mark: string): void {
    if (mark === chosenIcon) { setChoosingIcon(false); return }
    void onAct({ action: 'update', id: project.id, icon: mark }).then((ok) => { if (ok) setChoosingIcon(false) })
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
      title={<span className="work-title"><span className="work-title-mark"><Icon name={projectMark(project.icon)} size={18} /></span><span>{project.name}</span></span>}
      description={project.error ?? project.path}
      action={<div className="work-actions">
        <button className="button" type="button" aria-expanded={choosingIcon} onClick={() => setChoosingIcon((open) => !open)}><Icon name={projectMark(project.icon)} size={14} /> Icon</button>
        <button className="button" type="button" onClick={() => { setRename(project.name); setRenaming(true) }}><Icon name="edit" size={14} /> Rename</button>
        <button className="button danger" type="button" disabled={saving} onClick={removeProject}><Icon name="trash" size={14} /> Remove</button>
      </div>}
    />}
  >
    {choosingIcon && <fieldset className="work-icons" aria-label="Project icon">
      {PROJECT_ICONS.map((choice) => <button
        className="work-icon"
        key={choice.id}
        type="button"
        aria-pressed={choice.id === chosenIcon}
        aria-label={choice.label}
        title={choice.label}
        disabled={saving}
        onClick={() => chooseIcon(choice.id)}
      ><Icon name={projectMark(choice.id)} size={18} /></button>)}
    </fieldset>}
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
      ? <p className="list-empty">No sessions yet. Start one above, or ask Milo for something that needs this folder.</p>
      : <div className="work-sessions">
        <SessionList sessions={sessions} actions={actions} report={report} onOpen={onOpenSession} />
      </div>}

    {/* A folder that is gone has no rules to read, and the reason is already on the bar. */}
    {project.error === undefined && <section className="work-changes">
      <header className="work-files-head">
        <h2 className="work-files-title">Rules</h2>
      </header>

      {rulesError
        ? <div className="panel-state"><p>Could not read this folder’s rules: {rulesError}</p><button className="button" type="button" onClick={() => void readRules()}>Try again</button></div>
        : rules === null
          ? <SkeletonList rows={1} label="Reading this folder’s rules…" />
          : rules.kind === 'present'
            ? <p className="list-empty">This folder’s rules are in <code>{rules.file ?? 'AGENTS.md'}</code>. A session started here follows them.</p>
            : rules.kind === 'unreadable'
              ? <p className="list-empty">This folder has an <code>{rules.file ?? 'AGENTS.md'}</code> that could not be read: {rules.error}</p>
              : <div className="work-changes-none">
                {/* What a project's own rules are, said once — and the one control that
                    makes them: a session told to read the folder and write the file, which
                    the person then watches, rather than a file written behind their back. */}
                <p className="list-empty">This folder has no <code>AGENTS.md</code> — the file that tells a session started here how the project is worked in: its commands, its layout, its conventions.</p>
                <button className="button" type="button" disabled={saving} onClick={() => void onStartSession(project.id, rules.prompt)}>
                  <Icon name="edit" size={14} /> Write the rules
                </button>
              </div>}
    </section>}

    {/* A folder that is gone has no diff to read, and the reason is already on the bar. */}
    {project.error === undefined && <section className="work-changes">
      <header className="work-files-head">
        <h2 className="work-files-title">Changes</h2>
        {diff?.source === 'git' && diff.files.length > 0 && <span className="work-files-count">{diff.files.length} {diff.files.length === 1 ? 'file' : 'files'}</span>}
      </header>

      {diffError
        ? <div className="panel-state"><p>Could not read the changes: {diffError}</p><button className="button" type="button" onClick={() => void readDiff()}>Try again</button></div>
        : diff === null
          ? <SkeletonList rows={2} label="Reading the changes…" />
          : diff.source === 'none' || !diff.committed
            ? <div className="work-changes-none">
              {/* What this is, then what pressing the control below would do: the words read
                  first, and the one thing to press sits under them. A repository with
                  nothing committed has no state to compare against — every file in it
                  would read as new — so that is said instead of the whole folder. */}
              <p className="list-empty">
                {diff.source === 'none'
                  ? `${diff.reason} Milo reads a folder’s changes through git, so there is nothing here to compare this one to.`
                  : 'Nothing is recorded in this repository yet, so every file in it counts as new.'}
              </p>
              <span className="work-changes-note">Git keeps the history locally, in a <code>.git</code> folder inside the project. Nothing is sent anywhere.</span>
              {/* Their folder, their repository: pressing this is the person's own act, and
                  it is the only thing that makes this section say anything at all. */}
              <button className="button" type="button" disabled={tracking} onClick={() => void track()}>
                <Icon name="branch" size={14} /> {tracking ? 'Recording…' : diff.source === 'none' ? 'Start a repository' : 'Record the first state'}
              </button>
            </div>
            : diff.files.length === 0
              ? <p className="list-empty">No changes</p>
              : <div className="work-diff-list">
                {diff.files.map((file) => <DiffFileRow
                  key={file.path}
                  file={file}
                  open={openDiff === file.path}
                  onToggle={() => setOpenDiff((current) => (current === file.path ? null : file.path))}
                />)}
              </div>}

      {diff?.source === 'git' && diff.committed && diff.truncated && <p className="work-files-note">Only the first {diff.files.length} changed files are shown — there are more than fit here.</p>}
    </section>}

    {/* A folder that is gone has no tree to walk, and the reason is already on the bar. */}
    {project.error === undefined && <section className="work-files">
      <header className="work-files-head">
        <h2 className="work-files-title">Files</h2>
        <div className="work-files-side">
          {tree && <span className="work-files-count">{tree.files} {tree.files === 1 ? 'file' : 'files'}</span>}
          {/* A folder may need to exist before a session can work in it: the tree makes
              one, and draws it in the same answer. It is disabled until the tree has been
              read, so a tap is never a guess about where it lands. */}
          <button
            className="icon-button"
            type="button"
            aria-label="New folder"
            title="New folder"
            disabled={saving || tree === null}
            onClick={() => { setFolderError(null); setFolderName('') }}
          ><Icon name="plus" size={16} /></button>
        </div>
      </header>

      {folderName !== null && <form className="work-rename" onSubmit={(event) => void createFolder(event)}>
        <Field label="Folder name"><input value={folderName} onChange={(event) => setFolderName(event.target.value)} maxLength={80} /></Field>
        <div className="save-actions">
          <button className="button" type="button" onClick={() => { setFolderName(null); setFolderError(null) }}>Cancel</button>
          <button className="button primary" type="submit" disabled={folderBusy || !folderName.trim()}>{folderBusy ? 'Creating…' : 'Create folder'}</button>
        </div>
      </form>}
      {folderError && <p className="work-file-error">{folderError}</p>}

      {open && <FileView
        project={project.id}
        node={open}
        onClose={() => setOpen(null)}
      />}

      {treeError
        ? <div className="panel-state"><p>Could not read this folder: {treeError}</p><button className="button" type="button" onClick={() => void readTree()}>Try again</button></div>
        : tree === null
          ? <SkeletonList rows={4} label="Reading this folder…" />
          : tree.nodes.length === 0
            ? <p className="list-empty">This folder is empty.</p>
            : <div className="work-tree">
              {tree.nodes.map((node) => <TreeNode key={node.rel} node={node} openRel={open?.rel ?? null} onOpen={setOpen} />)}
            </div>}

      {/* One line for the whole tree, said once: what was cut, and what could not be read. */}
      {tree?.truncated && <p className="work-files-note">Only the first {tree.files} files are shown — the folder holds more than fits here.</p>}
      {tree && tree.warnings.length > 0 && <p className="work-files-note">{tree.warnings.join(' · ')}</p>}
    </section>}
  </Shell>
}

/**
 * A path, cut from its directory when it does not fit: half a directory still says which file
 * this is, half a name does not. The name itself never gives way — the same rule the phone
 * keeps, where a long path is truncated at its head.
 */
function Path({ value }: { value: string }) {
  const cut = value.lastIndexOf('/')
  return <>
    {cut !== -1 && <span className="path-dir">{value.slice(0, cut + 1)}</span>}
    <span className="path-name">{value.slice(cut + 1)}</span>
  </>
}

/**
 * A changed file: how much moved, and — opened — the hunks themselves. The marking of a
 * line is the diff's own: added lines green, removed red, and both numbers in the gutter,
 * so a line can be found in the file it is from. What git called the change is not drawn
 * beside the name: the path names the file, a rename says where it came from, and the
 * counts say how much moved.
 */
function DiffFileRow({ file, open, onToggle }: { file: DiffFile; open: boolean; onToggle(): void }) {
  const moved = file.from === undefined ? '' : ` (was ${file.from})`
  // Which language the lines are read as: a diff carries no tag, so the file's own name is
  // the only hint — the same one the phone reads.
  const language = languageOf(file.path)
  return <div className="work-diff-file">
    <button className="work-diff-row" type="button" aria-expanded={open} onClick={onToggle}>
      <Icon className="work-tree-twist" name="chevron" size={13} />
      <span className="work-diff-path" title={file.path}><Path value={file.path} />{moved}</span>
      {/* The counts are only worth drawing when something moved: a rename or a
          permission change has no lines of its own, and a bare `+0 −0` says nothing. */}
      {(file.additions > 0 || file.deletions > 0) && <span className="work-diff-count">
        {file.additions > 0 && <span className="plus">+{file.additions}</span>}
        {file.deletions > 0 && <span className="minus">−{file.deletions}</span>}
      </span>}
    </button>
    {open && <div className="work-diff-hunks">
      {file.hunks.map((hunk) => <div className="work-diff-hunk" key={`${hunk.header}:${hunk.lines.length}`}>
        <div className="work-diff-hunk-head">@@ {hunk.header} @@</div>
        {hunk.lines.map((line) => <div className={`work-diff-line ${line.kind}`} key={`${line.kind}:${line.old ?? ''}:${line.new ?? ''}`}>
          <span className="work-diff-num">{line.old ?? ''}</span>
          <span className="work-diff-num">{line.new ?? ''}</span>
          <span className="work-diff-mark">{line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}</span>
          <span className="work-diff-text">{line.text === '' ? ' ' : <Code code={line.text} language={language} />}</span>
        </div>)}
      </div>)}
      {file.note && <p className="work-diff-note">{file.note}</p>}
    </div>}
  </div>
}

/**
 * The tree of a project's folder, drawn a level at a time: a folder opens onto what is
 * inside it, a file is what the reader opens. Nested by the daemon, so this draws the
 * shape the core handed over rather than nesting paths of its own — and the nesting of
 * the markup is the nesting of the tree, so the indent is the one the sheet gives it.
 */
function TreeNode({ node, openRel, onOpen }: {
  node: WorkNode
  /** The file being read, so the row it was opened from stays marked. */
  openRel: string | null
  onOpen(node: WorkNode): void
}) {
  const [folded, setFolded] = useState(true)

  if (node.kind === 'folder') {
    const children = node.children ?? []
    return <div className="work-tree-branch">
      <button className="work-tree-row folder" type="button" aria-expanded={!folded} onClick={() => setFolded((current) => !current)}>
        <Icon className="work-tree-twist" name="chevron" size={13} />
        <Icon className="work-tree-mark" name="folder" size={15} />
        <span className="work-tree-name">{node.name}</span>
        <span className="work-tree-count">{children.length}</span>
      </button>
      {!folded && <div className="work-tree-children">
        {children.map((child) => <TreeNode key={child.rel} node={child} openRel={openRel} onOpen={onOpen} />)}
      </div>}
    </div>
  }

  return <button className={`work-tree-row file ${openRel === node.rel ? 'open' : ''}`} type="button" aria-current={openRel === node.rel ? 'true' : undefined} onClick={() => onOpen(node)}>
    <span className="work-tree-twist" />
    <Icon className="work-tree-mark" name="file" size={15} />
    <span className="work-tree-name">{node.name}</span>
    <span className="work-tree-size">{humanSize(node.size ?? 0)}</span>
  </button>
}

/**
 * One file, read from the daemon a page at a time. The page is the core's own cut — the
 * same one the agent's reader takes — so the lines here are the lines it was handed, and
 * a long file continues with the offset the page named rather than a guess.
 */
function FileView({ project, node, onClose }: { project: string; node: WorkNode; onClose(): void }) {
  const [pages, setPages] = useState<FilePage[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const seq = useRef(0)

  const read = useCallback(async (offset?: number): Promise<void> => {
    const mine = ++seq.current
    setBusy(true)
    try {
      const next = await api<FilePage>('project-file', { id: project, path: node.rel, ...(offset !== undefined ? { offset } : {}) })
      if (mine !== seq.current) return
      setPages((current) => (offset === undefined ? [next] : [...current, next]))
      setError(null)
    } catch (failure) {
      if (mine !== seq.current) return
      setError(message(failure))
    } finally {
      if (mine === seq.current) setBusy(false)
    }
  }, [project, node.rel])

  useEffect(() => { setPages([]); setError(null); void read() }, [read])

  const first = pages[0]
  const last = pages[pages.length - 1]
  const shown = pages.reduce((count, page) => count + (page.text === '' ? 0 : page.text.split('\n').length), 0)

  return <section className="work-file">
    <header className="work-file-head">
      <span className="work-file-name"><Path value={node.rel} /></span>
      <span className="work-file-meta">{first === undefined ? '' : first.total === 0 ? 'Empty' : `${first.total} lines · ${humanSize(first.size)}`}</span>
      <button className="icon-button" type="button" aria-label="Close the file" onClick={onClose}><Icon name="x" size={16} /></button>
    </header>
    {error
      ? <p className="work-file-error">{error}</p>
      : first === undefined
        ? <WaitLine label="Reading the file…" />
        : first.total === 0
          ? <p className="list-empty">This file is empty.</p>
          : <>
            <pre className="work-file-code"><Code code={pages.map((page) => page.text).join('\n')} language={node.rel} /></pre>
            <div className="work-file-foot">
              <span className="work-file-where">Showing lines {first.from}–{first.from + shown - 1} of {first.total}</span>
              {last?.next !== undefined && <button className="button" type="button" disabled={busy} onClick={() => void read(last.next)}>Load more</button>}
            </div>
          </>}
  </section>
}
