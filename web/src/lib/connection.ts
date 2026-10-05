/**
 * What a page knows about its socket, kept apart from the socket itself so the
 * decision a close forces can be read — and tested — without a browser.
 *
 * `refused` is terminal and `offline` is not. A refusal is the server having
 * answered and said no; repeating it is how the chip once spun with nothing
 * said. `offline` is the server simply not being there, where the next attempt
 * may well find it.
 */
export type ConnectionState = 'connecting' | 'online' | 'offline' | 'refused'

/** The state, and — when the server refused — what it said. */
export interface ConnectionStatus {
  state: ConnectionState
  reason?: string
}

/**
 * What a page tells itself when the server is up but would not serve it. A
 * browser cannot read the HTTP status of a refused WebSocket upgrade, so the
 * page learns "the server answered and said no" by asking a plain request and
 * reading the fact that it answered at all. A stale token after a restart is the
 * way this actually happens.
 */
const REFUSED_REASON =
  'Milo is up but refused this page — its token is stale, or the address is not one it serves. Reopen the URL `milo serve` printed.'

/**
 * What a closed socket means.
 *
 * Once online, a close is a drop and the page retries. Before the handshake
 * finished, the server either refused the page or was not there at all: an
 * explicit refusal (`error`) is taken as the reason, otherwise the answer turns
 * on whether the server is reachable at all (`reachable`).
 */
export function closeOutcome(input: { everOnline: boolean; error?: string; reachable: boolean }): {
  retry: boolean
  status: ConnectionStatus
} {
  if (input.everOnline) return { retry: true, status: { state: 'offline' } }
  if (input.error) return { retry: false, status: { state: 'refused', reason: input.error } }
  if (input.reachable) return { retry: false, status: { state: 'refused', reason: REFUSED_REASON } }
  return { retry: true, status: { state: 'offline' } }
}
