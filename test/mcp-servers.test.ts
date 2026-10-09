import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LoadedConfig } from '../src/core/config/load.js'
import type { ToolContext } from '../src/core/tools/types.js'

// Point the install somewhere throwaway *before* the path module is loaded.
const home = mkdtempSync(path.join(tmpdir(), 'milo-mcp-servers-'))
process.env.MILO_HOME = home

const { createMcpServers, mcpFacts } = await import('../src/core/mcp/servers.js')
const { McpClient } = await import('../src/core/mcp/client.js')
const { writeMcpCache } = await import('../src/core/mcp/cache.js')
const { ToolRegistry } = await import('../src/core/tools/registry.js')
const { createRuntime } = await import('../src/core/bootstrap.js')
const { mcpCacheFile, mcpFile } = await import('../src/core/config/paths.js')

const fixture = path.join(process.cwd(), 'test', 'fixtures', 'mcp-server.mjs')
const cwd = process.cwd()

const context = (signal = new AbortController().signal): ToolContext => ({ cwd, signal })

/** One server entry pointing at the fixture, with whatever the case needs it to be. */
const server = (env: Record<string, string> = {}, extra: Record<string, unknown> = {}) => ({
  command: process.execPath,
  args: [fixture],
  env,
  ...extra,
})

function writeServers(servers: Record<string, unknown>): void {
  writeFileSync(mcpFile(), `${JSON.stringify({ servers }, null, 2)}\n`)
}

async function until(condition: () => boolean, ms = 4_000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('the condition never became true')
}

beforeEach(() => {
  // Every case starts with nothing known: a cached era from another case would
  // decide the probe for it.
  rmSync(mcpCacheFile(), { force: true })
})

