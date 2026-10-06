import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// Point the install somewhere throwaway *before* the path module is loaded.
const home = mkdtempSync(path.join(tmpdir(), 'milo-mcp-cli-'))
process.env.MILO_HOME = home

const { runMcp } = await import('../src/bin/mcp.js')
const { mcpFile } = await import('../src/core/config/paths.js')

const fixture = path.join(process.cwd(), 'test', 'fixtures', 'mcp-server.mjs')

interface Ran {
  lines: string[]
  errors: string[]
  code: number
}

async function run(...args: string[]): Promise<Ran> {
  const lines: string[] = []
  const errors: string[] = []
  const code = await runMcp(['mcp', ...args], {
    out: (line) => lines.push(line),
    err: (line) => errors.push(line),
    cwd: process.cwd(),
  })
  return { lines, errors, code }
}

const server = (env: Record<string, string> = {}, extra: Record<string, unknown> = {}) => ({
  command: process.execPath,
  args: [fixture],
  env,
  ...extra,
})

afterEach(() => {
  rmSync(mcpFile(), { force: true })
})

describe('milo mcp', () => {
  it('reports a server the catalog has no listing for yet', async () => {
    writeFileSync(mcpFile(), JSON.stringify({ servers: { github: { command: 'npx', args: ['-y', 'server-github'] } } }))
    const { lines, code } = await run()
    expect(code).toBe(0)
    expect(lines[0]).toContain('github')
    expect(lines.join('\n')).toContain('no listing yet')
    expect(lines.join('\n')).toContain('npx -y server-github')
  })

  it('says a server is off rather than counting tools for it', async () => {
    writeFileSync(mcpFile(), JSON.stringify({ servers: { notes: { command: 'node', enabled: false } } }))
    const { lines } = await run()
    expect(lines[0]).toBe('off  notes')
  })

  it('prints no servers, and where one would go', async () => {
    const { lines } = await run()
    expect(lines[0]).toBe('No MCP servers.')
    expect(lines[1]).toContain(mcpFile())
  })

  it('connects on check and names every tool it found', async () => {
    writeFileSync(mcpFile(), JSON.stringify({ servers: { fixture: server() } }))
    const { lines, code } = await run('check')
    expect(code).toBe(0)
    expect(lines[0]).toContain('up   fixture')
    expect(lines.join('\n')).toContain('fixture.echo — Echo the arguments back.')
  })

  it('answers a failure with the server’s own reason, and a non-zero code', async () => {
    writeFileSync(mcpFile(), JSON.stringify({ servers: { fixture: { command: 'milo-no-such-mcp-server' } } }))
    const { lines, code } = await run('check')
    expect(code).toBe(1)
    expect(lines.join('\n')).toContain('could not start "milo-no-such-mcp-server"')
    expect(lines.join('\n')).toContain('could not be reached')
  })

  it('turns a server off in the file, and off in what it reports', async () => {
    writeFileSync(mcpFile(), JSON.stringify({ servers: { fixture: server() } }))
    const { lines, code } = await run('disable', 'fixture')
    expect(code).toBe(0)
    expect(lines[0]).toBe('Disabled fixture.')
    expect(lines[1]).toBe('off  fixture')
    const written = JSON.parse(readFileSync(mcpFile(), 'utf8')) as {
      servers: Record<string, { enabled: boolean }>
    }
    expect(written.servers.fixture?.enabled).toBe(false)
  })

  it('answers a verb it does not know with the ones it does', async () => {
    const { errors, code } = await run('ping')
    expect(code).toBe(1)
    expect(errors.join('\n')).toContain('Unknown mcp command "ping"')
    expect(errors.join('\n')).toContain('Usage:')
  })

  it('reports a config it cannot read instead of a list', async () => {
    writeFileSync(mcpFile(), JSON.stringify({ servers: { github: { command: 'npx', comand: 'typo' } } }))
    const { errors, code } = await run()
    expect(code).toBe(1)
    expect(errors.join('\n')).toContain('has no field named "comand"')
  })

  it('names the server a check could not find', async () => {
    writeFileSync(mcpFile(), JSON.stringify({ servers: { github: { command: 'npx' } } }))
    const { errors, code } = await run('check', 'gitlab')
    expect(code).toBe(1)
    expect(errors.join('\n')).toContain('no server named "gitlab"')
  })
})
