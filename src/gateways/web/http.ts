import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, type WebSocket } from 'ws'
import type { AgentRuntime } from '../../core/runtime.js'
import { isImage, type OutgoingMessage } from '../../core/outgoing.js'
import { errorMessage } from '../../util/errors.js'
import { hyperlink } from '../../util/terminal.js'
import { parseClientFrame, PROTOCOL_VERSION, type ServerFrame } from './protocol.js'
import { WebHub } from './hub.js'
import { WebSettings } from './settings.js'

const MAX_BODY = 1024 * 1024

/**
 * The built frontend. Found by walking up from this module rather than by one
 * relative path, because the layout differs: in the source tree this file sits in
 * `src/gateways/web/`, while the bundle is `dist/bin/*.js` — and an installed
 * package is a third arrangement again. The first `web/dist` with an
 * `index.html` in it is the one, wherever the entry point was bundled to.
 */
let webRoot: string | null | undefined

function webRootDir(): string | null {
  if (webRoot !== undefined) return webRoot
  let dir = fileURLToPath(new URL('.', import.meta.url))
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = path.join(dir, 'web', 'dist')
    if (existsSync(path.join(candidate, 'index.html'))) {
      webRoot = candidate
      return webRoot
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  webRoot = null
  return webRoot
}

/** Whether the frontend has been built; the server answers 503 for the page until it has. */
export function webUiBuilt(): boolean {
  return webRootDir() !== null
}

const MIME: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  // Without its own type the manifest is served as a download, and the install
  // that makes the phone drop its browser chrome never happens.
  '.webmanifest': 'application/manifest+json; charset=utf-8',
}

export interface WebServerOptions {
  runtime: AgentRuntime
  cwd: string
  host: string
  port: number
  token?: string
  identity?: { provider: string; model: string }
}

export interface RunningWebServer {
  server: Server
  token: string
  url: string
  /**
   * The addresses the machine is reachable at, one URL each. Empty unless the
   * bind was to every interface: a fixed bind has exactly one name, and `url`
   * already is it.
   */
  urls: string[]
  /** Posts a message into a conversation with no turn behind it (a routine's answer). */
  deliver(conversationId: string, message: OutgoingMessage): Promise<void>
  /** Tells every open page that a routine ran, so the history it shows re-reads. */
  routinesChanged(): void
  stop(): Promise<void>
}

export async function startWebServer(options: WebServerOptions): Promise<RunningWebServer> {
  const token = options.token ?? randomBytes(32).toString('base64url')
  const hub = new WebHub(options.runtime, options.identity ?? { provider: 'milo', model: 'unknown' })
  const settings = new WebSettings(options.runtime, options.cwd, hub)
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
  const server = createServer((request, response) => {
    void handleHttp(request, response, token, settings, hub, options.host).catch((error: unknown) => {
      if (!response.headersSent) json(response, 500, { error: error instanceof Error ? error.message : String(error) })
      else response.destroy()
    })
  })
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    if (url.pathname !== '/ws' || !authorized(request, token, url.searchParams.get('t'))) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    if (!sameOrigin(request, options.host)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    webSocketServer.handleUpgrade(request, socket, head, (websocket) => {
      webSocketServer.emit('connection', websocket, request)
    })
  })
  webSocketServer.on('connection', (socket: WebSocket) => {
    let conversationId: string | undefined
    const client = {
      send(frame: ServerFrame): void {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame))
      },
    }
    socket.on('message', (data) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(data.toString())
      } catch {
        client.send({ type: 'error', message: 'Invalid JSON frame.' })
        return
      }
      const frame = parseClientFrame(parsed)
      if (!frame) {
        client.send({ type: 'error', message: 'Invalid client frame.' })
        return
      }
      if (frame.type === 'hello') {
        if (frame.version !== PROTOCOL_VERSION || conversationId) {
          client.send({ type: 'error', message: 'Unsupported protocol version or duplicate handshake.' })
          socket.close(1002, 'Invalid handshake')
          return
        }
        conversationId = frame.conversationId
        void hub.connect(client, conversationId).catch((error: unknown) => {
          client.send({ type: 'error', message: error instanceof Error ? error.message : String(error) })
          socket.close(1011, 'Could not open conversation')
        })
        return
      }
      if (!conversationId) {
        client.send({ type: 'error', message: 'Send the hello frame first.' })
        return
      }
      hub.handle(client, frame, conversationId)
    })
    socket.on('close', () => hub.disconnect(client))
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : options.port
  // `0.0.0.0` is what you bind, not what you open: it names no machine, so a URL
  // built from it opens nothing on any device — the phone on the same tailnet
  // included, which is what "I set it to 0.0.0.0 and cannot reach it" turns out
  // to be. Bound to every interface, the URL printed (and opened by `milo web`)
  // is loopback, and the names the machine actually answers on are listed with it.
  const wildcard = isWildcardHost(options.host)
  const hostname = options.host.includes(':') ? `[${options.host}]` : options.host
  const reachable = (host: string): string => `http://${host}:${port}/?t=${encodeURIComponent(token)}`
  const url = reachable(wildcard ? '127.0.0.1' : hostname)
  const urls = wildcard ? reachableHosts().map(reachable) : []

  return {
    server,
    token,
    url,
    urls,
    deliver: (conversationId, message) => hub.deliver(conversationId, message),
    routinesChanged: () => hub.routinesChanged(),
    stop: () => new Promise<void>((resolve, reject) => {
      hub.close()
      // A page left open holds a keep-alive connection and a websocket, and
      // `server.close()` only calls back once every connection has ended — so the
      // daemon's shutdown would hang there while a browser is watching. Cut them.
      for (const client of webSocketServer.clients) client.terminate()
      webSocketServer.close()
      server.closeAllConnections()
      server.close((error) => error ? reject(error) : resolve())
    }),
  }
}