describe('an MCP server over stdio', () => {
  it('connects a modern server and lists what it offers', async () => {
    writeServers({ fixture: server({ MCP_ERA: 'modern' }) })
    const manager = createMcpServers(cwd)
    try {
      const tools = await manager.check('fixture')
      expect(tools.map((tool) => tool.name)).toEqual(['echo', 'picture'])
      expect(manager.status()[0]).toMatchObject({ name: 'fixture', state: 'ready', era: 'modern', tools: 2 })
    } finally {
      await manager.close()
    }
  })

  it('sends the modern protocol version on a modern request', async () => {
    writeServers({ fixture: server({ MCP_ERA: 'modern' }) })
    const manager = createMcpServers(cwd)
    try {
      const registry = new ToolRegistry()
      manager.register(registry)
      await manager.check('fixture')
      const result = await registry.execute('mcp__fixture__echo', { text: 'hi' }, context())
      expect(result.content).toBe('echo {"text":"hi"} | _meta:yes')
    } finally {
      await manager.close()
    }
  })

  it('falls back to the handshake when the server refuses an unhandshaken request', async () => {
    writeServers({ fixture: server({ MCP_ERA: 'legacy' }) })
    const manager = createMcpServers(cwd)
    try {
      const registry = new ToolRegistry()
      manager.register(registry)
      const tools = await manager.check('fixture')
      expect(tools.map((tool) => tool.name)).toEqual(['echo', 'picture'])
      expect(manager.status()[0]?.era).toBe('legacy')
      // A legacy conversation carries no `_meta`: a dual-era server reads its
      // presence as the modern path, so sending it would change what it is doing.
      const result = await registry.execute('mcp__fixture__echo', { text: 'hi' }, context())
      expect(result.content).toBe('echo {"text":"hi"} | _meta:no')
    } finally {
      await manager.close()
    }
  })

  it('takes a supported version from a modern server that refuses the requested one', async () => {
    writeServers({ fixture: server({ MCP_ERA: 'refuse-modern' }) })
    const manager = createMcpServers(cwd)
    try {
      const tools = await manager.check('fixture')
      expect(tools.length).toBe(2)
      const status = manager.status()[0]
      expect(status?.era).toBe('legacy')
      expect(status?.error).toBeUndefined()
    } finally {
      await manager.close()
    }
  })

  it('pages a tool list to the end', async () => {
    const tools = Array.from({ length: 6 }, (_, index) => ({ name: `tool_${index}`, description: `t${index}` }))
    writeServers({ fixture: server({ MCP_PAGES: '3', MCP_TOOLS: JSON.stringify(tools) }) })
    const manager = createMcpServers(cwd)
    try {
      expect((await manager.check('fixture')).map((tool) => tool.name)).toEqual(tools.map((tool) => tool.name))
    } finally {
      await manager.close()
    }
  })

  it('reads past a line that is not a message', async () => {
    writeServers({ fixture: server({ MCP_BANNER: '1' }) })
    const manager = createMcpServers(cwd)
    try {
      expect((await manager.check('fixture')).length).toBe(2)
    } finally {
      await manager.close()
    }
  })

  it('answers a server that asks the client for something, instead of hanging on it', async () => {
    writeServers({
      fixture: server({ MCP_TOOLS: JSON.stringify([{ name: 'ask-milo', description: 'Asks the client.' }]) }),
    })
    const manager = createMcpServers(cwd)
    try {
      const registry = new ToolRegistry()
      manager.register(registry)
      await manager.check('fixture')
      const result = await registry.execute('mcp__fixture__ask-milo', {}, context())
      expect(result.content).toMatch(/^client said: roots\/list is not offered by this client\.$/)
    } finally {
      await manager.close()
    }
  })

  it('replaces the catalog when the server says its tools changed', async () => {
    const later = [{ name: 'later', description: 'The one it has now.' }]
    writeServers({
      fixture: server({
        MCP_TOOLS: JSON.stringify([{ name: 'echo', description: 'The one it will drop.' }]),
        MCP_TOOLS_AFTER: JSON.stringify(later),
      }),
    })
    const manager = createMcpServers(cwd)
    try {
      const registry = new ToolRegistry()
      manager.register(registry)
      // The listing the server had, then the one it says it has now: `check`
      // settles on the newest, so only the end state is the assertion.
      await manager.check('fixture')
      await until(() => registry.has('mcp__fixture__later'))
      expect(registry.has('mcp__fixture__echo')).toBe(false)
    } finally {
      await manager.close()
    }
  })

  it('reports a result the server says it has not finished', async () => {
    writeServers({
      fixture: server({ MCP_TOOLS: JSON.stringify([{ name: 'input_required', description: 'Wants a form.' }]) }),
    })
    const manager = createMcpServers(cwd)
    try {
      const registry = new ToolRegistry()
      manager.register(registry)
      await manager.check('fixture')
      const result = await registry.execute('mcp__fixture__input_required', {}, context())
      expect(result.isError).toBe(true)
      expect(result.content).toMatch(/asked for input/)
    } finally {
      await manager.close()
    }
  })

  it('carries a tool failure the server flagged', async () => {
    writeServers({
      fixture: server({ MCP_TOOLS: JSON.stringify([{ name: 'boom', description: 'Fails.' }]) }),
    })
    const manager = createMcpServers(cwd)
    try {
      const registry = new ToolRegistry()
      manager.register(registry)
      await manager.check('fixture')
      const result = await registry.execute('mcp__fixture__boom', {}, context())
      expect(result).toMatchObject({ content: 'the tool went wrong', isError: true })
    } finally {
      await manager.close()
    }
  })

  it('gives up on a call the server never answers, and says how long it waited', async () => {
    writeServers({
      fixture: server({ MCP_TOOLS: JSON.stringify([{ name: 'hang', description: 'Never answers.' }]) }, { timeoutMs: 300 }),
    })
    const manager = createMcpServers(cwd)
    try {
      const registry = new ToolRegistry()
      manager.register(registry)
      await manager.check('fixture')
      const result = await registry.execute('mcp__fixture__hang', {}, context())
      expect(result.isError).toBe(true)
      expect(result.content).toMatch(/did not answer tools\/call within 300ms/)
    } finally {
      await manager.close()
    }
  })

  it('abandons a call when the turn stops', async () => {
    writeServers({
      fixture: server({
        MCP_TOOLS: JSON.stringify([
          { name: 'hang', description: 'Never answers.' },
          { name: 'echo', description: 'Echo the arguments back.' },
        ]),
      }),
    })
    const manager = createMcpServers(cwd)
    try {
      const registry = new ToolRegistry()
      manager.register(registry)
      await manager.check('fixture')
      const controller = new AbortController()
      const call = registry.execute('mcp__fixture__hang', {}, context(controller.signal))
      controller.abort()
      const result = await call
      expect(result.isError).toBe(true)
      expect(result.content).toMatch(/was stopped/)
      // The connection is still usable after one call was abandoned.
      const after = await registry.execute('mcp__fixture__echo', { again: true }, context())
      expect(after.content).toContain('echo {"again":true}')
    } finally {
      await manager.close()
    }
  })
})

