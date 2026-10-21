import { useEffect, useRef, useState } from 'react'
import { sessionLabel as sharedSessionLabel } from '../../../src/core/sessions/format.ts'
import { formatWhen } from '../lib/format.js'
import { Icon } from '../ui/Icons.js'
import type { SessionSummary } from './types.js'

/** What a session is called on screen: its message, never the generated id. */
export function sessionLabel(session: SessionSummary): string {
  return sharedSessionLabel(session) || session.recap || 'New session'
}

/** What a row says under the name: how much has been said, and when. */
export function sessionMeta(session: SessionSummary): string {
  const count = `${session.messageCount} ${session.messageCount === 1 ? 'message' : 'messages'}`
  return session.messageCount > 0 ? `${count} · ${formatWhen(session.updatedAt)}` : formatWhen(session.updatedAt)
}

/**
 * The mark a session's row wears, read off the session's own state: one dot, never
 * two. Running outranks unread — it is the newer news — so a session that is both
 * drawing a turn and holding something unread reads as running until the turn ends.
 * The pulse is the whole difference: it says something is happening now, while the
 * still dot says something is waiting to be read.
 */
export function SessionMark({ running, unread }: { running?: boolean; unread?: boolean }) {
  if (running) return <span className="session-running" role="img" aria-label="Running" />
  if (unread) return <span className="session-unread" role="img" aria-label="Unread" />
  return null
}

/**
 * A session row, wherever a list draws one: the drawer, and the sessions a project's page
 * and the Work index hold. One declaration, so the name, the second line, the running dot
 * and the actions under the dots cannot drift between the surfaces.
 */
export function SessionRow({
  session,
  active,
  onClick,
  onRename,
  onExport,
  onCopy,
  onDelete,
}: {
  session: SessionSummary
  active: boolean
  onClick(): void
  onRename(id: string, title: string): Promise<void>
  onExport(id: string): Promise<void>
  onCopy(id: string): void
  onDelete(id: string): Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [editTitle, setEditTitle] = useState(session.title ?? '')
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const onDocClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('click', onDocClick)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', onDocClick)
      window.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  const handleSaveRename = async () => {
    setEditing(false)
    if (editTitle.trim() !== (session.title ?? '')) {
      await onRename(session.id, editTitle.trim())
    }
  }

  return (
    <div className={`session-item ${active ? 'active' : ''} ${menuOpen ? 'menu-open' : ''}`}>
      {editing ? (
        <form
          className="session-rename-form"
          onSubmit={(e) => {
            e.preventDefault()
            void handleSaveRename()
          }}
        >
          <input
            className="session-rename-input"
            // biome-ignore lint/a11y/noAutofocus: intentional focus for inline rename
            autoFocus
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            onBlur={() => void handleSaveRename()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setEditing(false)
                setEditTitle(session.title ?? '')
              }
            }}
          />
        </form>
      ) : (
        <button className="session-row" type="button" onClick={onClick}>
          <span className="session-content">
            <span className="session-title">{sessionLabel(session)}</span>
            <span className="session-preview">{sessionMeta(session)}</span>
          </span>
        </button>
      )}

      <SessionMark running={session.running} unread={session.unread} />

      <div className="session-row-actions" ref={menuRef}>
        <button
          className={`session-more-btn ${menuOpen ? 'open' : ''}`}
          type="button"
          title="Session actions"
          aria-label="Session actions"
          onClick={(e) => {
            e.stopPropagation()
            setMenuOpen((prev) => !prev)
          }}
        >
          <Icon name="dots" size={16} />
        </button>

        {menuOpen && (
          <div className="session-dropdown" role="menu">
            <button
              className="session-dropdown-item"
              type="button"
              role="menuitem"
              onClick={(e) => {
                e.stopPropagation()
                setMenuOpen(false)
                setEditTitle(session.title || session.preview || '')
                setEditing(true)
              }}
            >
              <Icon name="edit" size={16} />
              <span>Rename</span>
            </button>
            <button
              className="session-dropdown-item"
              type="button"
              role="menuitem"
              onClick={(e) => {
                e.stopPropagation()
                setMenuOpen(false)
                void onExport(session.id)
              }}
            >
              <Icon name="download" size={16} />
              <span>Export</span>
            </button>
            <button
              className="session-dropdown-item"
              type="button"
              role="menuitem"
              onClick={(e) => {
                e.stopPropagation()
                setMenuOpen(false)
                onCopy(session.id)
              }}
            >
              <Icon name="copy" size={16} />
              <span>Copy ID</span>
            </button>
            <button
              className="session-dropdown-item danger"
              type="button"
              role="menuitem"
              onClick={(e) => {
                e.stopPropagation()
                setMenuOpen(false)
                void onDelete(session.id)
              }}
            >
              <Icon name="trash" size={16} />
              <span>Delete</span>
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
