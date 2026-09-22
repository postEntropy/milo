export interface SearchResult {
  title: string
  url: string
  snippet: string
  /** Publication date, when the engine reports one. */
  date?: string
}

export interface SearchOptions {
  maxResults?: number
  signal?: AbortSignal
}

export interface SearchProvider {
  readonly id: string
  search(query: string, opts?: SearchOptions): Promise<SearchResult[]>
}

export const SEARCH_PROVIDERS = ['tavily', 'exa', 'parallel'] as const
export type SearchProviderId = (typeof SEARCH_PROVIDERS)[number]

export interface SearchConfig {
  provider: SearchProviderId
  keyEnv?: string
}

export const DEFAULT_SEARCH_KEY_ENV: Record<SearchProviderId, string> = {
  tavily: 'TAVILY_API_KEY',
  exa: 'EXA_API_KEY',
  parallel: 'PARALLEL_API_KEY',
}
