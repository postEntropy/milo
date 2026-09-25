/**
 * The provider refused this text — it will refuse it again.
 *
 * Kept apart from every other failure on purpose: a note whose text the model
 * will not take has to be recorded and left behind, while a connection that was
 * not open yet must be tried again. Treating them as one thing loses notes to a
 * slow start, which is exactly what happened before this existed.
 */
export class InputRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InputRefusedError'
  }
}

/**
 * Whether the status blames the text rather than the connection, the key or the
 * moment. Everything else — a network drop, a 5xx, a bad key, a rate limit — may
 * pass next time.
 */
export function refusedInput(status: number): boolean {
  return status === 400 || status === 413 || status === 422
}

/**
 * A model that turns text into vectors, so recall can match by meaning rather
 * than by shared words.
 *
 * The interface is the whole of what memory knows: it asks for vectors and gets
 * them, or it does not and recall carries on with keywords. Nothing here says
 * Ollama, so a second engine is this file and no caller changes.
 */
export interface Embedder {
  /** The model's own name, recorded beside every vector it produces. */
  readonly model: string
  embed(texts: string[]): Promise<Float32Array[]>
}

export interface OllamaOptions {
  /** Where the service listens. Milo's own runs on a private port. */
  url: string
  model: string
  /** One call's ceiling. A local model is slow the first time it loads. */
  timeoutMs?: number
  signal?: AbortSignal
}

const DEFAULT_EMBED_TIMEOUT_MS = 30_000

/**
 * Reads a local Ollama over HTTP.
 *
 * `input` is a list, and it is always sent as one: the query is a single string
 * per turn, but backfilling a store is hundreds of them, and one request per
 * note would make the first run after enabling this take minutes.
 */
export function createOllama(options: OllamaOptions): Embedder {
  const base = options.url.replace(/\/+$/, '')

  return {
    model: options.model,
    async embed(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return []

      const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS)
      const signal = options.signal
        ? AbortSignal.any([options.signal, timeout])
        : timeout

      const response = await fetch(`${base}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: options.model, input: texts }),
        signal,
      })
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw failure(base, response.status, detail)
      }

      const body = (await response.json()) as { embeddings?: unknown }
      const embeddings = body.embeddings
      if (!Array.isArray(embeddings)) {
        throw new Error(`${base} returned no vectors for ${texts.length} texts`)
      }
      return toVectors(embeddings, texts.length, base)
    },
  }
}

/**
 * Reads an OpenAI-shaped embeddings endpoint — which is what OpenRouter serves,
 * and what most hosted providers serve.
 *
 * The vector is computed on their machine, so this costs no VRAM and no local
 * model; it costs a key, and the text leaves this one. That trade is the user's
 * to make: nothing here decides it, and the local engine is the same interface.
 */
export function createOpenAiEmbeddings(options: {
  /** The API root, e.g. `https://openrouter.ai/api/v1` — `/embeddings` is added. */
  url: string
  model: string
  apiKey: string
  timeoutMs?: number
  signal?: AbortSignal
}): Embedder {
  const base = options.url.replace(/\/+$/, '')

  return {
    model: options.model,
    async embed(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return []

      const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS)
      const response = await fetch(`${base}/embeddings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({ model: options.model, input: texts }),
        signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
      })
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw failure(base, response.status, detail)
      }

      const body = (await response.json()) as { data?: { embedding?: unknown }[] }
      const vectors = body.data?.map((entry) => entry.embedding) ?? []
      // One vector per input, in the order they were sent — that is the whole
      // contract, and a response that breaks it would shift every vector by one
      // note rather than fail.
      return toVectors(vectors, texts.length, base)
    },
  }
}

/** One shape for what a provider said back, whatever refused the request. */
function failure(base: string, status: number, detail: string): Error {
  const message = `${base} answered ${status}${detail ? `: ${detail.slice(0, 200)}` : ''}`
  return refusedInput(status) ? new InputRefusedError(message) : new Error(message)
}

/** Validates a batch of raw vectors, normalizes them, and says what was wrong. */
function toVectors(raw: unknown[], expected: number, source: string): Float32Array[] {
  if (raw.length !== expected) {
    throw new Error(`${source} returned ${raw.length} vectors for ${expected} texts`)
  }
  return raw.map((vector, index) => {
    if (!Array.isArray(vector) || vector.length === 0) {
      throw new Error(`${source} returned an empty vector for text ${index}`)
    }
    return normalize(Float32Array.from(vector as number[]))
  })
}

/**
 * Vectors are stored and compared as unit length, so recall is a dot product and
 * no caller has to remember to divide by the norms.
 */
export function normalize(vector: Float32Array): Float32Array {
  let sum = 0
  for (const value of vector) sum += value * value
  const length = Math.sqrt(sum)
  if (length === 0) return vector
  const unit = new Float32Array(vector.length)
  for (let i = 0; i < vector.length; i += 1) unit[i] = vector[i]! / length
  return unit
}

/**
 * A vector the model found nothing in. It is not comparable with anything —
 * every dot product against it is zero — so the store keeps no vector at all
 * rather than one that would put the note in every ranking by accident.
 */
export function isNoise(vector: Float32Array): boolean {
  for (const value of vector) if (value !== 0) return false
  return true
}