describe('an MCP server that will not run', () => {
  it('reports why, in the command’s own words', async () => {
    writeServers({ fixture: { command: 'milo-no-such-mcp-server', args: [] } })
    const manager = createMcpServers(cwd)
    try {
      await expect(manager.check('fixture')).rejects.toThrow(/could not start "milo-no-such-mcp-server"/)
      expect(manager.status()[0]).toMatchObject({ state: 'failed' })
      expect(manager.status()[0]?.error).toMatch(/ENOENT/)
    } finally {
      await manager.close()
    }
  })

  it('lets go of a client it gives up on, instead of orphaning its process', async () => {
    writeServers({ fixture: { command: 'milo-no-such-mcp-server', args: [] } })
    const manager = createMcpServers(cwd)
    const close = vi.spyOn(McpClient.prototype, 'close')
    try {
      await expect(manager.check('fixture')).rejects.toThrow(/could not start/)
      expect(close).toHaveBeenCalled()

      // A second attempt replaces the failed entry; the first client must already
      // have been closed, not lost by the overwrite.
      await expect(manager.check('fixture')).rejects.toThrow(/could not start/)
      expect(close.mock.calls.length).toBeGreaterThanOrEqual(2)
    } finally {
      close.mockRestore()
      await manager.close()
    }
  })

  it('reports a server that dies, with what it said on stderr', async () => {
    writeServers({
      fixture: server({ MCP_ERA: 'legacy', MCP_EXIT_AFTER: 'init', MCP_STDERR: 'the token is wrong' }),
    })
    const manager = createMcpServers(cwd)
    try {
      await expect(manager.check('fixture')).rejects.toThrow(/exited with code 1/)
      expect(manager.status()[0]?.error).toMatch(/the token is wrong/)
    } finally {
      await manager.close()
    }
  })

  it('marks a server that dies after it was ready as failed, without waiting for a call', async () => {
    writeServers({ fixture: server({ MCP_EXIT_AFTER: 'list' }) })
    const manager = createMcpServers(cwd)
    try {
      expect((await manager.check('fixture')).length).toBe(2)
      await until(() => manager.status()[0]?.state === 'failed')
      // The listing it gave stays in the catalog, and the reason is its own exit.
      expect(manager.status()[0]).toMatchObject({ state: 'failed', tools: 2 })
      expect(manager.status()[0]?.error).toMatch(/exited with code 1/)
    } finally {
      await manager.close()
    }
  })
})

describe('the catalog before anything is started', () => {
  it('has the cached tools while the server is still starting', async () => {
    const slow = server({ MCP_DELAY_MS: '4000' })
    writeServers({ fixture: slow })
    await writeMcpCache({
      servers: {
        fixture: {
          era: 'modern',
          version: '2026-07-28',
          tools: [{ name: 'echo', description: 'Echo the arguments back.' }],
          at: 1_700_000_000_000,
        },
      },
    })

    const manager = createMcpServers(cwd)
    try {
      const registry = new ToolRegistry()
      const started = Date.now()
      manager.register(registry)
      // Registration is the cache and nothing else: no process, no round trip —
      // so nothing has been dialed, and the tool is in the catalog anyway.
      expect(Date.now() - started).toBeLessThan(250)
      expect(registry.has('mcp__fixture__echo')).toBe(true)
      expect(manager.status()[0]).toMatchObject({ tools: 1, state: 'idle' })
      void manager.warm()
      expect(registry.has('mcp__fixture__echo')).toBe(true)
    } finally {
      await manager.close()
    }
  })

  it('registers a cached tool even when the server cannot be started at all', async () => {
    writeServers({ fixture: { command: 'milo-no-such-mcp-server', args: [] } })
    await writeMcpCache({
      servers: {
        fixture: {
          era: 'legacy',
          version: '2025-11-25',
          tools: [{ name: 'echo', description: 'Echo the arguments back.' }],
          at: 1_700_000_000_000,
        },
      },
    })
    const manager = createMcpServers(cwd)
    try {
      const registry = new ToolRegistry()
      manager.register(registry)
      expect(registry.has('mcp__fixture__echo')).toBe(true)
    } finally {
      await manager.close()
    }
  })

  it('takes a disabled server’s tools out and leaves them out', async () => {
    writeServers({ fixture: server({}, { enabled: false }) })
    await writeMcpCache({
      servers: {
        fixture: { era: 'modern', version: '2026-07-28', tools: [{ name: 'echo' }], at: 1 },
      },
    })
    const manager = createMcpServers(cwd)
    try {
      const registry = new ToolRegistry()
      manager.register(registry)
      expect(registry.has('mcp__fixture__echo')).toBe(false)
      expect(manager.status()[0]).toMatchObject({ enabled: false, tools: 0 })
    } finally {
      await manager.close()
    }
  })

  it('refuses to connect a server that is turned off', async () => {
    writeServers({ fixture: server({}, { enabled: false }) })
    const manager = createMcpServers(cwd)
    try {
      await expect(manager.check('fixture')).rejects.toThrow(/is off\. Turn it on/)
    } finally {
      await manager.close()
    }
  })

  it('lets a server go when the file turns it off, instead of leaving its process running', async () => {
    writeServers({ fixture: server({ MCP_ERA: 'modern' }) })
    const manager = createMcpServers(cwd)
    const close = vi.spyOn(McpClient.prototype, 'close')
    try {
      await manager.check('fixture')
      expect(manager.status()[0]?.state).toBe('ready')

      // The person turns it off by hand, and the file is re-read.
      writeServers({ fixture: server({ MCP_ERA: 'modern' }, { enabled: false }) })
      manager.reload()

      expect(close).toHaveBeenCalled()
      expect(manager.status()[0]).toMatchObject({ enabled: false, state: 'idle' })
    } finally {
      close.mockRestore()
      await manager.close()
    }
  })

  it('reports a config it cannot read instead of starting anything', async () => {
    writeFileSync(mcpFile(), '{ "servers": { "github": { "command": "npx", "comand": "typo" } } }')
    const manager = createMcpServers(cwd)
    try {
      expect(manager.configError).toMatch(/has no field named "comand"/)
      expect(manager.status()).toEqual([])
    } finally {
      await manager.close()
    }
  })
})

