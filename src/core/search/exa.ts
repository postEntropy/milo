import { condense } from './snippet.js'
import type { SearchOptions, SearchProvider, SearchResult } from './types.js'

export interface ExaOptions {
  apiKey: string
  baseURL?: string
  /**
   * `auto` balances quality and speed, `fast` trades a little depth for lower
   * latency, `instant` is the quickest. Interactive tool calls want `fast`.
   */
  mode?: 'instant' | 'fast' | 'auto' | 'deep-lite' | 'deep' | 'deep-reasoning'
}

const DEFAULT_BASE_URL = 'https://api.exa.ai'
const DEFAULT_MODE = 'fast'

/**
 * Exa: neural search over its own index, used by coding agents for repo, docs
 * and changelog lookups. `highlights` returns the passages relevant to the
 * query — denser than a snippet, cheaper than the whole page — so the snippet
 * prefers them and falls back to the page text.
 */
export class ExaSearchProvider implements SearchProvider {
  readonly id = 'exa'
  private readonly apiKey: string
  private readonly baseURL: string
  private readonly mode: NonNullable<ExaOptions['mode']>

  constructor(options: ExaOptions) {
    this.apiKey = options.apiKey
    this.baseURL = (options.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.mode = options.mode ?? DEFAULT_MODE
  }

  async search(query: string, opts?: SearchOptions): Promise<SearchResult[]> {
    const response = await fetch(`${this.baseURL}/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey },
      body: JSON.stringify({
        query,
        numResults: opts?.maxResults ?? 5,
        type: this.mode,
        contents: { text: true, highlights: true },
      }),
      signal: opts?.signal,
    })

    if (!response.ok) {
      throw new Error(`Exa search failed (${response.status} ${response.statusText})`)
    }

    const json = (await response.json()) as { results?: unknown }
    const results = Array.isArray(json.results) ? json.results : []
    return results
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .filter((item) => typeof item.url === 'string')
      .map((item) => ({
        title: String(item.title ?? ''),
        url: String(item.url),
        snippet: snippetOf(item),
        ...(typeof item.publishedDate === 'string' ? { date: item.publishedDate } : {}),
      }))
  }
}

function snippetOf(record: Record<string, unknown>): string {
  const highlights = Array.isArray(record.highlights)
    ? record.highlights.filter((entry): entry is string => typeof entry === 'string')
    : []
  if (highlights.length > 0) return condense(highlights.join(' … '))
  return condense(typeof record.text === 'string' ? record.text : '')
}
