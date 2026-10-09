import process from 'node:process'
import { createRuntime } from '../core/bootstrap.js'
import { DEFAULT_WORKING_DIRECTORY } from '../core/config/paths.js'
import { loadConfig, readAuth, resolveGatewayToken } from '../core/config/load.js'
import { MILO_HOME } from '../core/config/paths.js'
import { attachJobNotifier } from '../core/jobs/index.js'
import type { OutgoingMessage } from '../core/outgoing.js'
import { readRoutines, RoutineScheduler } from '../core/routines.js'
import type { Gateway } from './types.js'

export interface ServeOptions {
  /** Starts the bot gateways without the web UI. */
  noWeb?: boolean
  /** The port the web UI listens on; 7717 unless changed. */
  webPort?: number
}

export async function runServe(options: ServeOptions = {}): Promise<void> {
  const loaded = loadConfig()
  if (!loaded) {
    console.error('No configuration found. Run `milo` first to set things up.')
    process.exitCode = 1
    return
  }

  const runtime = createRuntime(loaded, DEFAULT_WORKING_DIRECTORY)
  const auth = readAuth()
  const gateways: Gateway[] = []
  const config = loaded.config.gateways

  if (config.telegram?.enabled) {
    const token = resolveGatewayToken('telegram', auth)
    if (!token) {
      console.error('Telegram is enabled but no token was found (TELEGRAM_BOT_TOKEN).')
    } else {
      const { TelegramGateway } = await import('./telegram/index.js')
      gateways.push(
        new TelegramGateway({ runtime, token, allowlist: config.telegram?.allowlist }),
      )
    }
  }

  if (config.discord?.enabled) {
    const token = resolveGatewayToken('discord', auth)
    if (!token) {
      console.error('Discord is enabled but no token was found (DISCORD_BOT_TOKEN).')
    } else {
      const { DiscordGateway } = await import('./discord/index.js')
      gateways.push(new DiscordGateway({ runtime, token, allowlist: config.discord?.allowlist }))
    }
  }

  // The web UI rides along with the daemon rather than being a process of its
  // own: it is the surface the same install is already serving, and a routine
  // can deliver into a web chat only while something is there to hand it to.
  // Off only when the config says so or `--no-web` was passed; the port the flag
  // names wins over the one the config holds.
  const web = loaded.config.web
  /** Kept so the scheduler can tell an open Routines screen that a run happened. */
  let webUi: { routinesChanged(): void; showNotice(conversationId: string, message: OutgoingMessage): void } | undefined
  if (!options.noWeb && web.enabled) {
    const { WebGateway } = await import('./web/gateway.js')
    const gateway = new WebGateway({
      runtime,
      cwd: DEFAULT_WORKING_DIRECTORY,
      host: web.host,
      port: options.webPort ?? web.port,
      // A stored token (`auth.json` → `gateways.web`, or MILO_WEB_TOKEN) is
      // what makes the URL survive a restart; with neither, the server mints a
      // fresh one per run — the old behaviour, and still the default.
      token: resolveGatewayToken('web', auth),
    })
    webUi = gateway
    gateways.push(gateway)
  }

  if (gateways.length === 0) {
    console.error(
      'No gateways enabled. Enable them in ~/.milo/config.yml, e.g.\n' +
        '  "gateways": { "telegram": { "enabled": true } }\n' +
        'or leave the web UI on (that is the default) and open the URL it prints.',
    )
    process.exitCode = 1
    return
  }

  for (const gateway of gateways) await gateway.start()

  // A finished background job speaks up: a short turn on the conversation that
  // started it, then a message shown wherever that conversation is. The web has
  // its own path — the announcement is already in the conversation's transcript,
  // so it is shown to whoever is watching, not written a second time.
  const detachJobs = attachJobNotifier(runtime, async (job, message) => {
    const outgoing: OutgoingMessage = {
      text: message.text,
      ...(message.files.length > 0 ? { files: message.files } : {}),
    }
    if (job.origin.gateway === 'web') {
      webUi?.showNotice(job.origin.conversationId, outgoing)
      return
    }
    const gateway = gateways.find((candidate) => candidate.id === job.origin.gateway)
    if (!gateway?.deliver) throw new Error(`no ${job.origin.gateway} surface to deliver to`)
    await gateway.deliver(job.origin.conversationId, outgoing)
  })

  // The prompts that run on a timer. It shares this runtime, so a routine's turn
  // has the same memory, sessions and history as any other — and it delivers
  // through the gateways already running, which is the only reason a routine
  // needs one.
  const scheduler = new RoutineScheduler({
    runtime,
    deliver: async (routine, message) => {
      // A routine that delivers nowhere never reaches here; the guard keeps the
      // type honest, so the conversation is read only from a real destination.
      if (routine.target.gateway === 'none') return
      const gateway = gateways.find((candidate) => candidate.id === routine.target.gateway)
      if (!gateway?.deliver) throw new Error(`no ${routine.target.gateway} surface to deliver to`)
      await gateway.deliver(routine.target.conversationId, message)
    },
    // The scheduler runs in this process, so a page showing the run history is
    // told at once rather than left to poll for it.
    onRan: () => webUi?.routinesChanged(),
    log: (line) => console.error(line),
  })
  scheduler.start()
  const routines = readRoutines().filter((routine) => routine.enabled).length

  console.error(`Milo serving: ${gateways.map((gateway) => gateway.id).join(', ')}`)
  // One line at the boundary, not one per turn: a daemon that logs every turn is
  // noise, and the turns are the users', not the operator's. The skill count is
  // here because it is otherwise invisible — the index is built once at startup,
  // so "is it reading my skills?" is a question only this line can answer.
  console.error(
    [
      `${loaded.model} (${loaded.provider.id})`,
      `mode ${runtime.permissions?.mode ?? 'ask'}`,
      `effort ${runtime.reasoningEffort}`,
      `${runtime.skills.length} skill${runtime.skills.length === 1 ? '' : 's'}`,
      `${routines} routine${routines === 1 ? '' : 's'}`,
      // A capability that only exists in the catalog is invisible in a daemon:
      // the TUI header is not there to show it, so the boot line says it.
      runtime.browser ? `browser ${loaded.config.browser.headless ? 'headless' : 'visible'}` : 'browser off',
      MILO_HOME,
    ].join(' · '),
  )

  let shuttingDown = false

  /** Lets go of everything this run holds. The port is free once it returns. */
  const stop = async (): Promise<void> => {
    scheduler.stop()
    detachJobs()
    for (const gateway of gateways) {
      await gateway.stop().catch(() => undefined)
    }
    // Whatever the runtime still owns goes with it — the recaps in flight.
    await runtime.close().catch(() => undefined)
  }

  const shutdown = async (): Promise<void> => {
    // A second Ctrl+C is the person insisting: stop waiting for a clean exit.
    if (shuttingDown) process.exit(0)
    shuttingDown = true
    await stop()
    process.exit(0)
  }

  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}
