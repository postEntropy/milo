import { readAuth, readConfig, saveAuth, saveConfig } from './config/load.js'
import { PRESETS } from './config/presets.js'
import { colorPaletteNames, isColorPaletteId } from './color-palettes.js'
import {
  ConfigSchema,
  WireSchema,
  type Auth,
  type Config,
  type ProviderEntry,
  type WireInput,
} from './config/schema.js'
import { errorMessage } from '../util/errors.js'

export type SettingsResult<T = Config> =
  | { ok: true; value: T }
  | { ok: false; error: string }

export type SecretGroup = 'providers' | 'search' | 'gateways'

export const RESERVED_PROVIDER_IDS = new Set([...PRESETS.map((preset) => preset.id), 'groq'])
export const PROVIDER_WIRES: readonly WireInput[] = ['openai', 'anthropic', 'responses', 'auto']

export interface CustomProviderInput {
  id?: string
  name: string
  baseURL: string
  wire?: WireInput
  keyless?: boolean
  apiKey?: string
  keyEnv?: string
  allowMissingKey?: boolean
}

const CUSTOM_PROVIDER_ID = /^[a-z0-9][a-z0-9_-]*$/
const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export function isCustomProviderId(id: string): boolean {
  return Boolean(id) && !RESERVED_PROVIDER_IDS.has(id)
}

export function slugifyProviderId(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
}