describe('the report every surface draws from', () => {
  it('names the file, and each server with what it holds', async () => {
    writeServers({ github: server({ MCP_ERA: 'modern' }), notes: { command: 'node', enabled: false } })
    const manager = createMcpServers(cwd)
    try {
      await manager.check('github')
      const facts = mcpFacts(manager)
      expect(facts.file).toBe(mcpFile())
      expect(facts.servers).toEqual([
        expect.objectContaining({ name: 'github', enabled: true, tools: 2 }),
        expect.objectContaining({ name: 'notes', enabled: false, tools: 0 }),
      ])
    } finally {
      await manager.close()
    }
  })

  it('carries the reason when the file itself could not be read', async () => {
    writeFileSync(mcpFile(), '{ "servers": { "github": { "command": "npx", "comand": "typo" } } }')
    const manager = createMcpServers(cwd)
    try {
      expect(mcpFacts(manager).file).toBe(mcpFile())
      expect(mcpFacts(manager).error).toMatch(/has no field named "comand"/)
    } finally {
      await manager.close()
    }
  })

  it('says there is nothing when the runtime was built without MCP at all', () => {
    expect(mcpFacts(null)).toEqual({ file: mcpFile(), servers: [] })
  })
})

describe('the runtime', () => {
  const loadedConfig = (): LoadedConfig => ({
    config: {
      provider: 'test',
      model: 'test-model',
      providers: { test: { baseURL: 'http://127.0.0.1:1/v1', wire: 'openai' } },
      memory: { derive: false },
      sessions: { compactAt: 0.7, maxInputTokens: 12000, keepTurns: 8, compaction: true, maxSessions: 50 },
      history: { windowDays: 365 },
      traces: { enabled: true },
      display: { tools: 'full', thinking: 'on' },
      reasoningEffort: 'medium',
      google: { enabled: false },
      gateways: {},
      web: { enabled: false, host: '127.0.0.1', port: 7717 },
      permissions: { mode: 'ask', allow: [], deny: [], jevThreshold: 0.35, jevTimeoutMs: 1500 },
      classifier: { backend: 'commandcode' },
      browser: {
        enabled: false,
        chromePath: null,
        headless: true,
        profileDir: null,
        cdpUrl: null,
        keepSnapshots: 2,
      },
      jobs: { max: 8 },
    },
    provider: { id: 'test', baseURL: 'http://127.0.0.1:1/v1', apiKey: 'k', wire: 'openai' },
    model: 'test-model',
  })

  it('starts without waiting for a slow server, and already has its tools', async () => {
    writeServers({ fixture: server({ MCP_DELAY_MS: '4000' }) })
    await writeMcpCache({
      servers: {
        fixture: {
          era: 'modern',
          version: '2026-07-28',
          tools: [{ name: 'echo', description: 'Echo the arguments back.' }],
          at: 1_700_000_000_000,
        },
      },
    })
    const started = Date.now()
    const runtime = createRuntime(loadedConfig(), cwd)
    const elapsed = Date.now() - started
    try {
      // The server takes four seconds to answer anything. Startup must not be
      // anywhere near that: the cache is what the first turn runs on.
      expect(elapsed).toBeLessThan(3_000)
      expect(runtime.mcp?.status()).toEqual([
        expect.objectContaining({ name: 'fixture', enabled: true, tools: 1 }),
      ])
    } finally {
      await runtime.close()
    }
    // Whatever the warm wrote is a listing the next run reads, not state it needs.
    const cached = JSON.parse(readFileSync(mcpCacheFile(), 'utf8')) as { servers: Record<string, unknown> }
    expect(cached.servers).toHaveProperty('fixture')
  })
})
