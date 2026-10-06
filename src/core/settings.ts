import { readAuth, readConfig, saveAuth, saveConfig } from './config/load.js'
import {
  ConfigSchema,
  type Auth,
  type ClassifierBackend,
  type ClassifierConfig,
  type Config,
  type PermissionsConfig,
} from './config/schema.js'
import type { ReasoningEffort } from './providers/types.js'
import { errorMessage } from '../util/errors.js'

export type SearchProvider = 'tavily' | 'exa' | 'parallel'
export type ToolDisplay = 'full' | 'name' | 'off'

export type SettingsResult<T = Config> =
  | { ok: true; value: T }
  | { ok: false; error: string }

export type SecretGroup = 'providers' | 'search' | 'gateways'

/**
 * Loads current configuration, applies mutations, validates with ConfigSchema,
 * and saves back to disk.
 */
export function mutateConfig(mutate: (current: Config) => void): SettingsResult<Config> {
  const current = readConfig()
  if (!current) return { ok: false, error: 'Milo is not configured.' }
  try {
    const next = structuredClone(current)
    mutate(next)
    const validated = ConfigSchema.parse(next)
    saveConfig(validated)
    return { ok: true, value: validated }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}

/**
 * Loads current auth, applies mutations, and saves back to disk.
 */
export function mutateAuth(mutate: (current: Auth) => void): SettingsResult<Auth> {
  try {
    const current = readAuth()
    mutate(current)
    saveAuth(current)
    return { ok: true, value: current }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}

export function setWebHost(host: string): SettingsResult<Config> {
  const trimmed = host.trim()
  if (!trimmed) return { ok: false, error: 'Host cannot be empty.' }
  return mutateConfig((config) => {
    config.web.host = trimmed
  })
}

export function setWebPort(port: number): SettingsResult<Config> {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return { ok: false, error: 'Port must be an integer between 0 and 65535.' }
  }
  return mutateConfig((config) => {
    config.web.port = port
  })
}

export function setWebEnabled(enabled: boolean): SettingsResult<Config> {
  return mutateConfig((config) => {
    config.web.enabled = enabled
  })
}

export function setBrowserField(
  field: 'chromePath' | 'profileDir' | 'cdpUrl',
  value: string | null,
): SettingsResult<Config> {
  const trimmed = typeof value === 'string' ? value.trim() || null : null
  return mutateConfig((config) => {
    config.browser[field] = trimmed
  })
}

export function setBrowserEnabled(enabled: boolean): SettingsResult<Config> {
  return mutateConfig((config) => {
    config.browser.enabled = enabled
  })
}

export function setBrowserHeadless(headless: boolean): SettingsResult<Config> {
  return mutateConfig((config) => {
    config.browser.headless = headless
  })
}

export function setBrowserKeepSnapshots(count: number): SettingsResult<Config> {
  if (!Number.isInteger(count) || count < 0) {
    return { ok: false, error: 'Snapshot count must be a non-negative integer.' }
  }
  return mutateConfig((config) => {
    config.browser.keepSnapshots = count
  })
}

export function setSearchProvider(provider?: SearchProvider): SettingsResult<Config> {
  return mutateConfig((config) => {
    if (!provider) {
      delete config.search
    } else {
      config.search = { provider }
    }
  })
}

export function setClassifierBackend(backend: ClassifierBackend): SettingsResult<Config> {
  return mutateConfig((config) => {
    config.classifier.backend = backend
  })
}

export function setDisplayTools(tools: ToolDisplay): SettingsResult<Config> {
  return mutateConfig((config) => {
    config.display.tools = tools
  })
}

export function setDisplayThinking(thinking: 'on' | 'off'): SettingsResult<Config> {
  return mutateConfig((config) => {
    config.display.thinking = thinking
  })
}

export function setConfigReasoningEffort(effort: ReasoningEffort): SettingsResult<Config> {
  return mutateConfig((config) => {
    config.reasoningEffort = effort
  })
}

export function setPermissionsConfig(permissions: PermissionsConfig): SettingsResult<Config> {
  return mutateConfig((config) => {
    config.permissions = permissions
  })
}

export function setClassifierConfig(classifier: ClassifierConfig): SettingsResult<Config> {
  return mutateConfig((config) => {
    config.classifier = classifier
  })
}

export function saveSecret(group: SecretGroup, id: string, value: string): SettingsResult<boolean> {
  if (!['providers', 'search', 'gateways'].includes(group) || !id || typeof value !== 'string') {
    return { ok: false, error: 'Invalid secret update.' }
  }
  const trimmed = value.trim()
  if (!trimmed) return { ok: true, value: false }

  const result = mutateAuth((auth) => {
    const record = auth[group as keyof Auth] as Record<string, string>
    record[id] = trimmed
  })
  if (!result.ok) return { ok: false, error: result.error }
  return { ok: true, value: true }
}

export function removeSecret(group: SecretGroup, id: string): SettingsResult<boolean> {
  if (!['providers', 'search', 'gateways'].includes(group) || !id) {
    return { ok: false, error: 'Invalid secret update.' }
  }
  const result = mutateAuth((auth) => {
    delete (auth[group as keyof Auth] as Record<string, string>)[id]
  })
  if (!result.ok) return { ok: false, error: result.error }
  return { ok: true, value: true }
}
