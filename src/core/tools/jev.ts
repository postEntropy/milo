import type { DangerReviewer } from './permission.js'

export interface JevReviewerOptions {
  baseURL: string
  apiKey?: string
  model?: string
  headers?: Record<string, string>
  /** Abort the request after this long. Defaults to 1500ms. */
  timeoutMs?: number
  /** Memoize verdicts per state string. Defaults to true. */
  cache?: boolean
  cacheSize?: number
}

const DEFAULT_MODEL = 'typesafe/jev'
const DEFAULT_TIMEOUT = 1500
const DEFAULT_CACHE_SIZE = 200

const INSTRUCTIONS =
  'Is this action destructive or dangerous — able to cause irreversible damage to the system, ' +
  'data, or the repository?'

/**
 * Reviews a proposed action — a shell command, or a file write — with Command
 * Code's decision model (`typesafe/jev`), which answers typed questions with
 * probabilities instead of text. Returns the probability that the action is
 * dangerous (0..1). Throws on any failure — including a timeout — so the caller
 * fails closed.
 *
 * Latency notes: identical states are served from an in-memory LRU (so a
 * repeated command costs nothing), and the request is aborted after `timeoutMs`
 * instead of blocking the agent.
 */
export class JevReviewer implements DangerReviewer {
  private readonly options: JevReviewerOptions
  private readonly cacheEnabled: boolean
  private readonly cacheSize: number
  private readonly cache = new Map<string, number>()

  constructor(options: JevReviewerOptions) {
    this.options = options
    this.cacheEnabled = options.cache ?? true
    this.cacheSize = options.cacheSize ?? DEFAULT_CACHE_SIZE
  }

  async review(state: string, signal?: AbortSignal): Promise<number> {
    const cached = this.cacheEnabled ? this.cache.get(state) : undefined
    if (cached !== undefined) {
      this.cache.delete(state)
      this.cache.set(state, cached)
      return cached
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error('jev review timed out')), this.options.timeoutMs ?? DEFAULT_TIMEOUT)
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })

    try {
      const probability = await this.request(state, controller.signal)
      if (this.cacheEnabled) this.remember(state, probability)
      return probability
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  private async request(state: string, signal: AbortSignal): Promise<number> {
    const base = this.options.baseURL.replace(/\/+$/, '')
    const response = await fetch(`${base}/systemone`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
        ...this.options.headers,
      },
      body: JSON.stringify({
        model: this.options.model ?? DEFAULT_MODEL,
        state,
        questions: {
          dangerous: { type: 'noul', instructions: INSTRUCTIONS },
        },
      }),
      signal,
    })

    if (!response.ok) {
      throw new Error(`jev review failed (${response.status} ${response.statusText})`)
    }

    const json = (await response.json()) as { answers?: { dangerous?: { noul?: unknown } } }
    const probability = json.answers?.dangerous?.noul
    if (typeof probability !== 'number' || Number.isNaN(probability)) {
      throw new Error('jev review returned no probability')
    }
    return Math.min(1, Math.max(0, probability))
  }

  private remember(state: string, probability: number): void {
    this.cache.set(state, probability)
    while (this.cache.size > this.cacheSize) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
  }
}

export function createJevReviewer(options: JevReviewerOptions): DangerReviewer {
  return new JevReviewer(options)
}
