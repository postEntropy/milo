#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'undici'
import { loadConfig, readAuth, resolveGatewayToken, saveAuth } from '../core/config/load.js'
import { MILO_HOME } from '../core/config/paths.js'
import type { ClientFrame, ServerFrame } from '../gateways/web/protocol.js'
import { PROTOCOL_VERSION } from '../gateways/web/protocol.js'
import { appUrl, hostForUrl } from '../gateways/web/spotlight.js'
import { toolDisplayName, toolText } from '../gateways/tool-line.js'
import { errorMessage } from '../util/errors.js'

/** A question the panel asked, or what it wants done about the one in flight. */
type Command =
  | { type: 'ask'; text: string }
  | { type: 'new' }
  | { type: 'stop' }
  | { type: 'permission'; id: string; decision: 'allow' | 'always' | 'deny' }
  | { type: 'continue' }

/** What the panel is told, one JSON object per line. */
type Report =
  | { type: 'status'; text: string }
  | { type: 'ready' }
  | { type: 'text'; delta: string }
  | { type: 'tool'; text: string; state: 'running' | 'done' | 'failed' }
  | { type: 'permission'; id: string; tool: string; summary: string; expiresAt: number }
  | { type: 'permission-result'; id: string; allowed: boolean }
  | { type: 'end'; status: 'done' | 'stopped' | 'error'; says?: string }
  | { type: 'error'; message: string }
  | { type: 'fork'; url: string }

/** What the probe of a running server found. */
type Probe = 'ok' | 'refused' | 'down'

const PROBE_TIMEOUT_MS = 1200
const RETRY_MS = 1500
const START_INTERVAL_MS = 150

const STATE_FILE = path.join(MILO_HOME, 'spotlight.json')

/**
 * `milo spotlight` — the process behind the desktop popup.
 *
 * The panel is QML, which has no WebSocket, so it starts this once and speaks to
 * it in NDJSON over stdio — the same shape the Omarchy shell uses for `wl-paste`
 * and its own IPC. What travels here is the web UI's own protocol: the popup and
 * the browser are two clients of one daemon, and the same session, permissions
 * and tools work in both.
 */
class SpotlightBridge {
  private readonly token: string
  private readonly host: string
  private readonly port: number
  private readonly base: string
  private readonly wsUrl: string
  private chatId = ''
  private sessionId = ''
  private socket: WebSocket | null = null
  /** Bumped per connection, so a socket being retired cannot speak for the next one. */
  private generation = 0
  private connected = false
  private busy = false
  private queued: string | null = null
  private restartPending = false
  private retry: ReturnType<typeof setTimeout> | null = null
  private spawnTried = false
  private stopped = false
  /** Complaints already said, so a retrying loop does not repeat itself. */
  private readonly complained = new Set<string>()

  constructor(host: string, port: number, token: string) {
    this.host = host
    this.port = port
    this.token = token
    this.base = `http://${hostForUrl(host)}:${port}`
    this.wsUrl = `ws://${hostForUrl(host)}:${port}/ws?t=${encodeURIComponent(token)}`
  }

  async start(): Promise<void> {
    await this.ensureServer()
    this.reset()
    this.readCommands()
  }

  private report(message: Report): void {
    process.stdout.write(`${JSON.stringify(message)}\n`)
  }

  /** Nobody is listening to a popup that never says why it is empty. */
  private complain(message: string): void {
    if (this.complained.has(message)) return
    this.complained.add(message)
    this.report({ type: 'error', message })
  }

