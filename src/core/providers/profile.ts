import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { MILO_HOME } from '../config/paths.js'
import { errorMessage } from '../../util/errors.js'
import { logDebug } from '../../util/log.js'
import { writeFileAtomic } from '../../util/fs.js'
import type { ModelInfo } from './models.js'

/**
 * What Milo knows about one model: how much it holds, how much it answers with,
 * what it can read, and whether it thinks. None of it travels in a chat request,
 * and every piece of it changes a decision — a compaction threshold is meaningless
 * without the window, an output ceiling without the model's own, and a reasoning
 * effort sent to a model that has none is a field it may refuse.
 *
 * The sources disagree and are read in one order: what the person wrote for this
 * model, then the provider's own catalog, then the public OpenRouter catalog. A
 * field nobody answered stays absent, which every caller reads as "use the config's
 * own rule" rather than as zero.
 */
export interface ModelProfile {
  id: string
  /** The display name, when a catalog gave one. */
  name?: string
  /** How much the model holds, in tokens. */
  context?: number
  /** The output ceiling the model itself declares, in tokens. */
  maxOutput?: number
  /** Whether the model reads pictures. */
  vision?: boolean
  /** Whether the model reads audio. */
  audio?: boolean
  /** False when the model has no reasoning mode; absent when nothing said either way. */
  reasoning?: boolean
  /** Where this model folds the transcript, when it needs a rule of its own. */
  compactionAt?: number
}

/** What a person may write for one model in the config. */
export type ModelProfileOverride = Partial<Omit<ModelProfile, 'id'>>

/** One provider catalog's answer, in the shape `normalizeModels` returns. */
interface CatalogEntry {
  context?: number
  maxOutput?: number
  vision?: boolean
  audio?: boolean
  reasoning?: boolean
  name?: string
}

export interface ModelProfileSources {
  override?: ModelProfileOverride
  provider?: ModelInfo
  /** The entry as the public catalog spells it, or nothing when it has none. */
  openRouter?: CatalogEntry
}

/**
 * Merges the sources into one profile. The order is the whole rule and lives here
 * once: a person's word beats the provider that serves the model, which beats the
 * public catalog.
 */
