import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, type WebSocket } from 'ws'
import type { AgentRuntime } from '../../core/runtime.js'
import { parseClientFrame, PROTOCOL_VERSION, type ServerFrame } from './protocol.js'
import { WebHub } from './hub.js'
import { WebStudio } from './studio.js'

const MAX_BODY = 1024 * 1024
const WEB_ROOT = fileURLToPath(new URL('../../../web/dist/', import.meta.url))
const MIME: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
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
  /** Posts a message into a conversation with no turn behind it (a routine's answer). */
  deliver(conversationId: string, text: string): Promise<void>
  stop(): Promise<void>
}

export async function startWebServer(options: WebServerOptions): Promise<RunningWebServer> {
  const token = options.token ?? randomBytes(32).toString('base64url')
  const hub = new WebHub(options.runtime, options.identity ?? { provider: 'milo', model: 'unknown' })
  const studio = new WebStudio(options.runtime, options.cwd)
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
  const server = createServer((request, response) => {
    void handleHttp(request, response, token, studio).catch((error: unknown) => {
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
    if (!sameOrigin(request)) {
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
  const hostname = options.host.includes(':') ? `[${options.host}]` : options.host
  const url = `http://${hostname}:${port}/?t=${encodeURIComponent(token)}`

  return {
    server,
    token,
    url,
    deliver: (conversationId, text) => hub.deliver(conversationId, text),
    stop: () => new Promise<void>((resolve, reject) => {
      hub.close()
      webSocketServer.close()
      server.close((error) => error ? reject(error) : resolve())
    }),
  }
}

async function handleHttp(request: IncomingMessage, response: ServerResponse, token: string, studio: WebStudio): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
  if (!sameOrigin(request)) return json(response, 403, { error: 'Origin not allowed.' })
  if (url.pathname.startsWith('/api/')) {
    if (!authorized(request, token, url.searchParams.get('t'))) return json(response, 401, { error: 'Unauthorized.' })
    if (request.method !== 'POST') return json(response, 405, { error: 'Use POST.' })
    try {
      const body = await readBody(request)
      const action = url.pathname.slice('/api/'.length)
      const result = await studio.handle(action, body)
      return json(response, 200, result)
    } catch (error) {
      return json(response, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 405, { error: 'Method not allowed.' })
  if (!existsSync(WEB_ROOT)) {
    return json(response, 503, { error: 'Web UI is not built. Run `npm --prefix web install && npm --prefix web run build`.' })
  }
  const candidate = path.resolve(WEB_ROOT, `.${decodeURIComponent(url.pathname)}`)
  const file = candidate.startsWith(WEB_ROOT) && existsSync(candidate) && statSync(candidate).isFile()
    ? candidate
    : path.join(WEB_ROOT, 'index.html')
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

function authorized(request: IncomingMessage, token: string, queryToken?: string | null): boolean {
  const header = request.headers.authorization
  const supplied = header?.startsWith('Bearer ')
    ? header.slice(7)
    : queryToken ?? ''
  const left = Buffer.from(token)
  const right = Buffer.from(supplied)
  return left.length === right.length && timingSafeEqual(left, right)
}

function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin
  if (!origin) return true
  try {
    const parsed = new URL(origin)
    const originHost = parsed.hostname.toLowerCase()
    const localOrigin = originHost === 'localhost' || originHost === '127.0.0.1' || originHost === '::1'
    const localServer = (request.headers.host ?? '').startsWith('localhost:') || (request.headers.host ?? '').startsWith('127.0.0.1:') || (request.headers.host ?? '').startsWith('[::1]:')
    return parsed.protocol === 'http:' && localOrigin && localServer
  } catch {
    return false
  }
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
