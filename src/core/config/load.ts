import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { errorMessage } from '../../util/errors.js'
import { logWarn } from '../../util/log.js'
import { DEFAULT_SEARCH_KEY_ENV } from '../search/types.js'
import type { ReasoningEffort } from '../providers/types.js'
import type { PermissionMode } from '../tools/permission.js'
import { MILO_HOME, authFile, configFile } from './paths.js'
import { findPreset } from './presets.js'
import { applyConfig, readDocument, renderDocument } from './document.js'
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
  opencode: ['OPENCODE_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
}

const GATEWAY_ENV: Record<string, string> = {
  telegram: 'TELEGRAM_BOT_TOKEN',
  discord: 'DISCORD_BOT_TOKEN',
  // Not a chat bot, but the same shape: the string the surface authenticates
  // with. Unlike the two above, its absence is not a misconfiguration — the web
  // server mints a fresh token per run instead.
  web: 'MILO_WEB_TOKEN',
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
  const doc = readDocument()
  // The same contract `JSON.parse` had: a file that cannot be read is reported
  // rather than half-read, and the defensive readers catch it and keep going.
  if (doc.errors.length > 0) throw doc.errors[0]
  return ConfigSchema.parse(doc.toJS())
}

export function saveConfig(config: Config): void {
  mkdirSync(MILO_HOME, { recursive: true })
  // Read, edit, write — rather than serialize the object over the file — so the
  // comments the file carries, ours and anyone else's, survive the write.
  const doc = readDocument()
  applyConfig(doc, config)
  writeFileSync(configFile(), renderDocument(doc))
}

export function readAuth(): Auth {
  if (!existsSync(authFile())) return emptyAuth()
  try {
    return AuthSchema.parse(JSON.parse(readFileSync(authFile(), 'utf8')))
  } catch (error) {
    logWarn(`could not read ${authFile()} (starting with no keys): ${errorMessage(error)}`)
    return emptyAuth()
  }
}

/**
 * `auth.json` stays JSON, and stays a whole-file rewrite: it holds secrets, it is
 * written only by Milo, and nobody has a reason to annotate it — which is the
 * entire case for YAML next door.
 */
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
  } catch (error) {
    logWarn(`could not read ${configFile()}: ${errorMessage(error)}`)
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

/** Writes down how hard the model should think. */
export function setReasoningEffort(effort: ReasoningEffort): void {
  const config = readConfigOrNull()
  if (!config) return
  saveConfig({ ...config, reasoningEffort: effort })
}

/** Writes down the model, so a switch made in a chat outlives the process. */
export function setModel(model: string): void {
  const config = readConfigOrNull()
  if (!config) return
  saveConfig({ ...config, model })
}

/**
 * Writes down the provider and its model together, so a switch made in a chat
 * outlives the process. The two travel as a pair: a model id belongs to the
 * provider that serves it, so persisting one without the other would leave the
 * file inconsistent.
 */
export function setProvider(id: string, model: string): void {
  const config = readConfigOrNull()
  if (!config) return
  saveConfig({ ...config, provider: id, model })
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
    if (value?.trim()) return value.trim()
  }
  const stored = auth.providers[id]
  if (stored?.trim()) return stored.trim()
  if (entry.keyless) return false
  return undefined
}

export function resolveGatewayToken(id: string, auth: Auth): string | undefined {
  const envName = GATEWAY_ENV[id]
  if (envName && process.env[envName]?.trim()) return process.env[envName]!.trim()
  const stored = auth.gateways[id]
  if (stored?.trim()) return stored.trim()
  return undefined
}

export function resolveSearchKey(
  search: { provider: 'tavily' | 'exa' | 'parallel'; keyEnv?: string } | undefined,
  auth: Auth,
): string | undefined {
  if (!search) return undefined
  const envName = search.keyEnv ?? DEFAULT_SEARCH_KEY_ENV[search.provider]
  const fromEnv = process.env[envName]
  if (fromEnv?.trim()) return fromEnv.trim()
  const stored = auth.search[search.provider]
  if (stored?.trim()) return stored.trim()
  return undefined
}

/**
 * A provider resolved from what is on disk: the config entry for `id` with the
 * key it needs. The same shape `loadConfig` builds for the active one, so a
 * surface that switches provider at runtime is handed exactly what a fresh start
 * would have given it. Undefined when the id is not configured.
 */
export function resolveProvider(config: Config, auth: Auth, id: string): ResolvedProvider | undefined {
  const entry = config.providers[id]
  if (!entry) return undefined
  return {
    id,
    name: entry.name,
    baseURL: entry.baseURL,
    wire: entry.wire,
    headers: entry.headers,
    apiKey: resolveApiKey(id, entry, auth),
  }
}

/**
 * The providers this install can actually talk through: the configured entries
 * whose key resolves, or that need none. Every surface that lets someone switch
 * provider draws its list from here, so they cannot disagree about what is
 * available or what it is called.
 */
export function listProviders(): { id: string; name: string }[] {
  const config = readConfigOrNull()
  if (!config) return []
  const auth = readAuth()
  return Object.entries(config.providers)
    .filter(([id, entry]) => resolveApiKey(id, entry, auth) !== undefined)
    .map(([id, entry]) => ({ id, name: entry.name ?? findPreset(id)?.name ?? id }))
}

export function loadConfig(): LoadedConfig | null {
  const config = readConfig()
  if (!config) return null

  const auth = readAuth()
  const provider = resolveProvider(config, auth, config.provider)
  if (!provider) {
    throw new Error(`Provider "${config.provider}" is not configured in ${configFile()}`)
  }

  return { config, model: config.model, provider }
}
