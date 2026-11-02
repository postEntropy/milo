#!/usr/bin/env node
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { createRuntime } from '../core/bootstrap.js'
import { DEFAULT_WORKING_DIRECTORY } from '../core/config/paths.js'
import { loadConfig, readAuth, resolveGatewayToken } from '../core/config/load.js'
import { MILO_HOME } from '../core/config/paths.js'
import { bindProblem, startWebServer, webReachLines } from '../gateways/web/http.js'
import { errorMessage } from '../util/errors.js'
import { hyperlink } from '../util/terminal.js'

interface Options {
  host?: string
  port?: number
  open: boolean
}

export async function runWeb(args = process.argv.slice(2)): Promise<void> {
  const options = parseOptions(args)
  const loaded = loadConfig()
  if (!loaded) throw new Error('No configuration found. Run `milo` first to set things up.')
  // Where the config puts it, unless a flag overrode it for this run.
  const host = options.host ?? loaded.config.web.host
  const port = options.port ?? loaded.config.web.port
  if (!host || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('Host must be non-empty and port must be between 0 and 65535.')
  }
  const runtime = createRuntime(loaded, DEFAULT_WORKING_DIRECTORY)
  let web: Awaited<ReturnType<typeof startWebServer>>
  try {
    web = await startWebServer({
      runtime,
      cwd: DEFAULT_WORKING_DIRECTORY,
      host,
      port,
      // Stored once (`auth.json` → `gateways.web`, or MILO_WEB_TOKEN), the URL
      // outlives the process; without one it is minted per run.
      token: resolveGatewayToken('web', readAuth()),
    })
  } catch (error) {
    await runtime.close()
    // Said in terms of what to change, since this is all the person gets to see.
    throw new Error(bindProblem(error, host, port))
  }

  console.error(`Milo web · ${loaded.model} (${loaded.provider.id}) · mode ${runtime.permissions?.mode ?? 'ask'} · effort ${runtime.reasoningEffort} · ${runtime.skills.length} skills · browser ${runtime.browser ? 'on' : 'off'} · ${MILO_HOME}`)
  console.error(`Open ${hyperlink(web.url)}`)
  for (const line of webReachLines(host, web.urls)) console.error(line)
  if (options.open) void openBrowser(web.url)

  let closing = false
  const close = async (): Promise<void> => {
    // A second Ctrl+C is the person insisting: go now.
    if (closing) process.exit(0)
    closing = true
    await web.stop().catch(() => undefined)
    await runtime.close().catch(() => undefined)
    process.exit(0)
  }
  process.on('SIGINT', () => void close())
  process.on('SIGTERM', () => void close())
}

function parseOptions(args: string[]): Options {
  const options: Options = { open: true }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--no-open') options.open = false
    else if (arg === '--host') options.host = args[++index] ?? ''
    else if (arg === '--port') options.port = Number(args[++index])
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: milo web [--host <addr>] [--port <n>] [--no-open]')
      console.log('Defaults come from the `web` section of ~/.milo/config.yml (127.0.0.1:7717).')
      process.exit(0)
    } else throw new Error(`Unknown option: ${arg}`)
  }
  return options
}

async function openBrowser(url: string): Promise<void> {
  const commands = process.platform === 'darwin'
    ? ['open', [url]] as const
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]] as const
      : ['xdg-open', [url]] as const
  const { spawn } = await import('node:child_process')
  const child = spawn(commands[0], [...commands[1]], { stdio: 'ignore', detached: true })
  child.on('error', () => undefined)
  child.unref()
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runWeb().catch((error: unknown) => {
    console.error(errorMessage(error))
    process.exitCode = 1
  })
}
