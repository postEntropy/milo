import process from 'node:process'
import { createRuntime } from '../core/bootstrap.js'
import { loadConfig, readAuth, resolveGatewayToken } from '../core/config/load.js'
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
  console.error(`Milo serving: ${gateways.map((gateway) => gateway.id).join(', ')}`)

  const shutdown = async (): Promise<void> => {
    for (const gateway of gateways) {
      await gateway.stop().catch(() => undefined)
    }
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}
