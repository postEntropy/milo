import { condense } from './snippet.js'
import type { SearchOptions, SearchProvider, SearchResult } from './types.js'

export interface ParallelOptions {
  apiKey: string
  baseURL?: string
  /**
   * `turbo` is the fastest (p50 ~200ms), `fast` aims for high quality inside a
   * one-second budget, `advanced` is the API default at ~3s. A tool call in a
   * chat is interactive, so `fast` is the default here — passing nothing would
   * silently get `advanced`.
   */
  mode?: 'turbo' | 'fast' | 'basic' | 'advanced'
}

const DEFAULT_BASE_URL = 'https://api.parallel.ai'
const DEFAULT_MODE = 'fast'

/** The API asks for 3-6 word keyword queries, not the question itself. */
const MAX_QUERY_WORDS = 6

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'do', 'does', 'did', 'of', 'in', 'on',
  'at', 'to', 'for', 'with', 'about', 'from', 'by', 'and', 'or', 'it', 'this', 'that', 'what',
  'who', 'when', 'where', 'why', 'how', 'me', 'my', 'i', 'we', 'you', 'your', 'can', 'could',
  'should', 'would', 'please', 'o', 'os', 'as', 'um', 'uma', 'de', 'do', 'da', 'em', 'no', 'na',
  'para', 'com', 'sobre', 'e', 'ou', 'qual', 'quais', 'quem', 'como', 'onde', 'quando', 'que',
  'é', 'são', 'sao', 'está', 'esta', 'foi', 'tem', 'há',
])

/**
 * Parallel: ranked URLs with dense excerpts from its own index, priced per
 * request rather than per token.
 */
export class ParallelSearchProvider implements SearchProvider {
  readonly id = 'parallel'
  private readonly apiKey: string
  private readonly baseURL: string
  private readonly mode: NonNullable<ParallelOptions['mode']>

  constructor(options: ParallelOptions) {
    this.apiKey = options.apiKey
    this.baseURL = (options.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.mode = options.mode ?? DEFAULT_MODE
  }

  async search(query: string, opts?: SearchOptions): Promise<SearchResult[]> {
    const response = await fetch(`${this.baseURL}/v1/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey },
      body: JSON.stringify({
        objective: query,
        search_queries: [keyWords(query)],
        mode: this.mode,
        advanced_settings: { max_results: opts?.maxResults ?? 5 },
      }),
      signal: opts?.signal,
    })

    if (!response.ok) {
      throw new Error(`Parallel search failed (${response.status} ${response.statusText})`)
    }

    const json = (await response.json()) as { results?: unknown }
    const results = Array.isArray(json.results) ? json.results : []
    return results
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .filter((item) => typeof item.url === 'string')
      .map((item) => ({
        title: String(item.title ?? ''),
        url: String(item.url),
        snippet: condense(
          Array.isArray(item.excerpts)
            ? item.excerpts.filter((entry): entry is string => typeof entry === 'string').join(' ')
            : '',
        ),
        ...(typeof item.publish_date === 'string' ? { date: item.publish_date } : {}),
      }))
  }
}

/** `what is the new deepseek model` → `new deepseek model`. */
export function keyWords(query: string): string {
  const words = query
    .replace(/[^\p{L}\p{N}\s.+#-]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word !== '' && !STOP_WORDS.has(word.toLowerCase()))
  if (words.length === 0) return query.trim()
  return words.slice(0, MAX_QUERY_WORDS).join(' ')
}
