import { normalizeModels, type ListModelsOptions, type ModelInfo } from './models.js'

export interface AudioProvider extends Omit<ListModelsOptions, 'signal'> {
  id: string
}

/** What a catalog said about a model's input: it takes it, it does not, or nobody said. */
export type ModalitySupport = true | false | undefined

const OPENROUTER_MODEL = 'https://openrouter.ai/api/v1/models'
const LOOKUP_TIMEOUT_MS = 1_000
const KNOWN_TTL_MS = 6 * 60 * 60 * 1000
const UNKNOWN_TTL_MS = 5 * 60 * 1000
const audioCache = new Map<string, { value: ModalitySupport; expiresAt: number }>()
const pendingAudioLookups = new Map<string, Promise<ModalitySupport>>()

const AUTHORS: Record<string, string> = {
  anthropic: 'anthropic',
  openai: 'openai',
  google: 'google',
  gemini: 'google',
  groq: 'groq',
  xai: 'x-ai',
  'x-ai': 'x-ai',
  mistral: 'mistralai',
}

/** Audio support is trusted only when a provider catalog says so. */
export async function lookupAudioSupport(provider: AudioProvider, model: string): Promise<ModalitySupport> {
  const key = `${provider.baseURL.replace(/\/+$/, '')}\n${model.trim().toLowerCase()}`
  const cached = audioCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.value
  const pending = pendingAudioLookups.get(key)
  if (pending) return pending
  const lookup = resolveAudioSupport(provider, model).then((value) => {
    audioCache.set(key, { value, expiresAt: Date.now() + (value === undefined ? UNKNOWN_TTL_MS : KNOWN_TTL_MS) })
    return value
  }).finally(() => pendingAudioLookups.delete(key))
  pendingAudioLookups.set(key, lookup)
  return lookup
}

async function resolveAudioSupport(provider: AudioProvider, model: string): Promise<ModalitySupport> {
  const base = provider.baseURL.replace(/\/+$/, '')
  const isOpenRouter = /(^|\/)openrouter\.ai\/api\/v1$/i.test(base)
  if (isOpenRouter) return (await lookupOpenRouter(provider.id, model))?.inputModalities?.includes('audio')
  const [models, publicInfo] = await Promise.all([
    lookupProviderModels(provider, model), lookupOpenRouter(provider.id, model),
  ])
  return models?.inputModalities?.includes('audio') ?? publicInfo?.inputModalities?.includes('audio')
}

async function lookupProviderModels(provider: AudioProvider, model: string): Promise<ModelInfo | undefined> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS)
  try {
    const models = await fetchModels({ ...provider, signal: controller.signal })
    return findModel(models, model)
  } catch {
    return undefined
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchModels(options: ListModelsOptions): Promise<ModelInfo[]> {
  const base = options.baseURL.replace(/\/+$/, '')
  const headers: Record<string, string> = { accept: 'application/json', ...options.headers }
  const key = options.apiKey === false ? undefined : options.apiKey
  if (key) {
    if (options.wire === 'anthropic') {
      headers['x-api-key'] = key
      headers['anthropic-version'] = '2023-06-01'
    } else headers.authorization = `Bearer ${key}`
  }
  const response = await fetch(`${base}/models`, { headers, signal: options.signal })
  if (!response.ok) return []
  return normalizeModels(await response.json())
}

async function lookupOpenRouter(providerId: string, model: string): Promise<ModelInfo | undefined> {
  const slug = openRouterSlug(providerId, model)
  if (!slug) return undefined
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS)
  try {
    const path = slug.split('/').map(encodeURIComponent).join('/')
    const response = await fetch(`${OPENROUTER_MODEL}/${path}`, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) return undefined
    const payload: unknown = await response.json()
    if (!payload || typeof payload !== 'object') return undefined
    const data = (payload as Record<string, unknown>).data
    return normalizeModels({ data: data ? [data] : [] })[0]
  } catch {
    return undefined
  } finally {
    clearTimeout(timeout)
  }
}

function openRouterSlug(providerId: string, model: string): string | undefined {
  const id = model.trim().replace(/^\/+|\/+$/g, '')
  if (!id) return undefined
  if (id.includes('/')) return id
  const author = AUTHORS[providerId.toLowerCase()] ?? modelAuthor(id)
  return author ? `${author}/${id}` : undefined
}

function modelAuthor(model: string): string | undefined {
  if (/^claude-/i.test(model)) return 'anthropic'
  if (/^(gpt-|o[134](?:-|$)|chatgpt-)/i.test(model)) return 'openai'
  if (/^gemini-/i.test(model)) return 'google'
  return undefined
}

function findModel(models: ModelInfo[], model: string): ModelInfo | undefined {
  const wanted = model.trim().toLowerCase()
  return models.find((item) => item.id.toLowerCase() === wanted)
}
