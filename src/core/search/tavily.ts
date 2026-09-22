import type { SearchOptions, SearchProvider, SearchResult } from './types.js'

export class TavilySearchProvider implements SearchProvider {
  readonly id = 'tavily'
  private readonly baseURL: string
  private readonly apiKey: string

  constructor(apiKey: string, baseURL = 'https://api.tavily.com') {
    this.apiKey = apiKey
    this.baseURL = baseURL.replace(/\/+$/, '')
  }

  async search(query: string, opts?: SearchOptions): Promise<SearchResult[]> {
    const response = await fetch(`${this.baseURL}/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        query,
        max_results: opts?.maxResults ?? 5,
        search_depth: 'basic',
      }),
      signal: opts?.signal,
    })

    if (!response.ok) {
      throw new Error(`Tavily search failed (${response.status} ${response.statusText})`)
    }

    const json = (await response.json()) as { results?: unknown }
    const results = Array.isArray(json.results) ? json.results : []
    return results.map((item) => {
      const record = item as Record<string, unknown>
      return {
        title: String(record.title ?? ''),
        url: String(record.url ?? ''),
        snippet: String(record.content ?? record.snippet ?? ''),
      }
    })
  }
}
