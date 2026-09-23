import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { MILO_HOME } from '../config/paths.js'
import { writeFileAtomic } from '../../util/fs.js'
import { logDebug } from '../../util/log.js'
import { errorMessage } from '../../util/errors.js'

/**
 * How many tokens a model can hold. Nothing in a chat request carries it, and a
 * compaction threshold is meaningless without it: the same 12000 is a third of a
 * small window and 1% of a large one, and the second case compacts on every turn
 * for no reason.
 *
 * The number comes from public model metadata — the OpenRouter catalog, which
 * needs no key and lists `context_length` per model — and is cached on disk,
 * because it changes when a model does and not when a conversation does.
 */

const CATALOG_URL = 'https://openrouter.ai/api/v1/models'
const CATALOG_TIMEOUT_MS = 4_000
/** A model's window is not a moving target; a week is a guess at when a catalog might correct itself. */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

export const contextWindowFile = (): string => path.join(MILO_HOME, 'context-windows.json')

/** What a model's window is, or `null` when the catalog was asked and did not know. */
interface CacheEntry {
  tokens: number | null
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

export interface ContextWindowOptions {
  /** Where the answer is kept between runs. */
  file?: string
  /** Swapped in tests, so nothing here has to reach the network. */
  fetchCatalog?: (signal?: AbortSignal) => Promise<unknown>
  now?: () => number
}

/**
 * The model's context window in tokens, or undefined when nothing knows it.
 * Never throws: a lookup that fails is a lookup that has no answer, and the
 * caller falls back to the configured ceiling.
 */
export async function lookupContextWindow(
  model: string,
  options: ContextWindowOptions = {},
): Promise<number | undefined> {
  const file = options.file ?? contextWindowFile()
  const now = options.now ?? Date.now
  const cache = readCache(file)

  const cached = cache[model]
  if (cached && now() - cached.at < CACHE_TTL_MS) {
    return cached.tokens ?? undefined
  }

  let tokens: number | null = null
  try {
    const catalog = await (options.fetchCatalog ?? fetchCatalog)()
    tokens = windowFrom(catalog, model)
  } catch (error) {
    logDebug(`context window lookup failed for ${model}: ${errorMessage(error)}`)
    return undefined
  }

  cache[model] = { tokens, at: now() }
  await writeCache(file, cache)
  return tokens ?? undefined
}

/** The catalog is megabytes; only the ids and one field are read from it. */
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
 * The window for `model` in a catalog shaped like OpenRouter's: `{ data: [{ id,
 * context_length }] }`. An exact id wins; failing that, the same id with the
 * provider prefix dropped or added, which is how the same model is spelled by
 * different catalogs.
 */
export function windowFrom(catalog: unknown, model: string): number | null {
  const entries = catalogEntries(catalog)
  const wanted = model.trim().toLowerCase()
  const bare = wanted.includes('/') ? wanted.slice(wanted.indexOf('/') + 1) : wanted

  for (const entry of entries) {
    const id = entry.id.trim().toLowerCase()
    if (id !== wanted && id !== bare && !id.endsWith(`/${bare}`)) continue
    const tokens = contextField(entry)
    if (tokens) return tokens
  }
  return null
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

/** Catalogs disagree on the name; the first one present is the answer. */
function contextField(entry: Record<string, unknown>): number | null {
  for (const key of ['context_length', 'context_window', 'max_context_tokens', 'max_model_len']) {
    const value = entry[key]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value)
  }
  return null
}
