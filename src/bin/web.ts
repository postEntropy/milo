#!/usr/bin/env node
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { createRuntime } from '../core/bootstrap.js'
import { loadConfig } from '../core/config/load.js'
import { MILO_HOME } from '../core/config/paths.js'
import { startWebServer } from '../gateways/web/http.js'
import { errorMessage } from '../util/errors.js'

interface Options {
  host: string
  port: number
  open: boolean
}

export async function runWeb(args = process.argv.slice(2)): Promise<void> {
  const options = parseOptions(args)
  const loaded = loadConfig()
  if (!loaded) throw new Error('No configuration found. Run `milo` first to set things up.')
  const runtime = createRuntime(loaded, process.cwd())
  let web: Awaited<ReturnType<typeof startWebServer>>
  try {
    web = await startWebServer({ runtime, cwd: process.cwd(), host: options.host, port: options.port, identity: { provider: loaded.provider.id, model: loaded.model } })
  } catch (error) {
    await runtime.close()
    throw error
  }

  console.error(`Milo web · ${loaded.model} (${loaded.provider.id}) · mode ${runtime.permissions?.mode ?? 'ask'} · effort ${runtime.reasoningEffort} · ${runtime.skills.length} skills · browser ${runtime.browser ? 'on' : 'off'} · ${MILO_HOME}`)
  console.error(`Open ${web.url}`)
  if (options.open) void openBrowser(web.url)

  let closing = false
  const close = async (): Promise<void> => {
    if (closing) return
    closing = true
    await web.stop().catch(() => undefined)
    await runtime.close().catch(() => undefined)
  }
  process.once('SIGINT', () => { void close().finally(() => process.exit(0)) })
  process.once('SIGTERM', () => { void close().finally(() => process.exit(0)) })
}

function parseOptions(args: string[]): Options {
  const options: Options = { host: '127.0.0.1', port: 7717, open: true }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--no-open') options.open = false
    else if (arg === '--host') options.host = args[++index] ?? ''
    else if (arg === '--port') options.port = Number(args[++index])
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: milo-web [--host 127.0.0.1] [--port 7717] [--no-open]')
      process.exit(0)
    } else throw new Error(`Unknown option: ${arg}`)
  }
  if (!options.host || !Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error('Host must be non-empty and port must be between 0 and 65535.')
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
