import type { Wire } from './create.js'

export interface ModelInfo {
  id: string
  name?: string
}

export interface ListModelsOptions {
  baseURL: string
  apiKey?: string | false
  wire?: Wire
  headers?: Record<string, string>
  signal?: AbortSignal
}

/**
 * Fetches the provider's model catalog from `GET {baseURL}/models`. Handles the
 * common response shapes (OpenAI/Anthropic `{ data: [...] }`, `{ models: [...] }`
 * and a bare array), where each entry is either a string or an object.
 */
export async function listModels(options: ListModelsOptions): Promise<ModelInfo[]> {
  const base = options.baseURL.replace(/\/+$/, '')
  const wire = options.wire ?? 'openai'
  const headers: Record<string, string> = { accept: 'application/json', ...options.headers }
  const key = options.apiKey === false ? undefined : options.apiKey

  if (key) {
    if (wire === 'anthropic') {
      headers['x-api-key'] = key
      headers['anthropic-version'] = '2023-06-01'
    } else {
      headers.authorization = `Bearer ${key}`
    }
  }

  const response = await fetch(`${base}/models`, { headers, signal: options.signal })
  if (!response.ok) {
    throw new Error(`GET ${base}/models -> ${response.status} ${response.statusText}`)
  }

  const json: unknown = await response.json()
  return normalizeModels(json)
}

export function normalizeModels(json: unknown): ModelInfo[] {
  const raw = pickArray(json)
  const byId = new Map<string, ModelInfo>()

  for (const item of raw) {
    if (typeof item === 'string') {
      byId.set(item, { id: item })
      continue
    }
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const id = firstString(record.id, record.model, record.slug)
    if (!id) continue
    const name = firstString(record.display_name, record.name)
    byId.set(id, { id, name: name && name !== id ? name : undefined })
  }

  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}

function pickArray(json: unknown): unknown[] {
  if (Array.isArray(json)) return json
  if (json && typeof json === 'object') {
    const record = json as Record<string, unknown>
    for (const key of ['data', 'models', 'items', 'model']) {
      if (Array.isArray(record[key])) return record[key] as unknown[]
    }
  }
  return []
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}
