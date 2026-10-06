import { errorMessage } from '../../util/errors.js'
import { logDebug, logWarn } from '../../util/log.js'
import { mcpFile } from '../config/paths.js'
import type { Tool, ToolRegistry } from '../tools/index.js'
import { readMcpCache, writeMcpCache, type McpCache, type CachedServer } from './cache.js'
import { McpClient } from './client.js'
import { readMcpConfig, setMcpServerEnabled, type McpConfig, type McpServerConfig } from './config.js'
import type { McpToolDefinition } from './protocol.js'
import { createMcpTools } from './tools.js'

/**
 * Every MCP server the install has, as one thing the registry can ask for tools.
 *
 * The shape of it is what keeps MCP off the startup path and off the turn path:
 *
 * - **Registration is synchronous and comes from the cache.** The catalog the
 *   model sees at the first turn is the one the servers described last time, read
 *   from a file. No subprocess exists yet, and nothing is waited for.
 * - **Connecting happens in the background.** `warm()` is started as the runtime
 *   comes up and never awaited. A server that takes four seconds to boot (an
 *   `npx` one does) is ready long before the person has finished typing, and the
 *   process is started once, not once per turn.
 * - **A tool call connects if it has to.** If someone calls a tool before the
 *   warm finished, or after a server died, the call itself pays the connection
 *   and the tool line on every surface shows it running while it does.
 * - **A server that fails is a state, not a silence.** The reason — including the
 *   server's own stderr — is kept and reported by `milo mcp` and the settings
 *   screen, and its tools stay out of the catalog rather than being offered to
 *   fail on. What the cache remembers of it keeps working until the next
 *   successful listing replaces it.
 */

/**
 * The install's MCP servers, built from the two files: never a throw at the
 * caller, because a broken `mcp.json` is a state the surfaces report rather than
 * a reason Milo cannot start.
 */
export function createMcpServers(cwd: string): McpServers {
  try {
    return new McpServers({ config: readMcpConfig(), cache: readMcpCache(), cwd })
  } catch (error) {
    logWarn(`mcp.json could not be read: ${errorMessage(error)}`)
    return new McpServers({
      config: { servers: {} },
      cache: { servers: {} },
      cwd,
      configError: errorMessage(error),
    })
  }
}

/** A failed server is not respawned more often than this; a dead one would otherwise be retried per call. */
const RESTART_FLOOR_MS = 1_000
const CACHE_WRITE_DEBOUNCE_MS = 250

export type McpServerState = 'idle' | 'connecting' | 'ready' | 'failed'

export interface McpServerStatus {
  name: string
  /** The command line, for a surface that has to show what this thing is. */
  command: string
  enabled: boolean
  state: McpServerState
  /** How many tools the catalog has from this server right now. */
  tools: number
  /** The server-side tool names the person declared read-only. */
  readOnly: string[]
  /** When the listing in the catalog came back, and which era answered it. */
  listingAt?: number
  era?: 'modern' | 'legacy'
  /** Why it is in the state it is in, in words — a failure's own message. */
  error?: string
}

/**
 * What a surface reports about the servers: the CLI, the settings screen and the
 * line the system prompt carries. One shape, drawn from the manager, so the three
 * cannot describe the same install differently.
 *
 * Cheap by construction — it is state the manager already holds, and it starts no
 * process. That is also why it is the answer to "do I have MCP", where the tool
 * catalog is not: a server that is off, or that failed, registers no tools and
 * would be missing from the catalog exactly when naming it is the answer.
 */
export interface McpFacts {
  /** Where the servers are written, so a surface can say where to add one. */
  file: string
  /** Why there is no server list at all, when the file could not be read. */
  error?: string
  servers: McpServerStatus[]
}

/** The install's MCP servers as they are, for a surface that has to report them. */
export function mcpFacts(mcp: McpServers | null | undefined): McpFacts {
  return {
    file: mcpFile(),
    ...(mcp?.configError ? { error: mcp.configError } : {}),
    servers: mcp?.status() ?? [],
  }
}

interface RefreshState {
  promise: Promise<void>
  /** Set by a request that arrived while this run was listing. */
  again: boolean
}

interface Live {
  client: McpClient
  promise?: Promise<McpClient>
  state: McpServerState
  error?: string
  lastFailureAt: number
}

