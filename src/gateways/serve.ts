import process from 'node:process'
import { createRuntime } from '../core/bootstrap.js'
import { loadConfig, readAuth, resolveGatewayToken } from '../core/config/load.js'
import { MILO_HOME } from '../core/config/paths.js'
import { readRoutines, RoutineScheduler } from '../core/routines.js'
import type { Gateway } from './types.js'

export async function runServe(): Promise<void> {
  const loaded = loadConfig()
  if (!loaded) {
    console.error('No configuration found. Run `milo` first to set things up.')
    process.exitCode = 1
    return
  }

  const runtime = createRuntime(loaded, process.cwd())
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

  if (gateways.length === 0) {
    console.error(
      'No gateways enabled. Enable them in ~/.milo/config.json, e.g.\n' +
        '  "gateways": { "telegram": { "enabled": true } }',
    )
    process.exitCode = 1
    return
  }

  for (const gateway of gateways) await gateway.start()

  // The prompts that run on a timer. It shares this runtime, so a routine's turn
  // has the same memory, sessions and history as any other — and it delivers
  // through the gateways already running, which is the only reason a routine
  // needs one.
  const scheduler = new RoutineScheduler({
    runtime,
    deliver: async (routine, text) => {
      const gateway = gateways.find((candidate) => candidate.id === routine.target.gateway)
      if (!gateway?.deliver) throw new Error(`no ${routine.target.gateway} surface to deliver to`)
      await gateway.deliver(routine.target.conversationId, text)
    },
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

  const shutdown = async (): Promise<void> => {
    scheduler.stop()
    for (const gateway of gateways) {
      await gateway.stop().catch(() => undefined)
    }
    // Whatever the runtime still owns goes with it — the recaps in flight.
    await runtime.close().catch(() => undefined)
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}
