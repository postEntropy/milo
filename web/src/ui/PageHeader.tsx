import type { ReactNode } from 'react'

/**
 * The one heading every full-screen view wears: the title on the left with its
 * description beneath it, the page's own action at the right end of the title
 * line, and — when the view is a level in — the way back above the title.
 *
 * Every workspace view and every Settings section draws through this, so they
 * start at the same edge and at the same size, and the description always sits
 * under the title instead of competing with it for the line.
 */
export function PageHeader({ titleId, title, description, action, back }: {
  /** The id `aria-labelledby` points at, when the section names itself. */
  titleId?: string
  title?: ReactNode
  description?: ReactNode
  /** The page's primary action, or the readout that belongs on the title line. */
  action?: ReactNode
  /** The way back to the level above, drawn over the title. */
  back?: ReactNode
}) {
  const main = title || description || action
  return <header className="page-header">
    {back && <div className="page-header-back">{back}</div>}
    {main && <div className="page-header-main">
      <div className="page-header-text">
        {title && <h2 id={titleId} className="page-header-title">{title}</h2>}
        {description && <p className="page-header-description">{description}</p>}
      </div>
      {action && <div className="page-header-action">{action}</div>}
    </div>}
  </header>
}
