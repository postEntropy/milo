import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Point the install somewhere throwaway *before* the path module is loaded.
const home = mkdtempSync(path.join(tmpdir(), 'milo-mcp-'))
process.env.MILO_HOME = home

const {
  assertComplete,
  CLIENT_INFO,
  encodeMessage,
  MODERN_PROTOCOL_VERSION,
  modernMeta,
  parseMessage,
} = await import('../src/core/mcp/protocol.js')
const { readMcpConfig, resolveMcpEnv, setMcpServerEnabled } = await import('../src/core/mcp/config.js')
const { readMcpCache, writeMcpCache } = await import('../src/core/mcp/cache.js')
const { createMcpTools, mcpToolName, mcpToolResult } = await import('../src/core/mcp/tools.js')
const { ToolRegistry } = await import('../src/core/tools/registry.js')
const { DefaultPermissionPolicy } = await import('../src/core/tools/permission.js')
const { mcpCacheFile, mcpFile } = await import('../src/core/config/paths.js')

const pkg = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as { version: string }

function writeMcpJson(value: unknown): void {
  writeFileSync(mcpFile(), JSON.stringify(value, null, 2))
}

const echoDefinition = {
  name: 'echo',
  description: 'Echo the arguments back.',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
}

describe('the MCP wire', () => {
  it('frames one message per line and reads it back', () => {
    const line = encodeMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(line.endsWith('\n')).toBe(true)
    expect(line.split('\n').filter(Boolean)).toHaveLength(1)
    expect(parseMessage(line)).toEqual({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  })

  it('ignores a line that is not a message instead of failing the stream', () => {
    expect(parseMessage('npm notice New major version of npm available!')).toBeNull()
    expect(parseMessage('')).toBeNull()
    expect(parseMessage('{"jsonrpc":"2.0"')).toBeNull()
  })

  it('tells a response, a notification and a server request apart', () => {
    expect(parseMessage('{"jsonrpc":"2.0","id":2,"result":{}}')).toMatchObject({ id: 2 })
    expect(parseMessage('{"jsonrpc":"2.0","method":"notifications/progress"}')).toMatchObject({
      method: 'notifications/progress',
    })
    expect(parseMessage('{"jsonrpc":"2.0","id":9,"method":"roots/list"}')).toMatchObject({
      id: 9,
      method: 'roots/list',
    })
  })

  it('carries the version, the client and its capabilities on every modern request', () => {
    const meta = modernMeta({ roots: {} })
    expect(meta['io.modelcontextprotocol/protocolVersion']).toBe(MODERN_PROTOCOL_VERSION)
    expect(meta['io.modelcontextprotocol/clientInfo']).toEqual({ ...CLIENT_INFO })
    expect(meta['io.modelcontextprotocol/clientCapabilities']).toEqual({ roots: {} })
  })

  it('names the client version the package ships', () => {
    expect(CLIENT_INFO.version).toBe(pkg.version)
  })

  it('refuses a result whose own type says it is not finished', () => {
    expect(() => assertComplete({ resultType: 'input_required' }, 'tools/call')).toThrow(/asked for input/)
    expect(() => assertComplete({ resultType: 'something-new' }, 'tools/call')).toThrow(/does not understand/)
    expect(() => assertComplete({ resultType: 'complete' }, 'tools/call')).not.toThrow()
    // Legacy servers omit the field, which is the compatible reading.
    expect(() => assertComplete({ tools: [] }, 'tools/list')).not.toThrow()
  })
})

describe('mcp.json', () => {
  it('reads a server with the defaults filled in', () => {
    writeMcpJson({ servers: { github: { command: 'npx', args: ['-y', 'server-github'] } } })
    const config = readMcpConfig()
    expect(config.servers.github).toMatchObject({
      command: 'npx',
      args: ['-y', 'server-github'],
      enabled: true,
      readOnly: [],
      env: {},
    })
  })

  it('answers a misspelled field with the ones that exist', () => {
    writeMcpJson({ servers: { github: { command: 'npx', comand: 'typo' } } })
    expect(() => readMcpConfig()).toThrow(/has no field named "comand"/)
  })

  it('refuses a server name a tool could not carry', () => {
    writeMcpJson({ servers: { 'GitHub Server': { command: 'npx' } } })
    expect(() => readMcpConfig()).toThrow(/not a valid server name/)
  })

  it('refuses a double underscore, which would make the tool name ambiguous to read back', () => {
    writeMcpJson({ servers: { git__lab: { command: 'npx' } } })
    expect(() => readMcpConfig()).toThrow(/not a valid server name/)
  })

  it('is no servers at all when the file is not there', () => {
    rmSync(mcpFile(), { force: true })
    expect(readMcpConfig().servers).toEqual({})
  })

  it('resolves a named variable, and says which one is missing', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal is the point — this is the `${VAR}` a config file holds
    const server = { command: 'npx', args: [], env: { TOKEN: '${MILO_MCP_TEST_TOKEN}' }, enabled: true, readOnly: [], timeoutMs: 1000 }
    process.env.MILO_MCP_TEST_TOKEN = 'secret'
    expect(resolveMcpEnv(server, 'github')).toEqual({ TOKEN: 'secret' })
    delete process.env.MILO_MCP_TEST_TOKEN
    expect(() => resolveMcpEnv(server, 'github')).toThrow(/servers\.github\.env\.TOKEN names \$\{MILO_MCP_TEST_TOKEN\}/)
  })

  it('turns one server off in the file without touching the rest', async () => {
    writeMcpJson({ servers: { github: { command: 'npx' }, notes: { command: 'node', args: ['notes.js'] } } })
    await setMcpServerEnabled('github', false)
    const written = JSON.parse(readFileSync(mcpFile(), 'utf8')) as {
      servers: Record<string, { enabled: boolean; command: string }>
    }
    expect(written.servers.github).toMatchObject({ enabled: false, command: 'npx' })
    expect(written.servers.notes.command).toBe('node')
  })

  it('names an unreadable file instead of throwing a raw parse error', async () => {
    writeFileSync(mcpFile(), '{ not json')
    await expect(setMcpServerEnabled('github', false)).rejects.toThrow(/is not valid JSON/)
  })
})

describe('the listing cache', () => {
  it('reads back what a server said its tools were', async () => {
    await writeMcpCache({
      servers: { github: { era: 'modern', version: MODERN_PROTOCOL_VERSION, tools: [echoDefinition], at: 1_700_000_000_000 } },
    })
    expect(readMcpCache().servers.github?.tools).toEqual([echoDefinition])
    expect(readMcpCache().servers.github?.era).toBe('modern')
  })

  it('is empty rather than fatal when the file is corrupt', () => {
    writeFileSync(mcpCacheFile(), '{ not json')
    expect(readMcpCache().servers).toEqual({})
  })
})

describe('a server tool as a Milo tool', () => {
  const build = (readOnly: string[] = [], used?: Set<string>) =>
    createMcpTools({ server: 'github', readOnly }, [echoDefinition], async () => ({}), used)

  it('prefixes the server name onto the tool name', () => {
    expect(build()[0]?.name).toBe('mcp__github__echo')
    expect(mcpToolName('github', 'echo')).toBe('mcp__github__echo')
  })

  it('sends the server’s own schema instead of one derived from Milo’s gate', () => {
    expect(build()[0]?.parameters).toEqual(echoDefinition.inputSchema)
  })

  it('asks unless the person declared the tool read-only', async () => {
    const policy = new DefaultPermissionPolicy({ mode: 'ask' })
    expect(await policy.decide(build()[0]!, {})).toBe('ask')
    expect(await policy.decide(build(['echo'])[0]!, {})).toBe('allow')
  })

  it('says where the tool came from and how to read what it answers', () => {
    const description = build()[0]?.description ?? ''
    expect(description).toContain('Echo the arguments back.')
    expect(description).toContain('external "github" MCP server')
    expect(description).toContain('untrusted data')
  })

  it('gives two tools of the same name different wire names', () => {
    const used = new Set<string>()
    const first = createMcpTools({ server: 'a', readOnly: [] }, [echoDefinition], async () => ({}), used)
    const second = createMcpTools({ server: 'a', readOnly: [] }, [echoDefinition], async () => ({}), used)
    expect(first[0]?.name).toBe('mcp__a__echo')
    expect(second[0]?.name).toBe('mcp__a__echo_2')
  })

  it('keeps a foreign schema verbatim in what the wire is sent', () => {
    const registry = new ToolRegistry(createMcpTools({ server: 'github', readOnly: [] }, [echoDefinition], async () => ({})))
    expect(registry.specs()[0]?.parameters).toEqual(echoDefinition.inputSchema)
  })

  it('takes a tool back out when the server stops offering it', () => {
    const registry = new ToolRegistry(createMcpTools({ server: 'github', readOnly: [] }, [echoDefinition], async () => ({})))
    registry.unregister('mcp__github__echo')
    expect(registry.has('mcp__github__echo')).toBe(false)
  })
})

describe('what a tool call answered', () => {
  it('carries the text through', () => {
    const result = mcpToolResult('github', 'echo', { content: [{ type: 'text', text: 'hello' }] })
    expect(result.content).toBe('hello')
    expect(result.isError).toBeUndefined()
  })

  it('reports a failure the server flagged', () => {
    const result = mcpToolResult('github', 'boom', { content: [{ type: 'text', text: 'no' }], isError: true })
    expect(result.isError).toBe(true)
  })

  it('shows a png the wires can carry and names the ones they cannot', () => {
    const result = mcpToolResult('github', 'picture', {
      content: [
        { type: 'image', mimeType: 'image/png', data: 'aGk=' },
        { type: 'image', mimeType: 'image/webp', data: 'aGk=' },
      ],
    })
    expect(result.images).toEqual([{ mimeType: 'image/png', data: 'aGk=' }])
    expect(result.content).toMatch(/image\/webp/)
  })

  it('names every content type it cannot show instead of dropping it', () => {
    const content = mcpToolResult('github', 'picture', {
      content: [
        { type: 'audio', mimeType: 'audio/wav' },
        { type: 'resource_link', uri: 'file:///a.rs', name: 'a.rs' },
        { type: 'resource', resource: { uri: 'file:///b.rs', text: 'fn main() {}' } },
        { type: 'mystery' },
      ],
    }).content
    expect(content).toMatch(/audio the server sent as audio\/wav/)
    expect(content).toMatch(/a link the server offered: a\.rs — file:\/\/\/a\.rs/)
    expect(content).toMatch(/Resource file:\/\/\/b\.rs:\nfn main\(\) \{\}/)
    expect(content).toMatch(/mystery content/)
  })

  it('carries structured content when there is no text saying the same thing', () => {
    expect(mcpToolResult('github', 'structured', { structuredContent: { answer: 42 }, content: [] }).content).toBe(
      '{\n  "answer": 42\n}',
    )
  })

  it('says so when the server answered nothing', () => {
    expect(mcpToolResult('github', 'echo', { content: [] }).content).toMatch(/returned no content/)
  })
})