function nextCustomProviderId(base: string, existing: Record<string, ProviderEntry>): string {
  const root = base || 'custom'
  if (!RESERVED_PROVIDER_IDS.has(root) && !(root in existing)) return root
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${root}-${suffix}`
    if (!RESERVED_PROVIDER_IDS.has(candidate) && !(candidate in existing)) return candidate
  }
}

export function saveCustomProvider(
  input: CustomProviderInput,
): SettingsResult<{ id: string; entry: ProviderEntry; created: boolean }> {
  const current = readConfig()
  if (!current) return { ok: false, error: 'Milo is not configured.' }

  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name) return { ok: false, error: 'Enter a provider name.' }
  if (/[\r\n]/.test(name)) return { ok: false, error: 'A provider name must fit on one line.' }
  if (name.length > 80) return { ok: false, error: 'Provider name must be 80 characters or fewer.' }

  const rawUrl = typeof input.baseURL === 'string' ? input.baseURL.trim() : ''
  let parsedUrl: URL
  try {
    parsedUrl = new URL(rawUrl)
  } catch {
    return { ok: false, error: 'Enter a valid http:// or https:// endpoint URL.' }
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return { ok: false, error: 'Enter a valid http:// or https:// endpoint URL.' }
  }
  const baseURL = rawUrl.replace(/\/+$/, '')

  const wireParsed = WireSchema.safeParse(input.wire ?? 'openai')
  if (!wireParsed.success) {
    return { ok: false, error: 'Choose a valid API format (openai, anthropic, responses, or auto).' }
  }
  const wire = wireParsed.data

  let id: string
  if (input.id !== undefined && input.id.trim() !== '') {
    id = input.id.trim().toLowerCase()
    if (!CUSTOM_PROVIDER_ID.test(id)) {
      return {
        ok: false,
        error: 'Provider id must start with a letter or digit and use only letters, digits, hyphens, or underscores.',
      }
    }
    if (RESERVED_PROVIDER_IDS.has(id)) {
      return { ok: false, error: `"${id}" is reserved for a built-in provider.` }
    }
  } else {
    id = nextCustomProviderId(slugifyProviderId(name) || 'custom', current.providers)
  }

  const created = !(id in current.providers)
  const keyless = input.keyless === true
  const trimmedKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : ''
  const rawKeyEnv = typeof input.keyEnv === 'string' ? input.keyEnv.trim() : undefined
  if (rawKeyEnv && !ENV_VAR_NAME.test(rawKeyEnv)) {
    return {
      ok: false,
      error: 'Environment variable name must contain only letters, digits, and underscores.',
    }
  }
  const existing = current.providers[id]
  const effectiveKeyEnv = keyless ? undefined : rawKeyEnv !== undefined ? (rawKeyEnv || undefined) : existing?.keyEnv
  const envValue = effectiveKeyEnv ? process.env[effectiveKeyEnv]?.trim() : undefined
  const auth = readAuth()
  if (!keyless && !trimmedKey && !auth.providers[id]?.trim() && !envValue && !input.allowMissingKey) {
    return { ok: false, error: 'Enter an API key, or turn on "No API key required".' }
  }

  const entry: ProviderEntry = {
    ...(existing?.headers ? { headers: existing.headers } : {}),
    ...(existing?.nativePdf !== undefined ? { nativePdf: existing.nativePdf } : {}),
    ...(effectiveKeyEnv ? { keyEnv: effectiveKeyEnv } : {}),
    name,
    baseURL,
    wire,
    ...(keyless ? { keyless: true } : {}),
  }

  const configRes = mutateConfig((cfg) => {
    cfg.providers[id] = entry
  })
  if (!configRes.ok) return configRes

  if (keyless || trimmedKey) {
    const authRes = mutateAuth((nextAuth) => {
      if (keyless) delete nextAuth.providers[id]
      else nextAuth.providers[id] = trimmedKey
    })
    if (!authRes.ok) return authRes
  }

  return { ok: true, value: { id, entry, created } }
}

export function removeCustomProvider(id: string): SettingsResult<{ id: string }> {
  const trimmed = typeof id === 'string' ? id.trim() : ''
  if (!trimmed || !isCustomProviderId(trimmed)) {
    return { ok: false, error: 'Built-in providers cannot be removed.' }
  }

  const current = readConfig()
  if (!current) return { ok: false, error: 'Milo is not configured.' }
  if (!(trimmed in current.providers)) {
    return { ok: false, error: `Provider "${trimmed}" was not found.` }
  }
  if (current.provider === trimmed) {
    return { ok: false, error: 'Switch to another provider before removing this one.' }
  }

  const configRes = mutateConfig((cfg) => {
    delete cfg.providers[trimmed]
  })
  if (!configRes.ok) return configRes

  const authRes = mutateAuth((nextAuth) => {
    delete nextAuth.providers[trimmed]
  })
  if (!authRes.ok) return authRes

  return { ok: true, value: { id: trimmed } }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function mergePatch(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch) || !isPlainObject(base)) return patch
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete out[key]
      continue
    }
    out[key] = mergePatch(out[key], value)
  }
  return out
}

function valueAtPath(root: unknown, dotted: string): unknown {
  let cur = root
  for (const part of dotted.split('.')) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

export function sanitizeConfig(config: Config): Config {
  return {
    ...config,
    providers: Object.fromEntries(
      Object.entries(config.providers).map(([id, entry]) => [
        id,
        {
          ...entry,
          headers: undefined,
        },
      ]),
    ),
  }
}

export function flattenPatchPaths(
  patch: Record<string, unknown>,
  prefix = '',
): Array<{ path: string; value: unknown }> {
  const out: Array<{ path: string; value: unknown }> = []
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const path = prefix ? `${prefix}.${key}` : key
    if (isPlainObject(value)) {
      const nested = flattenPatchPaths(value, path)
      if (nested.length > 0) out.push(...nested)
      else out.push({ path, value })
    } else {
      out.push({ path, value })
    }
  }
  return out
}

export function restartReasonsForConfigChange(previous: Config, next: Config): string[] {
  const checks: Array<[string, unknown, unknown]> = [
    ['Browser', previous.browser, next.browser],
    ['Computer Use', previous.computer, next.computer],
    ['Web host and port', previous.web, next.web],
    ['Gateways', previous.gateways, next.gateways],
    ['Reviewer model', previous.classifier, next.classifier],
    ['Google tools', previous.google, next.google],
    ['Web search', previous.search, next.search],
    ['Traces', previous.traces, next.traces],
    ['Background jobs', previous.jobs, next.jobs],
    ['Verification gate', previous.verification, next.verification],
    ['Memory embeddings', previous.memory.embedding, next.memory.embedding],
  ]
  return checks
    .filter(([, prevVal, nextVal]) => JSON.stringify(prevVal) !== JSON.stringify(nextVal))
    .map(([label]) => label)
}

export function applyConfigPatch(
  patch: Record<string, unknown>,
): SettingsResult<{ previous: Config; next: Config; changed: string[]; restartRequired: string[] }> {
  const previous = readConfig()
  if (!previous) return { ok: false, error: 'Milo is not configured.' }
  if (!isPlainObject(patch)) return { ok: false, error: 'Expected a config object.' }

  if ('palette' in patch) {
    if (!isPlainObject(patch.palette)) {
      return { ok: false, error: 'Expected a palette settings object.' }
    }
    if ('sync' in patch.palette && typeof patch.palette.sync !== 'boolean') {
      return { ok: false, error: 'Palette sync must be true or false.' }
    }
    if ('palette' in patch.palette && !isColorPaletteId(patch.palette.palette)) {
      return {
        ok: false,
        error: `Unknown colour palette "${String(patch.palette.palette)}". Use one of: ${colorPaletteNames()}.`,
      }
    }
  }

  try {
    const merged = mergePatch(previous, patch) as Record<string, unknown>
    const next = ConfigSchema.parse(merged)
    saveConfig(next)
    const leaves = flattenPatchPaths(patch)
    const changed = leaves
      .filter(({ path }) => JSON.stringify(valueAtPath(previous, path)) !== JSON.stringify(valueAtPath(next, path)))
      .map(({ path }) => path)
    const restartRequired = restartReasonsForConfigChange(previous, next)
    return { ok: true, value: { previous, next, changed, restartRequired } }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}

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
