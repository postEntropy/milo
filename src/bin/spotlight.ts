#!/usr/bin/env node
import { randomBytes, randomUUID } from 'node:crypto'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { WebSocket } from 'undici'
import { loadConfig, readAuth, resolveGatewayToken, saveAuth } from '../core/config/load.js'
import { matchProjectMention, type Project } from '../core/projects.js'
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
  | { type: 'offline' }
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

/**
 * `milo spotlight` — the process behind the desktop popup.
 *
 * The panel is QML, which has no WebSocket, so it starts this once and speaks to
 * it in NDJSON over stdio — the same shape the Omarchy shell uses for `wl-paste`
 * and its own IPC. What travels here is the web UI's own protocol: the popup and
 * the browser are two clients of one daemon, and the same session, permissions
 * and tools work in both.
 *
 * What it leaves behind is a session like any other, marked with the surface that
 * asked for it (`surface: 'spotlight'` on the handshake): the question can be found
 * later in the browser and on the phone, and resumed there.
 */
class SpotlightBridge {
  private readonly token: string
  private readonly host: string
  private readonly port: number
  private readonly base: string
  private readonly wsUrl: string
  private chatId = ''
  private sessionId = ''
  /** The project the session in front works in, as its own ready said it. */
  private project: string | undefined
  /** Bumped whenever the chat is replaced, so an HTTP reply cannot bind an old question. */
  private chatEpoch = 0
  private socket: WebSocket | null = null
  /** Bumped per connection, so a socket being retired cannot speak for the next one. */
  private generation = 0
  private connected = false
  private busy = false
  /**
   * A question waiting for the daemon to greet the chat it belongs to. `resolved`
   * is a request whose project was already chosen: it is said as it is, not read
   * for a mention a second time.
   */
  private queued: { text: string; resolved: boolean } | null = null
  private restartPending = false
  private retry: ReturnType<typeof setTimeout> | null = null
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

  start(): void {
    // Commands are read first: a closed stdin is noticed even while no daemon is there,
    // so the helper is never left waiting for nobody.
    this.readCommands()
    this.reset()
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
   * Whether a daemon is there to talk to. The popup never starts one: `milo serve` is the
   * person's to start, and this only watches for it. A missing daemon is said as `offline`
   * and tried again, so one started later is picked up without the popup being reopened.
   */
  private async reconnect(): Promise<void> {
    const generation = this.generation
    const state = await this.probe()
    if (this.stopped || generation !== this.generation) return // a reset or close overtook the probe
    if (state === 'ok') {
      this.connect()
      return
    }
    if (state === 'refused') {
      this.complain(`Something on port ${this.port} serves Milo with another token. Restart \`milo serve\` so it reads ~/.milo/auth.json.`)
    } else {
      this.report({ type: 'offline' })
    }
    this.scheduleRetry()
  }

  /**
   * A fresh question starts in a fresh conversation. The one before is not taken
   * with it: it stays on disk with the turns it has, to be read where it can be read.
   */
  private reset(): void {
    if (this.busy) {
      this.restartPending = true
      this.sendFrame({ type: 'control', action: 'stop' })
      return
    }
    this.startChat(randomUUID(), null)
  }

  /**
   * Binds the popup to a chat. A fresh chat is a fresh conversation; one a work
   * session was started for over HTTP is already bound to that session by the
   * runtime, so the handshake finds it. `queued` is said as soon as the daemon
   * greets the chat, which is what lets a mention become the turn it names.
   */
  private startChat(chatId: string, queued: { text: string; resolved: boolean } | null): void {
    this.chatEpoch += 1
    this.restartPending = false
    this.connected = false
    this.queued = queued
    this.clearRetry()
    this.socket?.close()
    this.socket = null
    this.sessionId = ''
    this.project = undefined
    this.chatId = chatId
    this.generation += 1
    void this.reconnect()
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
      socket.send(JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, chatId, genui: false, surface: 'spotlight' } satisfies ClientFrame))
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
      if (!this.stopped) void this.reconnect()
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
      // Where this session works, read from the session rather than remembered: a
      // daemon restarted behind the popup hands back a session that may be elsewhere.
      this.project = frame.project?.id
      this.report({ type: 'ready' })
      if (this.queued !== null) {
        const { text, resolved } = this.queued
        this.queued = null
        if (resolved) this.send(text)
        else this.ask(text)
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
    if (!trimmed) return
    if (!this.connected) {
      // Said again once the daemon greets the chat: which project the popup is in
      // is only known from that greeting, and a mention is read against it.
      this.queued = { text: trimmed, resolved: false }
      return
    }
    const mention = matchProjectMention(trimmed)
    if (mention.kind === 'error') {
      // Said every time it is asked: an unanswered question would leave the popup
      // waiting on a turn that was never started.
      this.report({ type: 'error', message: mention.error })
      return
    }
    if (mention.kind === 'none') {
      this.send(trimmed)
      return
    }
    if (!mention.text) {
      this.report({ type: 'error', message: `Say what to do in ${mention.project.name} after its name.` })
      return
    }
    // The session already works there: the mention only chose the context, and the
    // words belong to the conversation in front.
    if (this.project === mention.project.id) {
      this.send(mention.text)
      return
    }
    if (this.busy) {
      this.report({ type: 'error', message: 'A turn is still running. Stop it before asking in another project.' })
      return
    }
    void this.startInProject(mention.project, mention.text)
  }