  private async probe(): Promise<Probe> {
    try {
      const response = await fetch(`${this.base}/api/sessions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })
      void response.body?.cancel()
      if (response.ok) return 'ok'
      if (response.status === 401 || response.status === 403) return 'refused'
      return 'down'
    } catch {
      return 'down'
    }
  }

  /**
   * The popup is worth nothing without a daemon behind it, so a missing one is
   * started and the reason said out loud. A source tree has no built entry to
   * start, and that is said too rather than left to a silent window.
   */
  private async ensureServer(): Promise<void> {
    for (;;) {
      const state = await this.probe()
      if (state === 'ok') return
      if (state === 'refused') {
        this.complain(`Something on port ${this.port} serves Milo with another token. Restart \`milo serve\` so it reads ~/.milo/auth.json.`)
      } else if (!this.spawnTried) {
        this.spawnTried = true
        this.report({ type: 'status', text: 'Starting Milo…' })
        this.spawnServer()
      }
      await new Promise((resolve) => setTimeout(resolve, START_INTERVAL_MS))
    }
  }

  private spawnServer(): void {
    // The web entry rather than `milo web`: that subcommand would read the bare
    // word "web" as an option from the argv the dispatcher hands it.
    const entry = findUp(path.join('dist', 'bin', 'web.js'))
    if (!entry) {
      this.complain('Milo has no built entry to start. Run `npm run build`, or start `milo serve`.')
      return
    }
    mkdirSync(MILO_HOME, { recursive: true })
    const log = openSync(path.join(MILO_HOME, 'web.log'), 'a')
    const child = spawn(
      process.execPath,
      [entry, '--no-open', '--host', this.host, '--port', String(this.port)],
      { detached: true, stdio: ['ignore', log, log] },
    )
    child.unref()
    closeSync(log)
  }

  /** A fresh question starts in a fresh conversation; the old one is forgotten. */
  private reset(): void {
    if (this.busy) {
      this.restartPending = true
      this.sendFrame({ type: 'control', action: 'stop' })
      return
    }
    this.restartPending = false
    this.connected = false
    this.queued = null
    this.clearRetry()
    this.socket?.close()
    this.socket = null
    void this.dropStored()
    this.chatId = randomUUID()
    this.connect()
  }

  private connect(): void {
    // The chat this connection speaks for is fixed here, not read when the socket
    // opens: a reset can mint a new one before this handshake lands, and the old
    // socket must not greet the daemon as the new chat — both would then receive
    // every frame of the turn.
    const generation = ++this.generation
    const chatId = this.chatId
    const socket = new WebSocket(this.wsUrl)
    this.socket = socket
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, chatId, genui: false } satisfies ClientFrame))
    })
    socket.addEventListener('message', (event) => {
      if (generation !== this.generation || typeof event.data !== 'string') return
      try {
        this.handle(JSON.parse(event.data) as ServerFrame)
      } catch {
        // A frame this build cannot read is not a reason to take the popup down.
      }
    })
    socket.addEventListener('close', () => {
      if (generation === this.generation) this.scheduleRetry()
    })
    socket.addEventListener('error', () => {
      if (generation === this.generation) this.scheduleRetry()
    })
  }

  /** The daemon may be restarting; the same chat finds its session again when it is back. */
  private scheduleRetry(): void {
    if (this.stopped || this.retry) return
    this.connected = false
    this.retry = setTimeout(() => {
      this.retry = null
      if (!this.stopped) this.connect()
    }, RETRY_MS)
  }

  private clearRetry(): void {
    if (!this.retry) return
    clearTimeout(this.retry)
    this.retry = null
  }

  private sendFrame(frame: ClientFrame): void {
    if (this.socket?.readyState !== 1) return
    this.socket.send(JSON.stringify(frame))
  }

  private handle(frame: ServerFrame): void {
    if (frame.type === 'ready') {
      this.connected = true
      this.sessionId = frame.sessionId
      this.writeStored(frame.sessionId)
      this.report({ type: 'ready' })
      if (this.queued !== null) {
        const text = this.queued
        this.queued = null
        this.ask(text)
      }
      return
    }
    if (frame.type === 'state') {
      this.busy = frame.busy
      return
    }
    if (frame.type === 'event') {
      const event = frame.event
      if (event.type === 'text-delta') this.report({ type: 'text', delta: event.delta })
      else if (event.type === 'tool-start') this.report({ type: 'tool', text: toolText(event.name, event.args), state: 'running' })
      else if (event.type === 'tool-end') this.report({ type: 'tool', text: toolText(event.name), state: event.isError ? 'failed' : 'done' })
      return
    }
    if (frame.type === 'permission') {
      this.report({ type: 'permission', id: frame.id, tool: toolDisplayName(frame.request.tool), summary: frame.request.summary, expiresAt: frame.expiresAt })
      return
    }
    if (frame.type === 'permission-result') {
      this.report({ type: 'permission-result', id: frame.id, allowed: frame.allowed })
      return
    }
    if (frame.type === 'turn-end') {
      this.busy = false
      this.report({ type: 'end', status: frame.status, ...(frame.says ? { says: frame.says } : {}) })
      if (this.restartPending) this.reset()
      return
    }
    if (frame.type === 'error') this.report({ type: 'error', message: frame.message })
  }

  private ask(text: string): void {
    const trimmed = text.trim()
    process.stderr.write(`[debug] ask ${trimmed} connected=${this.connected} state=${this.socket?.readyState}\n`)
    if (!trimmed) return
    if (!this.connected) {
      this.queued = trimmed
      return
    }
    this.busy = true
    this.sendFrame({ type: 'send', text: trimmed })
  }

  /**
   * The question outgrew the popup: fork it into a session of its own and hand its
   * address to the browser. The fork is separate, so forgetting this conversation
   * afterwards cannot take the real one with it.
   */
  private async handOver(): Promise<void> {
    if (this.busy || !this.sessionId) return
    try {
      const fork = await this.post<{ id: string }>('fork-session', { chatId: randomUUID(), sessionId: this.sessionId })
      this.report({ type: 'fork', url: appUrl({ host: this.host, port: this.port, token: this.token, open: fork.id }) })
      await this.dropStored()
      this.reset()
    } catch (error) {
      this.complain(errorMessage(error))
    }
  }

  private async post<T>(action: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${this.base}/api/${action}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    })
    const payload = (await response.json()) as T | { error?: string }
    if (!response.ok) {
      const said = payload && typeof payload === 'object' && 'error' in payload ? String(payload.error) : response.statusText
      throw new Error(said)
    }
    return payload as T
  }

  /**
   * What a popup leaves behind: a session is written to disk on its first turn, so
   * forgetting means deleting it — and a window killed before it could ask leaves
   * its id in a file for the next run to sweep.
   */
  private writeStored(sessionId: string): void {
    try {
      mkdirSync(MILO_HOME, { recursive: true })
      writeFileSync(STATE_FILE, `${JSON.stringify({ sessionId })}\n`)
    } catch {
      // A state file that cannot be written only costs a cleanup.
    }
  }

  private async dropStored(): Promise<void> {
    const stored = this.readStored()
    if (!stored) return
    try {
      rmSync(STATE_FILE, { force: true })
    } catch {
      // Same: best effort.
    }
    this.sessionId = ''
    await this.post('session-delete', { id: stored }).catch(() => undefined)
  }

  private readStored(): string {
    try {
      if (!existsSync(STATE_FILE)) return ''
      const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as { sessionId?: unknown }
      return typeof parsed.sessionId === 'string' ? parsed.sessionId : ''
    } catch {
      return ''
    }
  }

  private command(line: string): void {
    let parsed: Command
    try {
      parsed = JSON.parse(line) as Command
    } catch {
      return
    }
    if (parsed.type === 'ask') this.ask(parsed.text)
    else if (parsed.type === 'new') this.reset()
    else if (parsed.type === 'stop') this.sendFrame({ type: 'control', action: 'stop' })
    else if (parsed.type === 'permission') this.sendFrame({ type: 'control', action: parsed.decision, id: parsed.id })
    else if (parsed.type === 'continue') void this.handOver()
  }

  private readCommands(): void {
    const lines = createInterface({ input: process.stdin })
    lines.on('line', (line) => {
      if (line.trim()) this.command(line)
    })
    lines.on('close', () => this.close())
    process.once('SIGTERM', () => this.close())
    process.once('SIGINT', () => this.close())
  }

  /**
   * Nothing outlives the panel: the shell owns this process, and a helper that
   * lingers after its stdin closed would keep a socket and a timer alive for
   * nobody.
   */
  private close(): void {
    if (this.stopped) return
    this.stopped = true
    this.clearRetry()
    this.socket?.close()
    this.socket = null
    process.exit(0)
  }
}

