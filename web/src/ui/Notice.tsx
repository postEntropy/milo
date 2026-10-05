import { useEffect } from 'react'
import { Icon } from './Icons.js'

/** What a surface says about the last thing that happened. */
export type Notice = { text: string; error: boolean }

/**
 * A notice is not a thing to keep: it says what just happened and then gets out
 * of the way, so an action does not leave a line standing on the screen after it.
 * An error holds longer, since it is the one worth reading. The timer lives here
 * alone, so every surface's notice has the same life rather than drifting.
 */
export function useAutoDismiss(notice: Notice | null, clear: (notice: Notice | null) => void): void {
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => clear(null), notice.error ? 9000 : 5000)
    return () => window.clearTimeout(timer)
  }, [notice, clear])
}

/** The one notice every surface draws, with its own way out. */
export function Notice({ notice, onDismiss }: { notice: Notice | null; onDismiss(): void }) {
  if (!notice) return null
  return <p className={`notice ${notice.error ? 'error' : 'success'}`} role={notice.error ? 'alert' : 'status'}>
    {notice.text}
    <button className="icon-button" type="button" aria-label="Dismiss notice" title="Dismiss" onClick={onDismiss}><Icon name="x" size={15} /></button>
  </p>
}