export interface McpServersOptions {
  config: McpConfig
  cache: McpCache
  /** Milo's working directory, which a server's own `cwd` is resolved against. */
  cwd: string
  /**
   * Set when `mcp.json` could not be read at all. There is then no server list to
   * hold tools for, and nothing is spawned — the reason is what every surface
   * reports instead.
   */
  configError?: string
}

export class McpServers {
  private config: McpConfig
  private readonly cache: McpCache
  private readonly live = new Map<string, Live>()
  /** What the catalog holds per server: the cache at first, the live listing after. */
  private readonly listings = new Map<string, McpToolDefinition[]>()
  /** The listing in flight per server, so two of them never race to write. */
  private readonly refreshing = new Map<string, RefreshState>()
  /** The names this manager put in the registry, so a vanished tool can be taken back out. */
  private registered = new Set<string>()
  private registry: ToolRegistry | null = null
  private cacheTimer: NodeJS.Timeout | null = null
  private closed = false
  /** Set when the file could not be read: every surface reports this instead of a server list. */
  private problem?: string

  constructor(private readonly options: McpServersOptions) {
    this.config = options.config
    this.cache = options.cache
    this.problem = options.configError
    // A file Milo could not read is a file whose servers it cannot vouch for, so
    // not even the cache is registered from it.
    if (this.problem === undefined) {
      for (const [name, cached] of Object.entries(this.cache.servers)) {
        this.listings.set(name, cached.tools)
      }
    }
  }

  /** Why there are no servers at all, when the file could not be read. */
  get configError(): string | undefined {
    return this.problem
  }

  /** The names in the file that are turned on. */
  private enabledServers(): [string, McpServerConfig][] {
    return Object.entries(this.config.servers)
      .filter(([, server]) => server.enabled)
      .sort(([a], [b]) => a.localeCompare(b))
  }

  /**
   * Puts the cached catalog in the registry, before anything is spawned. Called
   * once, as the tool registry is built.
   */
  register(registry: ToolRegistry): void {
    this.registry = registry
    this.rebuild()
  }

  /**
   * What the catalog should hold: the listing in hand for each server that is on,
   * and nothing from the servers that are off. Every path that changes either one
   * — a listing, a toggle, a re-read of the file, registering the cache at
   * startup — ends here, so there is one answer to what is registered.
   */
  private rebuild(): void {
    const registry = this.registry
    if (!registry) return
    const wanted = new Map<string, Tool<unknown>>()
    const used = new Set<string>()
    for (const [name, server] of this.enabledServers()) {
      const definitions = this.listings.get(name)
      if (!definitions) continue
      for (const tool of createMcpTools(
        { server: name, readOnly: server.readOnly },
        definitions,
        (toolName, args, signal) => this.call(name, toolName, args, signal),
        used,
      )) {
        wanted.set(tool.name, tool)
      }
    }
    // Registered unconditionally: it is a Map write, and a tool whose description
    // or schema moved must not keep the one from the listing before it.
    for (const tool of wanted.values()) registry.register(tool)
    for (const name of this.registered) {
      if (!wanted.has(name)) registry.unregister(name)
    }
    this.registered = new Set(wanted.keys())
  }

  /**
   * Connects everything that is on, in parallel, and refreshes what the catalog
   * holds. Fire-and-forget by design: the runtime starts this and does not wait.
   */
  async warm(): Promise<void> {
    if (this.closed) return
    await Promise.all(this.enabledServers().map(async ([name]) => {
      try {
        await this.refresh(name)
      } catch (error) {
        // The reason is already on the live entry; a warm must never reject,
        // because nothing is waiting for it.
        logDebug(`mcp:${name} did not warm: ${errorMessage(error)}`)
      }
    }))
  }

  /**
   * Re-reads the file, and starts connecting whatever is new in it.
   *
   * The file is the interface, so a hand edit must not require a restart. Reading
   * it is synchronous and cheap — a server added by hand is in the catalog, from
   * its cache if it has one — and the connecting is the same background warm as
   * startup: a surface that asked for the re-read gets an answer in milliseconds,
   * not after the slowest server in the file has booted.
   */
  reload(): void {
    try {
      this.config = readMcpConfig()
      this.problem = undefined
      for (const [name, cached] of Object.entries(this.cache.servers)) {
        if (!this.listings.has(name)) this.listings.set(name, cached.tools)
      }
      this.rebuild()
    } catch (error) {
      this.problem = errorMessage(error)
      logWarn(`could not re-read mcp.json: ${this.problem}`)
      return
    }
    void this.warm()
  }

