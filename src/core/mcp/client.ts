import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import { errorMessage } from '../../util/errors.js'
import { logDebug, logWarn } from '../../util/log.js'
import { resolveToolPath } from '../tools/walk.js'
import type { McpServerConfig } from './config.js'
import { resolveMcpEnv } from './config.js'
import {
  assertComplete,
  CLIENT_INFO,
  encodeMessage,
  LEGACY_PROTOCOL_VERSION,
  METHOD_NOT_FOUND,
  MODERN_PROTOCOL_VERSION,
  modernMeta,
  parseMessage,
  UNSUPPORTED_PROTOCOL_VERSION,
  type McpToolDefinition,
  type JsonRpcRequest,
} from './protocol.js'

/**
 * One MCP server, over stdio: Milo launches it, talks JSON-RPC to its standard
 * streams, and owns its lifetime.
 *
 * Nothing here is on the startup path. A server is spawned when someone first
 * needs it — a background warm as the runtime comes up, or the tool call itself,
 * whichever happens first — and the catalog the model sees comes from the cache
 * until then. The probe, the handshake and `tools/list` are paid once per
 * process, not once per turn.
 */

/** How long the era probe (which also covers the subprocess coming up) may take. */
const PROBE_TIMEOUT_MS = 10_000
const INITIALIZE_TIMEOUT_MS = 10_000
const LIST_TIMEOUT_MS = 20_000
/** A server that pages forever is a bug, not a big catalog. */
const MAX_LIST_PAGES = 100
/** How much of a server's stderr is kept to explain a failure. */
const STDERR_LINES = 20
const STDERR_LINE_CHARS = 300

/** A JSON-RPC error, kept as an error so a probe can read its code. */
export class JsonRpcCallError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message)
    this.name = 'JsonRpcCallError'
  }
}

interface Pending {
  method: string
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

export interface McpConnectResult {
  era: 'modern' | 'legacy'
  version: string
}

export interface McpClientOptions {
  name: string
  /** Milo's working directory, which a server's own `cwd` is resolved against. */
  cwd: string
  /**
   * What the cache says this server is. Only used to skip the probe for a known
   * legacy server — a silent legacy server would otherwise cost the probe's
   * whole timeout on every run. A wrong assumption falls back to the probe.
   */
  knownEra?: 'modern' | 'legacy'
  /** Called when the server says its tool list changed. Fired from a stream event, never awaited. */
  onToolsChanged?: () => void
  /**
   * Called when the process is gone for a reason that is not Milo's own shutdown.
   * A server that dies after it was ready would otherwise keep its `ready` state
   * — and its tool count — on every surface until the next call happened to fail.
   */
  onExit?: (error: Error) => void
}

export class McpClient {
  private child: ChildProcessWithoutNullStreams | null = null
  private reader: Interface | null = null
  /** Keyed by the id as a string: ids are ours and numeric, and the lookup is from the wire. */
  private readonly pending = new Map<string, Pending>()
  private readonly stderrLines: string[] = []
  private nextId = 1
  private era: 'modern' | 'legacy' | undefined
  private version = ''
  private failure: Error | null = null
  private closing = false
  private exitReported = false
  private exited: Promise<void> | null = null

  constructor(
    private readonly server: McpServerConfig,
    private readonly options: McpClientOptions,
  ) {}

  get eraName(): 'modern' | 'legacy' | undefined {
    return this.era
  }

  get protocolVersion(): string {
    return this.version
  }

  /** What the server calls itself, for a surface that wants to show it. */
  get serverName(): string {
    return this.options.name
  }

  /**
   * Starts the subprocess and settles what it is: probe, or handshake when the
   * cache already said legacy. The tool list is a separate call on purpose —
   * listing is what `refresh` needs, dialing is what a tool call needs, and
   * folding them together would make every call pay for a listing it does not
   * read.
   */
  async connect(): Promise<McpConnectResult> {
    this.start()
    return await this.detectEra()
  }