export function mergeModelProfile(id: string, sources: ModelProfileSources): ModelProfile {
  const { override, provider, openRouter } = sources

  const name = provider?.name ?? openRouter?.name
  const context = override?.context ?? provider?.context ?? openRouter?.context
  const maxOutput = override?.maxOutput ?? provider?.maxOutput ?? openRouter?.maxOutput
  const vision = override?.vision ?? provider?.vision ?? provider?.inputModalities?.includes('image') ?? openRouter?.vision
  const audio = override?.audio ?? provider?.inputModalities?.includes('audio') ?? openRouter?.audio
  const reasoning = override?.reasoning ?? provider?.reasoning ?? openRouter?.reasoning

  return {
    id,
    ...(name ? { name } : {}),
    ...(context ? { context } : {}),
    ...(maxOutput ? { maxOutput } : {}),
    ...(vision !== undefined ? { vision } : {}),
    ...(audio !== undefined ? { audio } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(override?.compactionAt ? { compactionAt: override.compactionAt } : {}),
  }
}

/** The file where a profile is kept between runs: one entry per model id. */
export const modelProfileFile = (): string => path.join(MILO_HOME, 'models.json')

const CATALOG_URL = 'https://openrouter.ai/api/v1/models'
const CATALOG_TIMEOUT_MS = 4_000
/** A model's shape is not a moving target; a week is a guess at when a catalog corrects itself. */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

interface CacheEntry {
  profile: ModelProfile
  at: number
}

type Cache = Record<string, CacheEntry>

function readCache(file: string): Cache {
  try {
    if (!existsSync(file)) return {}
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? (parsed as Cache) : {}
  } catch (error) {
    // A cache that cannot be read is a cache that is empty.
    logDebug(`could not read ${file}: ${errorMessage(error)}`)
    return {}
  }
}

async function writeCache(file: string, cache: Cache): Promise<void> {
  try {
    await writeFileAtomic(file, `${JSON.stringify(cache, null, 2)}\n`)
  } catch (error) {
    logDebug(`could not write ${file}: ${errorMessage(error)}`)
  }
}

export interface LookupModelProfileOptions {
  /** Where the answer is kept between runs. */
  file?: string
  /** What the person wrote for this model, which outranks every catalog. */
  override?: ModelProfileOverride
  /** Swapped in tests, so nothing here has to reach the network. */
  fetchCatalog?: (signal?: AbortSignal) => Promise<unknown>
  /** The provider's own `/models`, when the caller has an address and a key. */
  fetchProvider?: (signal?: AbortSignal) => Promise<ModelInfo[]>
  now?: () => number
}

/**
 * The profile of `model`, from the cache or the catalogs. Never throws: a lookup
 * that fails is a lookup with nothing to add, and every caller falls back to the
 * configured rule for that field. The empty answer is cached too, so a model no
 * catalog knows is not asked about on every turn.
 */
export async function lookupModelProfile(
  model: string,
  options: LookupModelProfileOptions = {},
): Promise<ModelProfile> {
  const file = options.file ?? modelProfileFile()
  const now = options.now ?? Date.now
  const cache = readCache(file)

  const cached = cache[model]
  if (cached && now() - cached.at < CACHE_TTL_MS) {
    // The person's own word is applied on top of every read rather than baked
    // into the cache: editing `config.models` must land on the next turn, not
    // after the cached answer goes stale a week later.
    return applyOverride(cached.profile, options.override)
  }

  const [provider, catalog] = await Promise.all([
    options.fetchProvider ? options.fetchProvider().catch(() => []) : Promise.resolve([]),
    (options.fetchCatalog ?? fetchCatalog)().catch(() => null),
  ])

  const info = provider.find((entry) => sameModel(entry.id, model))
  const entry = catalog ? catalogEntry(catalog, model) : undefined
  // What the catalogs said is what is cached; the override is layered on after.
  const profile = mergeModelProfile(model, { provider: info, openRouter: entry })

  cache[model] = { profile, at: now() }
  await writeCache(file, cache)
  return applyOverride(profile, options.override)
}

/** The person's own facts over whatever the catalogs answered. */
function applyOverride(profile: ModelProfile, override?: ModelProfileOverride): ModelProfile {
  if (!override) return profile
  return {
    ...profile,
    ...(override.name !== undefined ? { name: override.name } : {}),
    ...(override.context !== undefined ? { context: override.context } : {}),
    ...(override.maxOutput !== undefined ? { maxOutput: override.maxOutput } : {}),
    ...(override.vision !== undefined ? { vision: override.vision } : {}),
    ...(override.audio !== undefined ? { audio: override.audio } : {}),
    ...(override.reasoning !== undefined ? { reasoning: override.reasoning } : {}),
    ...(override.compactionAt !== undefined ? { compactionAt: override.compactionAt } : {}),
  }
}

/** The public catalog is megabytes; only the matching entry is read from it. */
async function fetchCatalog(signal?: AbortSignal): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CATALOG_TIMEOUT_MS)
  signal?.addEventListener('abort', () => controller.abort(), { once: true })
  try {
    const response = await fetch(CATALOG_URL, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`GET ${CATALOG_URL} -> ${response.status}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The entry for `model` in a catalog shaped like OpenRouter's: `{ data: [{ id,
 * context_length }] }`. An exact id wins; failing that, the same id with the
 * provider prefix added or dropped, which is how the same model is spelled by
 * different catalogs.
 */
export function catalogEntry(catalog: unknown, model: string): CatalogEntry | undefined {
  const entries = catalogEntries(catalog)
  const wanted = model.trim().toLowerCase()
  const bare = wanted.includes('/') ? wanted.slice(wanted.indexOf('/') + 1) : wanted

  for (const entry of entries) {
    const id = entry.id.trim().toLowerCase()
    if (id !== wanted && id !== bare && !id.endsWith(`/${bare}`)) continue
    const context = firstNumber(entry, ['context_length', 'context_window', 'max_context_tokens', 'max_model_len'])
    const top = entry.top_provider && typeof entry.top_provider === 'object'
      ? (entry.top_provider as Record<string, unknown>)
      : entry
    const maxOutput = firstNumber(top, ['max_completion_tokens', 'max_output_tokens', 'max_tokens'])
    const architecture = entry.architecture && typeof entry.architecture === 'object'
      ? (entry.architecture as Record<string, unknown>)
      : {}
    const inputs = Array.isArray(architecture.input_modalities)
      ? (architecture.input_modalities as unknown[]).filter((item): item is string => typeof item === 'string')
      : undefined
    const reasoning = firstBoolean(entry, ['supports_reasoning', 'reasoning'])
    const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : undefined
    if (context === undefined && maxOutput === undefined && inputs === undefined && reasoning === undefined && !name) {
      return undefined
    }
    return {
      ...(name ? { name } : {}),
      ...(context ? { context } : {}),
      ...(maxOutput ? { maxOutput } : {}),
      ...(inputs ? { vision: inputs.includes('image'), audio: inputs.includes('audio') } : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
    }
  }
  return undefined
}

/** The window alone, kept for the callers that only ask how much a model holds. */
export function windowFrom(catalog: unknown, model: string): number | null {
  return catalogEntry(catalog, model)?.context ?? null
}

function catalogEntries(catalog: unknown): { id: string; [key: string]: unknown }[] {
  const raw = Array.isArray(catalog)
    ? catalog
    : catalog && typeof catalog === 'object'
      ? ((catalog as Record<string, unknown>).data ?? (catalog as Record<string, unknown>).models)
      : undefined
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (item): item is { id: string } =>
      Boolean(item) && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string',
  )
}

/** The same model spelled with and without its provider prefix. */
function sameModel(id: string, model: string): boolean {
  const wanted = model.trim().toLowerCase()
  const bare = wanted.includes('/') ? wanted.slice(wanted.indexOf('/') + 1) : wanted
  const seen = id.trim().toLowerCase()
  return seen === wanted || seen === bare || seen.endsWith(`/${bare}`)
}

function firstNumber(entry: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = entry[key]
    const number = typeof value === 'string' ? Number(value) : value
    if (typeof number === 'number' && Number.isFinite(number) && number > 0) return Math.floor(number)
  }
  return undefined
}

function firstBoolean(entry: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = entry[key]
    if (typeof value === 'boolean') return value
  }
  return undefined
}
