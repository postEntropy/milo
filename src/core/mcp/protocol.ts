/**
 * The MCP wire, as far as Milo speaks it: JSON-RPC 2.0, one message per line,
 * over a subprocess's standard streams.
 *
 * Two eras exist and Milo is a **dual-era** client. The revision in use —
 * `2026-07-28` — has no handshake: every request carries its protocol version
 * and the client's identity in `_meta`, and the client probes with
 * `server/discover`. Every revision up to `2025-11-25` opens with an
 * `initialize` handshake instead, and its requests carry no `_meta` at all (a
 * dual-era server reads the presence of `_meta` as the modern path, so sending
 * it to a legacy conversation would change what the server thinks it is doing).
 *
 * Which era a server is, is a property of the server: `client.ts` decides it
 * once per process, the manager remembers it in the listing cache, and this file
 * holds only the shapes.
 */

/** The revision Milo speaks when the server speaks it too. */
export const MODERN_PROTOCOL_VERSION = '2026-07-28'

/**
 * What Milo opens with when the server is legacy. Not the oldest revision that
 * exists — the newest before the handshake was dropped, which is the one a
 * server old enough to need a handshake is most likely to know.
 */
export const LEGACY_PROTOCOL_VERSION = '2025-11-25'

/**
 * The client's own name on the wire. `clientInfo` is informational by the
 * spec's own words — a server must not use it for anything — and the version is
 * checked against `package.json` by the suite, so it cannot quietly go stale.
 */
export const CLIENT_INFO = { name: 'milo', version: '0.1.0' } as const

/** The error a modern server returns for a revision it does not implement. */
export const UNSUPPORTED_PROTOCOL_VERSION = -32022

/** What Milo answers a server that asks it for something it does not do. */
export const METHOD_NOT_FOUND = -32601

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number | string | null
  result?: unknown
  error?: JsonRpcError
}

export type ServerMessage = JsonRpcResponse | JsonRpcNotification | JsonRpcRequest

/** One message as a line. A message with an embedded newline would desync the stream, so it cannot happen here. */
export function encodeMessage(message: unknown): string {
  return `${JSON.stringify(message)}\n`
}

/**
 * One line of the server's output. A line that is not JSON at all is `null`
 * rather than a throw: a server that prints a banner to `stdout` — which the
 * spec forbids and installs still do — must not take the connection down with
 * it. The caller logs it and reads the next line.
 */
export function parseMessage(line: string): ServerMessage | null {
  const text = line.trim()
  if (!text) return null
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  const message = value as Record<string, unknown>
  if (message.jsonrpc !== '2.0') return null
  if (typeof message.method === 'string') {
    // A request carries an id; a notification does not. Servers must not send
    // requests any more, and a legacy one may still ask for roots or sampling.
    return message.id === undefined
      ? (message as unknown as JsonRpcNotification)
      : (message as unknown as JsonRpcRequest)
  }
  if ('result' in message || 'error' in message) {
    const id = message.id
    if (typeof id !== 'number' && typeof id !== 'string' && id !== null) return null
    return { jsonrpc: '2.0', id, ...(message as object) } as JsonRpcResponse
  }
  return null
}

/** The `_meta` every modern request carries, per the spec's per-request metadata model. */
export function modernMeta(capabilities: Record<string, unknown>): Record<string, unknown> {
  return {
    'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL_VERSION,
    'io.modelcontextprotocol/clientInfo': { ...CLIENT_INFO },
    'io.modelcontextprotocol/clientCapabilities': capabilities,
  }
}

/**
 * A result's own type. Modern servers say `complete`; `input_required` means the
 * server wants a further round trip Milo does not make, and a result the client
 * does not recognise must be treated as invalid rather than read as a
 * completion. Legacy servers omit the field, which is the compatible default.
 */
export function assertComplete(result: unknown, what: string): void {
  if (!result || typeof result !== 'object') {
    throw new Error(`${what} answered without a result.`)
  }
  const type = (result as Record<string, unknown>).resultType
  if (type === undefined || type === 'complete') return
  if (type === 'input_required') {
    throw new Error(
      `${what} asked for input mid-request, which Milo does not answer yet. The server's tool needs a form Milo cannot fill in.`,
    )
  }
  throw new Error(`${what} answered with a result Milo does not understand: ${JSON.stringify(type)}.`)
}

/** A tool as the server describes it, kept as it came so the schema reaches the model verbatim. */
export interface McpToolDefinition {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}
