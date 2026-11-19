import type { ConnectionState } from '../lib/connection.js'

const LABEL: Record<ConnectionState, string> = {
  connecting: 'Connecting…',
  online: '',
  offline: 'Reconnecting…',
  refused: 'Disconnected',
}

/**
 * The socket's state as the person reads it, in one place: the wide screen, the
 * routines panel and the spotlight wear the same chip rather than each writing
 * its own words for the same three states. Nothing at all while the socket is up.
 */
export function ConnectionChip({ state, reason, onReconnect }: { state: ConnectionState; reason?: string; onReconnect?: () => void }) {
  if (state === 'online') return null
  const hint = reason || (state === 'offline' ? 'Milo may still be working on the server.' : undefined)
  const canRetry = Boolean(onReconnect && state !== 'connecting')
  return <div className={`connection-status ${state}`} role="status" aria-live="polite" title={hint}>
    <span className="connection-dot" aria-hidden="true" />
    <span className="connection-label">{LABEL[state]}</span>
    {canRetry && <button type="button" className="connection-retry" onClick={onReconnect}>Reconnect</button>}
  </div>
}
