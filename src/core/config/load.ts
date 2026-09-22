import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { DEFAULT_SEARCH_KEY_ENV } from '../search/types.js'
import type { PermissionMode } from '../tools/permission.js'
import { MILO_HOME, authFile, configFile } from './paths.js'
import {
  AuthSchema,
  ConfigSchema,
  DEFAULT_DISPLAY,
  emptyAuth,
  type Auth,
  type Config,
  type DisplayConfig,
  type ProviderEntry,
} from './schema.js'

const PROVIDER_ENV: Record<string, string[]> = {
  commandcode: ['COMMANDCODE_API_KEY', 'CMD_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
}

const GATEWAY_ENV: Record<string, string> = {
  telegram: 'TELEGRAM_BOT_TOKEN',
  discord: 'DISCORD_BOT_TOKEN',
}

export interface ResolvedProvider {
  id: string
  name?: string
  baseURL: string
  apiKey?: string | false
  wire?: 'openai' | 'anthropic' | 'auto'
  headers?: Record<string, string>
}

export interface LoadedConfig {
  config: Config
  provider: ResolvedProvider
  model: string
}

export function configExists(): boolean {
  return existsSync(configFile())
}

export function readConfig(): Config | null {
  if (!existsSync(configFile())) return null
  const parsed = JSON.parse(readFileSync(configFile(), 'utf8'))
  return ConfigSchema.parse(parsed)
}

export function saveConfig(config: Config): void {
  mkdirSync(MILO_HOME, { recursive: true })
  writeFileSync(configFile(), `${JSON.stringify(config, null, 2)}\n`)
}

export function readAuth(): Auth {
  if (!existsSync(authFile())) return emptyAuth()
  try {
    return AuthSchema.parse(JSON.parse(readFileSync(authFile(), 'utf8')))
  } catch {
    return emptyAuth()
  }
}

export function saveAuth(auth: Auth): void {
  mkdirSync(MILO_HOME, { recursive: true })
  writeFileSync(authFile(), `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 })
  try {
    chmodSync(authFile(), 0o600)
  } catch {
    // best effort on platforms without chmod
  }
}

/**
 * The config as it is on disk, or null when it is missing or unreadable. The
 * readers that only want one setting use this: a corrupt file should not turn
 * `/mode` or `/tools` into an error in the middle of a conversation.
 */
function readConfigOrNull(): Config | null {
  try {
    return readConfig()
  } catch {
    return null
  }
}

/**
 * Writes the permission mode to disk. Without this a `/mode` set from a chat
 * lives only in the running process and dies with it.
 */
export function setPermissionMode(mode: PermissionMode): void {
  const config = readConfigOrNull()
  if (!config) return
  saveConfig({ ...config, permissions: { ...config.permissions, mode } })
}

/** Applies a display change and writes it down, for the same reason as `/mode`. */
export function setDisplay(patch: Partial<DisplayConfig>): void {
  const config = readConfigOrNull()
  if (!config) return
  saveConfig({ ...config, display: { ...config.display, ...patch } })
}

/**
 * The display settings as they are on disk. Read per turn by the bot gateways,
 * so a `/tools` typed in a chat takes effect without restarting `milo serve`.
 * A corrupt file falls back to the defaults rather than failing the turn.
 */
export function readDisplay(): DisplayConfig {
  return readConfigOrNull()?.display ?? DEFAULT_DISPLAY
}

export function resolveApiKey(id: string, entry: ProviderEntry, auth: Auth): string | false | undefined {
  const envNames = [entry.keyEnv, ...(PROVIDER_ENV[id] ?? [])].filter(
    (name): name is string => Boolean(name),
  )
  for (const name of envNames) {
    const value = process.env[name]
    if (value && value.trim()) return value.trim()
  }
  const stored = auth.providers[id]
  if (stored && stored.trim()) return stored.trim()
  if (entry.keyless) return false
  return undefined
}

export function resolveGatewayToken(id: string, auth: Auth): string | undefined {
  const envName = GATEWAY_ENV[id]
  if (envName && process.env[envName]?.trim()) return process.env[envName]!.trim()
  const stored = auth.gateways[id]
  if (stored && stored.trim()) return stored.trim()
  return undefined
}

export function resolveSearchKey(
  search: { provider: 'tavily' | 'exa' | 'parallel'; keyEnv?: string } | undefined,
  auth: Auth,
): string | undefined {
  if (!search) return undefined
  const envName = search.keyEnv ?? DEFAULT_SEARCH_KEY_ENV[search.provider]
  const fromEnv = process.env[envName]
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()
  const stored = auth.search[search.provider]
  if (stored && stored.trim()) return stored.trim()
  return undefined
}

export function loadConfig(): LoadedConfig | null {
  const config = readConfig()
  if (!config) return null

  const entry = config.providers[config.provider]
  if (!entry) {
    throw new Error(`Provider "${config.provider}" is not configured in ${configFile()}`)
  }

  const auth = readAuth()
  return {
    config,
    model: config.model,
    provider: {
      id: config.provider,
      name: entry.name,
      baseURL: entry.baseURL,
      wire: entry.wire,
      headers: entry.headers,
      apiKey: resolveApiKey(config.provider, entry, auth),
    },
  }
}