/**
 * The token the daemon and the popup must agree on. Without one stored, every run
 * mints a different one and the popup would be refused, so the first launch writes
 * one the next `milo serve` will read.
 */
function ensureToken(): string {
  const auth = readAuth()
  const stored = resolveGatewayToken('web', auth)
  if (stored) return stored
  const token = randomBytes(32).toString('base64url')
  saveAuth({ ...auth, gateways: { ...auth.gateways, web: token } })
  process.stderr.write('Stored a web token in ~/.milo/auth.json, so the daemon and the popup read the same one.\n')
  return token
}

/** Walks up from this module to the tree that holds a file, whatever the bundle's shape. */
function findUp(relative: string): string | null {
  let dir = fileURLToPath(new URL('.', import.meta.url))
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(dir, relative)
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

export async function runSpotlight(argv = process.argv.slice(2)): Promise<void> {
  for (const arg of argv[0] === 'spotlight' ? argv.slice(1) : argv) {
    if (arg === '--help' || arg === '-h') {
      console.log('Usage: milo spotlight')
      console.log('Speaks the desktop popup\'s line protocol on stdin and stdout. The Omarchy shell plugin starts it;')
      console.log('it starts the web server when none is running. Nothing here is meant to be typed by hand.')
      return
    }
    throw new Error(`Unknown option: ${arg}. Usage: milo spotlight`)
  }
  const loaded = loadConfig()
  if (!loaded) throw new Error('No configuration found. Run `milo` first to set things up.')
  const { host, port } = loaded.config.web
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`The web port in ~/.milo/config.yml is not one: ${String(port)}.`)
  }
  await new SpotlightBridge(host, port, ensureToken()).start()
}