async function handleHttp(request: IncomingMessage, response: ServerResponse, token: string, settings: WebSettings, hub: WebHub, boundHost: string): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
  if (!sameOrigin(request, boundHost)) return json(response, 403, { error: 'Origin not allowed.' })
  if (url.pathname.startsWith('/api/')) {
    if (!authorized(request, token, url.searchParams.get('t'))) return json(response, 401, { error: 'Unauthorized.' })
    if (request.method !== 'POST') return json(response, 405, { error: 'Use POST.' })
    try {
      const body = await readBody(request)
      const action = url.pathname.slice('/api/'.length)
      const result = await settings.handle(action, body)
      return json(response, 200, result)
    } catch (error) {
      return json(response, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 405, { error: 'Method not allowed.' })

  // A file delivered into a chat. Only an id the hub has registered is served —
  // never a path the browser names — which is what keeps this from being a way to
  // read any file on the machine. The token comes from the URL here because an
  // `<img>` sends no header; the page is already inside the same origin.
  if (url.pathname.startsWith('/attachment/')) {
    if (!authorized(request, token, url.searchParams.get('t'))) return json(response, 401, { error: 'Unauthorized.' })
    const known = hub.attachment(url.pathname.slice('/attachment/'.length))
    const stats = known ? statSync(known.path, { throwIfNoEntry: false }) : undefined
    if (!known || !stats?.isFile()) return json(response, 404, { error: 'Not found.' })
    response.writeHead(200, {
      'content-type': known.mimeType,
      'content-length': String(stats.size),
      // A picture shows in the chat; anything else downloads, under the name it
      // was delivered with.
      'content-disposition': `${isImage(known.mimeType) ? 'inline' : 'attachment'}; filename="${headerName(known.name)}"`,
      'cache-control': 'private, max-age=3600',
      'x-content-type-options': 'nosniff',
    })
    if (request.method === 'HEAD') {
      response.end()
      return
    }
    createReadStream(known.path).pipe(response)
    return
  }

  const root = webRootDir()
  if (!root) {
    return json(response, 503, { error: 'Web UI is not built. Run `npm run build:web`.' })
  }
  const candidate = path.resolve(root, `.${decodeURIComponent(url.pathname)}`)
  const inside = candidate === root || candidate.startsWith(root + path.sep)
  const file = inside && existsSync(candidate) && statSync(candidate).isFile()
    ? candidate
    : path.join(root, 'index.html')
  if (!existsSync(file)) return json(response, 404, { error: 'Not found.' })
  response.writeHead(200, {
    'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'cache-control': path.basename(file) === 'index.html' ? 'no-cache' : 'public, max-age=3600',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'",
  })
  if (request.method === 'HEAD') {
    response.end()
    return
  }
  createReadStream(file).pipe(response)
}

/** A filename safe in a header: a quote or a control character would break it. */
function headerName(name: string): string {
  let safe = ''
  for (const char of name) {
    const code = char.codePointAt(0) ?? 0
    safe += char === '"' || char === '\\' || code < 32 ? '_' : char
  }
  return safe
}

function authorized(request: IncomingMessage, token: string, queryToken?: string | null): boolean {
  const header = request.headers.authorization
  const supplied = header?.startsWith('Bearer ')
    ? header.slice(7)
    : queryToken ?? ''
  const left = Buffer.from(token)
  const right = Buffer.from(supplied)
  return left.length === right.length && timingSafeEqual(left, right)
}

function sameOrigin(request: IncomingMessage, boundHost: string): boolean {
  const origin = request.headers.origin
  // No Origin: not a page, so not a cross-site request. The token is the gate.
  if (!origin) return true
  try {
    const parsed = new URL(origin)
    if (parsed.protocol !== 'http:') return false
    const originHost = parsed.hostname.toLowerCase()
    const addressed = hostName(request.headers.host ?? '')
    // Bound to every interface: whichever name it was reached by is the name the
    // page must also have come from — there is no fixed one to allow.
    if (isWildcardHost(boundHost)) return originHost === addressed
    // Otherwise the page has to have come from a name this server answers to:
    // loopback, or the address it was configured to bind.
    const allowed = new Set(['localhost', '127.0.0.1', '::1', hostName(boundHost)])
    return allowed.has(originHost) && allowed.has(addressed)
  } catch {
    return false
  }
}

/**
 * A bind failure said in terms of what to change. The errno is a code, and this
 * line is the only place a person learns the surface is not up and why — so the
 * three that actually happen are spelled out rather than handed over raw.
 */
export function bindProblem(error: unknown, host: string, port: number): string {
  const code = (error as { code?: string } | null)?.code
  if (code === 'EADDRINUSE') return `port ${port} is already in use — another process holds it`
  if (code === 'EADDRNOTAVAIL') return `${host} is not an address of this machine`
  if (code === 'EACCES') return `port ${port} needs privileges this process does not have`
  return errorMessage(error)
}

/** Binding here means "every interface", so the name it answers to is not fixed. */
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', ''])

/** Whether the bind is every interface, in which case no single name opens it. */
export function isWildcardHost(host: string): boolean {
  return WILDCARD_HOSTS.has(host.trim().toLowerCase())
}

/**
 * What a boot log owes about where the page is, beyond the URL itself.
 *
 * A fixed bind names itself, so the URL is the whole answer. Bound to every
 * interface there is no such name — and `0.0.0.0`, the address that was bound, is
 * not one any other device opens. That is the silent trap: the URL looks right,
 * the daemon is up, and the phone on the same tailnet reaches nothing. So the
 * names it answers on are printed, and `0.0.0.0` is called what it is.
 */
export function webReachLines(host: string, urls: string[]): string[] {
  if (!isWildcardHost(host)) return []
  return [
    '! bound to every interface — 0.0.0.0 is not a name another device opens. Reachable at:',
    ...urls.map((url) => `           ${hyperlink(url)}`),
  ]
}

/**
 * The addresses this machine answers on, loopback aside. A tailnet or LAN address
 * is what another device opens; typed on the machine itself, any of them works,
 * which is why the list is offered rather than one host picked for the reader.
 */
function reachableHosts(): string[] {
  const hosts: string[] = []
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) hosts.push(entry.address)
    }
  }
  return hosts
}

/** The host out of a `Host` header or a bind address, without its port or brackets. */
function hostName(value: string): string {
  const trimmed = value.trim().toLowerCase()
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']')
    return end === -1 ? trimmed.slice(1) : trimmed.slice(1, end)
  }
  // A bare IPv6 address has more than one colon, and nothing to strip from it.
  if ((trimmed.match(/:/g) ?? []).length > 1) return trimmed
  const colon = trimmed.indexOf(':')
  return colon === -1 ? trimmed : trimmed.slice(0, colon)
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY) throw new Error('Request body exceeds 1 MiB.')
    chunks.push(buffer)
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected a JSON object.')
  return parsed as Record<string, unknown>
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(JSON.stringify(value))
}
