import process from 'node:process'
import { mcpFile } from '../core/config/paths.js'
import { createMcpServers, type McpServerStatus } from '../core/mcp/servers.js'
import { errorMessage } from '../util/errors.js'
import { plural } from '../util/format.js'

export interface McpIo {
  out(line: string): void
  err(line: string): void
  cwd: string
}

const USAGE = [
  'Usage:',
  '  milo mcp                    the servers the file names, and what the catalog holds from each',
  '  milo mcp check [name]       connect now and list what a server offers',
  '  milo mcp enable <name>      put a server back in the catalog',
  '  milo mcp disable <name>     take it out, and stop its process',
  '',
  `Servers are written in ${mcpFile()} — a server is a command line, which a file says better than a form does.`,
].join('\n')

/**
 * `milo mcp`. A terminal command, not a screen: it prints and exits.
 *
 * `list` starts nothing — it reports the file and the cache, which is exactly
 * what the next Milo run will start with. `check` is the one verb that spawns
 * servers, and it is the place a failure is read in the server's own words.
 */
export async function runMcp(argv: string[], io: Partial<McpIo> = {}): Promise<number> {
  const out = io.out ?? ((line: string) => console.log(line))
  const err = io.err ?? ((line: string) => console.error(line))
  const cwd = io.cwd ?? process.cwd()

  const args = argv[0] === 'mcp' ? argv.slice(1) : argv
  const verb = args[0] ?? 'list'
  const manager = createMcpServers(cwd)
  const close = async (): Promise<void> => {
    await manager.close()
  }

  if (manager.configError) {
    err(manager.configError)
    await close()
    return 1
  }

  try {
    switch (verb) {
      case 'list':
        list(out, manager.status())
        return 0
      case 'check':
        return await check(out, manager, args[1])
      case 'enable':
      case 'disable': {
        const name = args[1]
        if (!name) {
          err(`Which server? ${verb} needs a name.\n${USAGE}`)
          return 1
        }
        await manager.setEnabled(name, verb === 'enable')
        out(`${verb === 'enable' ? 'Enabled' : 'Disabled'} ${name}.`)
        list(out, manager.status())
        return 0
      }
      default:
        // A word that is not a verb answers with the verbs, never a default.
        err(`Unknown mcp command "${verb}".\n${USAGE}`)
        return 1
    }
  } catch (error) {
    err(errorMessage(error))
    return 1
  } finally {
    await close()
  }
}

function list(out: (line: string) => void, servers: McpServerStatus[]): void {
  if (servers.length === 0) {
    out('No MCP servers.')
    out(`Add one in ${mcpFile()}.`)
    return
  }
  for (const server of servers) {
    if (!server.enabled) {
      out(`off  ${server.name}`)
    } else {
      const tools = plural(server.tools, 'tool')
      const listed = server.listingAt
        ? ` · listed ${new Date(server.listingAt).toISOString().slice(0, 16).replace('T', ' ')}`
        : ' · no listing yet — run `milo mcp check`'
      out(`on   ${server.name}  ${tools}${server.era ? ` · ${server.era}` : ''}${listed}`)
    }
    out(`     ${server.command}`)
    if (server.readOnly.length > 0) out(`     never asks: ${server.readOnly.join(', ')}`)
    if (server.error) out(`     ${server.error}`)
  }
}

async function check(
  out: (line: string) => void,
  manager: ReturnType<typeof createMcpServers>,
  only?: string,
): Promise<number> {
  const status = manager.status()
  if (status.length === 0) {
    out('No MCP servers.')
    return 0
  }
  const names = only ? [only] : status.map((server) => server.name)
  if (only && !status.some((server) => server.name === only)) {
    throw new Error(`mcp.json has no server named "${only}". It has: ${status.map((s) => s.name).join(', ')}.`)
  }
  let failed = 0
  const byName = new Map(status.map((server) => [server.name, server]))
  for (const name of names) {
    const server = byName.get(name)
    if (server && !server.enabled) {
      out(`off  ${name}  (disabled — \`milo mcp enable ${name}\`)`)
      continue
    }
    try {
      const tools = await manager.check(name)
      out(`up   ${name}  ${plural(tools.length, 'tool')}`)
      for (const tool of tools) {
        const first = tool.description?.split('\n')[0]?.trim()
        out(`     ${name}.${tool.name}${first ? ` — ${first}` : ''}`)
      }
    } catch (error) {
      failed += 1
      out(`down ${name}  ${errorMessage(error)}`)
    }
  }
  if (failed > 0) out(`${plural(failed, 'server')} could not be reached.`)
  return failed > 0 ? 1 : 0
}
