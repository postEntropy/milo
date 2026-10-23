import { ExaSearchProvider } from './exa.js'
import { ParallelSearchProvider } from './parallel.js'
import { TavilySearchProvider } from './tavily.js'
import type { SearchConfig, SearchProvider } from './types.js'

export * from './types.js'

/** Returns null when no provider is configured or no key is available. */
export function createSearchProvider(
  config: SearchConfig | undefined,
  apiKey: string | undefined,
): SearchProvider | null {
  if (!config) return null
  const key = apiKey?.trim()
  if (!key) return null

  switch (config.provider) {
    case 'tavily':
      return new TavilySearchProvider(key)
    case 'exa':
      return new ExaSearchProvider({ apiKey: key })
    case 'parallel':
      return new ParallelSearchProvider({ apiKey: key })
    default:
      return null
  }
}