  /**
   * Connects one server if it is not connected, and returns the client.
   *
   * `ignoreFloor` is what separates an attempt a person asked for (`check`,
   * `warm`, a settings toggle — always the real answer, even a second after a
   * failure) from a tool call, which a turn can make five times in a row and
   * which is therefore held off a dead server for a moment.
   */
  private async client(name: string, options: { ignoreFloor?: boolean } = {}): Promise<McpClient> {
    const server = this.config.servers[name]
    if (!server) throw new Error(`mcp.json has no server named "${name}".`)
    const existing = this.live.get(name)
    if (existing?.state === 'ready' && !existing.promise) return existing.client
    if (existing?.promise) return await existing.promise

    const lastFailureAt = existing?.lastFailureAt ?? 0
    const since = Date.now() - lastFailureAt
    if (!options.ignoreFloor && lastFailureAt > 0 && since < RESTART_FLOOR_MS) {
      throw new Error(
        `mcp server "${name}" is not being restarted yet — it failed ${Math.round(since / 100) / 10}s ago.`,
      )
    }

    const client = new McpClient(server, {
      name,
      cwd: this.options.cwd,
      // What the cache settled last time, so a legacy server is not probed again.
      knownEra: this.cache.servers[name]?.era,
      // A server that dies after it answered keeps working from the cache, but
      // the surfaces must read it as failed rather than as connected.
      onExit: (error) => this.markFailed(name, error),
      onToolsChanged: () => {
        void this.refresh(name).catch((error: unknown) => {
          logWarn(`mcp:${name} could not refresh its tools: ${errorMessage(error)}`)
        })
      },
    })
    const entry: Live = { client, state: 'connecting', lastFailureAt }
    this.live.set(name, entry)
    entry.promise = client
      .connect()
      .then((result) => {
        entry.state = 'ready'
        entry.error = undefined
        entry.promise = undefined
        logDebug(`mcp:${name} is up (${result.era} ${result.version})`)
        return client
      })
      .catch((error: unknown) => {
        this.markFailed(name, error)
        // The cached listing stays in the catalog: its tools may still work once
        // the server is back, and taking them away would make a flaky server
        // silently shrink what the model can do. A shutdown is not a failure,
        // and saying so on the way out would be noise about our own exit.
        if (!this.closed) logWarn(`mcp server "${name}" is not available: ${errorMessage(error)}`)
        throw error
      })
    return await entry.promise
  }

  /**
   * Connects one server now and answers with what it offers. What `milo mcp
   * check` runs: the connect and the listing, with the catalog updated behind it.
   */
  async check(name: string): Promise<McpToolDefinition[]> {
    if (this.problem) throw new Error(this.problem)
    if (this.config.servers[name]?.enabled === false) {
      // Connecting it anyway would be Milo acting on a server the person took
      // out of the catalog — the switch means the process is not run at all.
      throw new Error(`mcp server "${name}" is off. Turn it on with \`milo mcp enable ${name}\` first.`)
    }
    if (!this.config.servers[name]) {
      const known = Object.keys(this.config.servers)
      throw new Error(
        `mcp.json has no server named "${name}".${known.length > 0 ? ` It has: ${known.join(', ')}.` : ''}`,
      )
    }
    await this.refresh(name)
    return this.listings.get(name) ?? []
  }

  /**
   * The server is not usable, and this is why. Every path that finds that out —
   * a failed dial, a failed listing, a server that died between the two — goes
   * through here, or a surface would report "ready" for something that is gone.
   */
  private markFailed(name: string, error: unknown): void {
    const entry = this.live.get(name)
    if (!entry) return
    entry.state = 'failed'
    entry.error = errorMessage(error)
    entry.promise = undefined
    entry.lastFailureAt = Date.now()
  }

