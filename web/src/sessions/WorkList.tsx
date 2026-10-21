import type { ProjectView } from '../../../src/core/projects.ts'
import { workGroups } from './scopes.js'
import { SessionRow } from './SessionRow.js'
import type { SessionSummary } from './types.js'
import { Icon } from '../ui/Icons.js'
import { projectMark } from '../work/marks.js'

/**
 * The Work side of the session list: the projects, each with its newest sessions
 * under it — the same rows the drawer and a project's page draw, so a session reads
 * the same wherever it is listed. The project's own name is the way to its page,
 * where the folder, its changes and the rest of its sessions are.
 */
export function WorkList({
  projects,
  loadError,
  sessions,
  activeId,
  query,
  onRetry,
  onOpenProject,
  onOpenSession,
  onRename,
  onExport,
  onCopy,
  onDelete,
}: {
  /** Null until the projects have been read once: "none" and "not yet" are not the same. */
  projects: ProjectView[] | null
  loadError: string | null
  sessions: SessionSummary[]
  /** The session the chat is in, marked where it is drawn. */
  activeId?: string
  query: string
  onRetry(): void
  /** Opening a project's own page, and the rest of its sessions with it. */
  onOpenProject(id: string): void
  onOpenSession(id: string): void
  onRename(id: string, title: string): Promise<void>
  onExport(id: string): Promise<void>
  onCopy(id: string): void
  onDelete(id: string): Promise<void>
}) {
  if (projects === null) {
    return loadError
      ? <div className="list-empty">
        <p>Could not read your projects: {loadError}</p>
        <button className="button" type="button" onClick={onRetry}>Try again</button>
      </div>
      : <p className="list-empty">Reading your projects…</p>
  }
  if (projects.length === 0) {
    return <p className="list-empty">{query.trim() ? 'No projects found.' : 'No projects yet.'}</p>
  }

  const groups = workGroups(sessions, projects, query)
  if (groups.length === 0) return <p className="list-empty">No sessions found.</p>

  return <>
    {groups.map(({ project, sessions: shown, total }) => <div className="work-group" key={project.id}>
      {/* The project's name over its own sessions: a heading, not a card — the list is
          one column, and the mark is what says which folder the rows work in. */}
      <button
        className={`work-group-head ${project.error ? 'gone' : ''}`}
        type="button"
        title={project.error ?? `Open ${project.name}`}
        onClick={() => onOpenProject(project.id)}
      >
        <Icon name={projectMark(project.icon)} size={15} />
        <span className="work-group-name">{project.name}</span>
        {project.error && <span className="work-group-note">Gone</span>}
      </button>
      {shown.map((session) => <SessionRow
        key={session.id}
        session={session}
        active={session.id === activeId}
        onClick={() => onOpenSession(session.id)}
        onRename={onRename}
        onExport={onExport}
        onCopy={onCopy}
        onDelete={onDelete}
      />)}
      {total > shown.length && <button className="work-group-all" type="button" onClick={() => onOpenProject(project.id)}>
        <span>All {total} sessions</span>
        <Icon name="chevron" size={13} />
      </button>}
    </div>)}
  </>
}
