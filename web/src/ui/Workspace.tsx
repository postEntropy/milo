import type { ReactNode } from 'react'
import { Notice } from './Notice.js'

/**
 * The wide screen's two-pane frame: the list stays in a rail on the left while
 * the chosen routine or task list is read beside it. On a phone a surface keeps
 * its own one-pane flow, so it never draws this — `usePhone()` decides.
 */
export function SplitWorkspace({ label, rail, children }: { label: string; rail: ReactNode; children: ReactNode }) {
  return <main className="settings-workspace">
    <div className="workspace-split">
      <aside className="workspace-rail" aria-label={label}>
        {rail}
      </aside>
      <div className="workspace-detail">
        <div className="settings-inner">
          {children}
        </div>
      </div>
    </div>
  </main>
}

/**
 * One panel of a workspace: its head, its notice and its body, all in one place.
 * `inSplit` draws only the panel, for a surface that owns the frame around it —
 * and then the frame carries the notice, above both panes.
 */
export function Panel({ head, notice, onDismiss, inSplit, children }: {
  head: ReactNode
  notice?: Notice | null
  onDismiss?(): void
  inSplit?: boolean
  children: ReactNode
}) {
  const section = <section className="settings-section">
    {head}
    {!inSplit && <Notice notice={notice ?? null} onDismiss={onDismiss ?? ((): void => {})} />}
    <div className="panel-body">
      {children}
    </div>
  </section>
  if (inSplit) return section
  return <main className="settings-workspace">
    <div className="settings-inner">
      <div className="settings-panel-stack">
        {section}
      </div>
    </div>
  </main>
}
