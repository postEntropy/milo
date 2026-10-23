import { readAuth, readConfig, saveAuth, saveConfig } from './config/load.js'
import {
  ConfigSchema,
  type Auth,
  type Config,
} from './config/schema.js'
import { errorMessage } from '../util/errors.js'

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
