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
export function ConnectionChip({ state, reason }: { state: ConnectionState; reason?: string }) {
  if (state === 'online') return null
  return <span className={`connection-status ${state}`} title={reason}><span />{LABEL[state]}</span>
}