  private start(): void {
    if (this.child) return
    // A named variable that is not set is a config mistake, reported as one
    // before a process is started to fail in a more confusing way.
    const env = resolveMcpEnv(this.server, this.options.name)
    const command = this.server.command
    const child = spawn(command, this.server.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
      cwd: this.server.cwd ? resolveToolPath(this.options.cwd, this.server.cwd) : this.options.cwd,
    })
    this.child = child
    this.exited = new Promise((resolve) => child.once('exit', () => resolve()))

    this.reader = createInterface({ input: child.stdout })
    this.reader.on('line', (line) => this.handleLine(line))
    // A server that dies mid-conversation leaves a pipe that errors on the next
    // write. Without these the error is unhandled and takes Milo down with a
    // server that is merely gone — and it is going to be reported properly by
    // the exit handler anyway.
    child.stdin.on('error', (error) => logDebug(`mcp:${this.options.name} stdin: ${errorMessage(error)}`))
    child.stdout.on('error', (error) => logDebug(`mcp:${this.options.name} stdout: ${errorMessage(error)}`))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        const text = line.trim()
        if (!text) continue
        this.stderrLines.push(text.slice(0, STDERR_LINE_CHARS))
        if (this.stderrLines.length > STDERR_LINES) this.stderrLines.shift()
        // A server's log is its own; it goes to Milo's debug channel, never to
        // the conversation, and never as an error by itself.
        logDebug(`mcp:${this.options.name} ${text}`)
      }
    })
    child.on('error', (error) => {
      this.fail(new Error(`could not start "${command}": ${errorMessage(error)}`))
      this.reportExit()
    })
    child.on('exit', (code, signal) => {
      const reason = signal ? `was killed by ${signal}` : `exited with code ${code}`
      this.fail(
        new Error(
          `mcp server "${this.options.name}" ${reason}.${this.stderrNote()} ` +
            'Its tools stay out of the catalog until it is restarted.',
        ),
      )
      this.reportExit()
    })
  }

  /**
   * Tells the manager the process is gone, once — and never on the way out, where
   * an exit is the shutdown that was asked for rather than a failure.
   */
  private reportExit(): void {
    if (this.closing || this.exitReported) return
    this.exitReported = true
    this.options.onExit?.(this.failure ?? new Error(`mcp server "${this.options.name}" is gone.`))
  }

  /** The stderr a failure carries, so the reason is the server's own words. */
  private stderrNote(): string {
    if (this.stderrLines.length === 0) return ''
    return ` It said: ${this.stderrLines.slice(-3).join(' | ')}`
  }

  private fail(error: Error): void {
    // The first cause is the real one: a spawn failure is followed by an exit
    // event, and the exit's own words would otherwise replace "no such command".
    if (!this.failure) this.failure = error
    const reported = this.failure
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(reported)
    }
    this.pending.clear()
  }

  private handleLine(line: string): void {
    const message = parseMessage(line)
    if (!message) {
      if (line.trim()) logWarn(`mcp:${this.options.name} wrote a line that is not an MCP message: ${line.slice(0, 200)}`)
      return
    }
    if ('method' in message) {
      if ('id' in message) {
        // Legacy servers used to be allowed to ask the client for roots or
        // sampling. Milo declares no such capability; answering "no such
        // method" keeps a server that asks anyway from waiting forever.
        logWarn(`mcp:${this.options.name} asked Milo for ${message.method}, which it does not do.`)
        this.write({
          jsonrpc: '2.0',
          id: (message as JsonRpcRequest).id,
          error: { code: METHOD_NOT_FOUND, message: `${message.method} is not offered by this client.` },
        })
        return
      }
      if (message.method === 'notifications/tools/list_changed') this.options.onToolsChanged?.()
      return
    }
    if (message.id === null) return
    const pending = this.pending.get(String(message.id))
    if (!pending) {
      // A response to something already abandoned (a timeout, a cancelled call).
      logDebug(`mcp:${this.options.name} answered ${message.id} after it was given up on.`)
      return
    }
    this.pending.delete(String(message.id))
    clearTimeout(pending.timer)
    if (message.error) {
      pending.reject(
        new JsonRpcCallError(message.error.code, `${message.error.message} (${pending.method})`, message.error.data),
      )
      return
    }
    pending.resolve(message.result)
  }

  private write(message: unknown): void {
    try {
      this.child?.stdin.write(encodeMessage(message))
    } catch (error) {
      logDebug(`mcp:${this.options.name} could not be written to: ${errorMessage(error)}`)
    }
  }

  private notify(method: string, params?: Record<string, unknown>): void {
    this.write({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })
  }

  private request(
    method: string,
    params: Record<string, unknown> | undefined,
    timeoutMs: number,
    options: { meta?: boolean; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure)
    // `_meta` is the modern era's. A dual-era server reads its presence as "this
    // is a modern request", so it is sent exactly when the era is modern.
    const meta = options.meta ?? this.era !== 'legacy'
    const id = this.nextId
    this.nextId += 1
    const key = String(id)
    const message: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params: { ...(params ?? {}), ...(meta ? { _meta: modernMeta({}) } : {}) },
    }

    return new Promise<unknown>((resolve, reject) => {
      const settle = (error: Error | null, value?: unknown): void => {
        const pending = this.pending.get(key)
        if (!pending) return
        this.pending.delete(key)
        clearTimeout(pending.timer)
        options.signal?.removeEventListener('abort', onAbort)
        if (error) reject(error)
        else resolve(value)
      }
      const onAbort = (): void => {
        // The spec's cancellation: the server is told which request died, so it
        // can stop the work instead of finishing into a pipe nobody reads.
        this.notify('notifications/cancelled', { requestId: id, reason: 'the turn was stopped' })
        const error = new Error(`${method} was stopped.`)
        error.name = 'AbortError'
        settle(error)
      }
      const timer = setTimeout(() => {
        settle(new Error(`mcp server "${this.options.name}" did not answer ${method} within ${timeoutMs}ms.`))
      }, timeoutMs)
      timer.unref()
      this.pending.set(key, { method, resolve, reject, timer })
      if (options.signal?.aborted) {
        onAbort()
        return
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      this.write(message)
    })
  }

  /**
   * Which era the server is. The spec's stdio rule: probe with `server/discover`;
   * a `DiscoverResult` or an `UnsupportedProtocolVersionError` means modern, and
   * *anything else* — another error, or silence — means legacy, because a legacy
   * server answers an unknown pre-handshake method with whatever it likes. The
   * fallback is deliberately not keyed to one error code.
   */
  private async detectEra(): Promise<{ era: 'modern' | 'legacy'; version: string }> {
    if (this.options.knownEra === 'legacy') {
      try {
        return await this.initialize(LEGACY_PROTOCOL_VERSION)
      } catch (error) {
        logDebug(`mcp:${this.options.name} was cached as legacy but refused the handshake: ${errorMessage(error)}`)
      }
    }
    try {
      const result = await this.request('server/discover', {}, PROBE_TIMEOUT_MS, { meta: true })
      const versions = supportedVersions(result)
      if (versions.length === 0 || versions.includes(MODERN_PROTOCOL_VERSION)) {
        this.era = 'modern'
        this.version = MODERN_PROTOCOL_VERSION
        return { era: 'modern', version: this.version }
      }
      return await this.initialize(pickVersion(versions))
    } catch (error) {
      if (error instanceof JsonRpcCallError && error.code === UNSUPPORTED_PROTOCOL_VERSION) {
        return await this.initialize(pickVersion(supportedVersionsFromError(error)))
      }
      return await this.initialize(LEGACY_PROTOCOL_VERSION)
    }
  }

  private async initialize(version: string): Promise<{ era: 'legacy'; version: string }> {
    const result = await this.request(
      'initialize',
      { protocolVersion: version, capabilities: {}, clientInfo: { ...CLIENT_INFO } },
      INITIALIZE_TIMEOUT_MS,
      { meta: false },
    )
    // Set before the notification and before anything else goes out: from here
    // on every request belongs to the legacy conversation and carries no `_meta`.
    this.era = 'legacy'
    const negotiated = (result as Record<string, unknown> | null)?.protocolVersion
    this.version = typeof negotiated === 'string' ? negotiated : version
    this.notify('notifications/initialized')
    return { era: 'legacy', version: this.version }
  }

  /** Every tool the server offers, paging to the end. */
  async listTools(): Promise<McpToolDefinition[]> {
    const tools: McpToolDefinition[] = []
    let cursor: string | undefined
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const result = (await this.request(
        'tools/list',
        cursor ? { cursor } : {},
        LIST_TIMEOUT_MS,
      )) as Record<string, unknown> | null
      assertComplete(result, `tools/list (${this.options.name})`)
      if (!result || !Array.isArray(result.tools)) {
        throw new Error(`mcp server "${this.options.name}" answered tools/list without a tool list.`)
      }
      for (const tool of result.tools) {
        if (!tool || typeof tool !== 'object') continue
        const entry = tool as Record<string, unknown>
        if (typeof entry.name !== 'string' || entry.name === '') continue
        tools.push({
          name: entry.name,
          ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
          ...(entry.inputSchema && typeof entry.inputSchema === 'object'
            ? { inputSchema: entry.inputSchema as Record<string, unknown> }
            : {}),
        })
      }
      const next = result.nextCursor
      if (typeof next !== 'string' || next === '') return tools
      cursor = next
    }
    throw new Error(`mcp server "${this.options.name}" paged tools/list past ${MAX_LIST_PAGES} pages without ending.`)
  }

  /**
   * One tool call. The result is handed back as the server sent it — mapping it
   * into Milo's own shape is `tools.ts`'s job, and keeping the two apart is what
   * lets a surface report exactly what the server said.
   */
  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    const result = await this.request(
      'tools/call',
      { name, arguments: args ?? {} },
      this.server.timeoutMs,
      { signal },
    )
    assertComplete(result, `tools/call (${this.options.name}/${name})`)
    return result
  }

  /**
   * Lets the server go: close its input, wait for it to leave, and only then
   * insist. The spec's own order — a server that honors end-of-input exits on its
   * own, and the signals are for the ones that do not.
   */
  async close(): Promise<void> {
    const child = this.child
    if (!child || this.closing) return
    this.closing = true
    this.reader?.close()
    this.fail(new Error(`mcp server "${this.options.name}" is shutting down.`))
    if (child.pid === undefined) {
      // It never started (no such command): there is nothing to wait for, and
      // waiting anyway would hold up every exit by the whole grace period.
      try {
        child.kill()
      } catch {
        // Already gone.
      }
      return
    }
    try {
      child.stdin.end()
    } catch {
      // Already gone.
    }
    // A short grace, not a long one: a server that honors end-of-input is
    // already gone, and one that does not must not hold up Milo's own exit.
    if (await this.waitExit(750)) return
    child.kill('SIGTERM')
    if (await this.waitExit(750)) return
    child.kill('SIGKILL')
    await this.waitExit(750)
  }

  private async waitExit(ms: number): Promise<boolean> {
    if (!this.exited) return true
    return await Promise.race([
      this.exited.then(() => true),
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), ms)
        timer.unref()
      }),
    ])
  }
}

/** The versions a `DiscoverResult` advertises. */
function supportedVersions(result: unknown): string[] {
  const versions = (result as Record<string, unknown> | null)?.supportedVersions
  return Array.isArray(versions) ? versions.filter((entry): entry is string => typeof entry === 'string') : []
}

/** The same, out of the error a modern server returns for a version it does not implement. */
function supportedVersionsFromError(error: JsonRpcCallError): string[] {
  const supported = (error.data as Record<string, unknown> | null | undefined)?.supported
  return Array.isArray(supported) ? supported.filter((entry): entry is string => typeof entry === 'string') : []
}

/**
 * The newest version both sides know. Milo speaks exactly two, and a legacy
 * handshake is the only thing it can offer a server that does not list the
 * modern one.
 */
function pickVersion(versions: string[]): string {
  const known = versions.filter((version) => version <= MODERN_PROTOCOL_VERSION).sort()
  return known[known.length - 1] ?? LEGACY_PROTOCOL_VERSION
}