  /**
   * Connects if needed, then replaces what the catalog holds for one server.
   *
   * One listing per server at a time, and a request that arrives during one is
   * not a second race — it is a note that this server has something new to say,
   * which makes the run in flight list once more before it is done. That is what
   * a `list_changed` is, and it is also why `check` can answer with the listing
   * it asked for instead of one a newer refresh has already invalidated.
   */
  private async refresh(name: string): Promise<void> {
    const inFlight = this.refreshing.get(name)
    if (inFlight) {
      inFlight.again = true
      return await inFlight.promise
    }
    const state: RefreshState = { promise: Promise.resolve(), again: false }
    state.promise = this.listUntilSettled(name, state)
    this.refreshing.set(name, state)
    try {
      await state.promise
    } finally {
      this.refreshing.delete(name)
      // A request that arrived in the last instant, after the loop had looked,
      // still gets its listing rather than being folded into one already gone.
      if (state.again) await this.refresh(name)
    }
  }

  private async listUntilSettled(name: string, state: RefreshState): Promise<void> {
    do {
      state.again = false
      await this.listOnce(name)
    } while (state.again)
  }

  /** One connect and one `tools/list`, written to the catalog and the cache. */
  private async listOnce(name: string): Promise<void> {
    const client = await this.client(name, { ignoreFloor: true })
    let tools: McpToolDefinition[]
    try {
      tools = await client.listTools()
    } catch (error) {
      this.markFailed(name, error)
      throw error
    }
    this.listings.set(name, tools)
    this.cache.servers[name] = {
      era: client.eraName ?? 'modern',
      version: client.protocolVersion,
      tools,
      at: Date.now(),
    } satisfies CachedServer
    this.scheduleCacheWrite()
    this.rebuild()
  }

  /** The tool call a server's tools run through. */
  private async call(name: string, tool: string, args: unknown, signal: AbortSignal): Promise<unknown> {
    if (this.closed) throw new Error(`mcp server "${name}" is shutting down.`)
    const client = await this.client(name)
    return await client.callTool(tool, args, signal)
  }

  private scheduleCacheWrite(): void {
    if (this.cacheTimer) return
    const timer = setTimeout(() => {
      this.cacheTimer = null
      void writeMcpCache(this.cache)
    }, CACHE_WRITE_DEBOUNCE_MS)
    timer.unref()
    this.cacheTimer = timer
  }

  /** What every surface that reports MCP draws from: one list, one shape. */
  status(): McpServerStatus[] {
    return Object.entries(this.config.servers)
      .map(([name, server]) => {
        const entry = this.live.get(name)
        const cached = this.cache.servers[name]
        const definitions = this.listings.get(name)
        // A server that is off keeps its cached listing out of the catalog, so
        // the count a surface shows follows what the model can actually call.
        const tools = server.enabled ? (definitions?.length ?? 0) : 0
        return {
          name,
          command: [server.command, ...server.args].join(' '),
          enabled: server.enabled,
          state: entry?.state ?? 'idle',
          tools,
          readOnly: server.readOnly,
          ...(cached ? { listingAt: cached.at, era: cached.era } : {}),
          ...(entry?.error ? { error: entry.error } : {}),
        } satisfies McpServerStatus
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Turns one server on or off in the file, applying it now rather than at the next run. */
  async setEnabled(name: string, enabled: boolean): Promise<void> {
    const server = this.config.servers[name]
    if (!server) throw new Error(`mcp.json has no server named "${name}".`)
    await setMcpServerEnabled(name, enabled)
    server.enabled = enabled
    if (!enabled) {
      // Off means its process goes too: a server nobody can call has no reason to
      // be holding memory on the machine.
      const entry = this.live.get(name)
      this.live.delete(name)
      await entry?.client.close().catch(() => undefined)
    }
    this.rebuild()
    if (enabled) {
      // The state change is what was asked for; connecting is a warm of its own
      // and must not hold the surface that flipped the switch.
      void this.refresh(name).catch((error: unknown) => {
        logDebug(`mcp:${name} did not warm after being enabled: ${errorMessage(error)}`)
      })
    }
  }

  /** Every server's process, let go. Called as the runtime closes. */
  async close(): Promise<void> {
    this.closed = true
    if (this.cacheTimer) {
      clearTimeout(this.cacheTimer)
      this.cacheTimer = null
      await writeMcpCache(this.cache)
    }
    await Promise.all([...this.live.values()].map((entry) => entry.client.close().catch(() => undefined)))
    this.live.clear()
  }
}