  /** Sends the words into the session the popup is bound to. */
  private send(text: string): void {
    this.busy = true
    this.sendFrame({ type: 'send', text })
  }

  /**
   * A question that names a project is a work session in that project's folder: the
   * same session the Work screen starts, with the folder's tools, rules and changes,
   * opened without the list. The session is created over HTTP first, because only a
   * request can bind a chat to a session the handshake has not minted yet; the chat id
   * is fresh, so the conversation before this one stays where it is.
   */
  private async startInProject(project: Project, text: string): Promise<void> {
    const epoch = this.chatEpoch
    const chatId = randomUUID()
    try {
      await this.post<{ id: string }>('new-session', {
        chatId,
        project: project.id,
        surface: 'spotlight',
      })
    } catch (error) {
      // Said where the person is looking, and the chat in front is left as it was:
      // a project this daemon cannot start says so instead of asking somewhere else.
      this.report({ type: 'error', message: errorMessage(error) })
      return
    }
    // A fresh popup or a reset while the session was being created takes the question
    // with it rather than binding it to a chat the person has already left.
    if (epoch !== this.chatEpoch) return
    this.startChat(chatId, { text, resolved: true })
  }

  /**
   * The question outgrew the popup: fork it into a session of its own and hand its
   * address to the browser. The fork is separate, so the popup carrying on with a
   * fresh conversation cannot take the real one with it.
   */
  private async handOver(): Promise<void> {
    if (this.busy || !this.sessionId) return
    try {
      const fork = await this.post<{ id: string }>('fork-session', { chatId: randomUUID(), sessionId: this.sessionId })
      this.report({ type: 'fork', url: appUrl({ host: this.host, port: this.port, token: this.token, open: fork.id }) })
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

export async function runSpotlight(argv = process.argv.slice(2)): Promise<void> {
  for (const arg of argv[0] === 'spotlight' ? argv.slice(1) : argv) {
    if (arg === '--help' || arg === '-h') {
      console.log('Usage: milo spotlight')
      console.log('Speaks the desktop popup\'s line protocol on stdin and stdout. The Omarchy shell plugin starts it;')
      console.log('it never starts the web server: it says so while none is running and connects once `milo serve` is up. Nothing here is meant to be typed by hand.')
      console.log('A question that begins @<project> opens a work session in that project\'s folder.')
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
  new SpotlightBridge(host, port, ensureToken()).start()
}
