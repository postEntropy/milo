import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveSearchKey } from '../src/core/config/load.js'
import { createSearchProvider } from '../src/core/search/index.js'
import { ExaSearchProvider } from '../src/core/search/exa.js'
import { keyWords, ParallelSearchProvider } from '../src/core/search/parallel.js'
import { TavilySearchProvider } from '../src/core/search/tavily.js'
import { createWebSearchTool } from '../src/core/tools/web-search.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

const ctx = { cwd: process.cwd(), signal: new AbortController().signal }

const replying = (body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))

const bodyOf = (fetchMock: ReturnType<typeof vi.fn>, call = 0) =>
  JSON.parse(String(fetchMock.mock.calls[call]?.[1]?.body))

describe('TavilySearchProvider', () => {
  it('maps results and sends the key', async () => {
    const fetchMock = replying({ results: [{ title: 'T', url: 'https://x', content: 'snip' }] })
    vi.stubGlobal('fetch', fetchMock)

    const results = await new TavilySearchProvider('k').search('hello', { maxResults: 3 })

    expect(results).toEqual([{ title: 'T', url: 'https://x', snippet: 'snip' }])
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.tavily.com/search',
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer k' }),
      }),
    )
  })

  it('throws on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 429 })))
    await expect(new TavilySearchProvider('k').search('x')).rejects.toThrow(/429/)
  })
})

describe('ExaSearchProvider', () => {
  it('asks for fast search with highlights and page text', async () => {
    const fetchMock = replying({ results: [] })
    vi.stubGlobal('fetch', fetchMock)

    await new ExaSearchProvider({ apiKey: 'k' }).search('bun runtime', { maxResults: 4 })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.exa.ai/search',
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-api-key': 'k' }),
      }),
    )

    const body = bodyOf(fetchMock)
    expect(body.query).toBe('bun runtime')
    expect(body.numResults).toBe(4)
    expect(body.type).toBe('fast')
    expect(body.contents).toEqual({ text: true, highlights: true })
  })

  it('prefers the highlighted passages and keeps the date', async () => {
    vi.stubGlobal(
      'fetch',
      replying({
        results: [
          {
            title: 'Docs',
            url: 'https://docs.test/bun',
            publishedDate: '2026-08-01T00:00:00.000Z',
            highlights: ['Bun starts 4x faster', 'and bundles TypeScript'],
            text: 'the whole page, which is much longer than the highlights',
          },
        ],
      }),
    )

    const [result] = (await new ExaSearchProvider({ apiKey: 'k' }).search('q')) as [
      NonNullable<Awaited<ReturnType<ExaSearchProvider['search']>>[number]>,
    ]

    expect(result.title).toBe('Docs')
    expect(result.snippet).toBe('Bun starts 4x faster … and bundles TypeScript')
    expect(result.date).toBe('2026-08-01T00:00:00.000Z')
  })

  it('falls back to the page text when there are no highlights', async () => {
    vi.stubGlobal(
      'fetch',
      replying({ results: [{ title: 'T', url: 'https://x.test', text: 'page  body\n\ntext' }] }),
    )
    const [result] = (await new ExaSearchProvider({ apiKey: 'k' }).search('q')) as [
      NonNullable<Awaited<ReturnType<ExaSearchProvider['search']>>[number]>,
    ]
    expect(result.snippet).toBe('page body text')
  })

  it('skips entries with no url and reports failures', async () => {
    vi.stubGlobal('fetch', replying({ results: [{ title: 'no url' }] }))
    expect(await new ExaSearchProvider({ apiKey: 'k' }).search('q')).toEqual([])

    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 402 })))
    await expect(new ExaSearchProvider({ apiKey: 'k' }).search('q')).rejects.toThrow(/402/)
  })
})

describe('ParallelSearchProvider', () => {
  it('sends the objective, keyword query, mode and result cap', async () => {
    const fetchMock = replying({ results: [] })
    vi.stubGlobal('fetch', fetchMock)

    await new ParallelSearchProvider({ apiKey: 'k' }).search('what is the new deepseek model', {
      maxResults: 7,
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.parallel.ai/v1/search',
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-api-key': 'k' }),
      }),
    )

    const body = bodyOf(fetchMock)
    expect(body.objective).toBe('what is the new deepseek model')
    expect(body.search_queries).toEqual(['new deepseek model'])
    // Without this the API defaults to `advanced`, about 3s per search.
    expect(body.mode).toBe('fast')
    expect(body.advanced_settings).toEqual({ max_results: 7 })
  })

  it('joins the excerpts and keeps the publish date', async () => {
    vi.stubGlobal(
      'fetch',
      replying({
        results: [
          {
            url: 'https://news.test/a',
            title: 'News',
            publish_date: '2026-09-01',
            excerpts: ['first  excerpt', 'second excerpt'],
          },
        ],
      }),
    )

    const results = await new ParallelSearchProvider({ apiKey: 'k' }).search('q')
    expect(results).toEqual([
      {
        title: 'News',
        url: 'https://news.test/a',
        snippet: 'first excerpt second excerpt',
        date: '2026-09-01',
      },
    ])
  })

  it('throws on a failed request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 422 })))
    await expect(new ParallelSearchProvider({ apiKey: 'k' }).search('q')).rejects.toThrow(/422/)
  })
})

describe('keyWords', () => {
  it('turns a question into a few keywords', () => {
    expect(keyWords('what is the new deepseek model')).toBe('new deepseek model')
    expect(keyWords('como configurar o Ollama no Windows')).toBe('configurar Ollama Windows')
  })

  it('caps the query length', () => {
    expect(keyWords('alpha beta gamma delta epsilon zeta eta theta').split(' ')).toHaveLength(6)
  })

  it('keeps the query when every word is a stop word', () => {
    expect(keyWords('o que é')).toBe('o que é')
  })
})

describe('resolveSearchKey', () => {
  const auth = {
    providers: {},
    gateways: {},
    search: { tavily: 'tvly-stored', exa: 'exa-stored' },
  }

  it('reads the key of the selected provider, never another one', () => {
    expect(resolveSearchKey({ provider: 'exa' }, auth)).toBe('exa-stored')
    expect(resolveSearchKey({ provider: 'tavily' }, auth)).toBe('tvly-stored')
    expect(resolveSearchKey({ provider: 'parallel' }, auth)).toBeUndefined()
    expect(resolveSearchKey(undefined, auth)).toBeUndefined()
  })

  it('prefers the environment and honours a custom variable name', () => {
    process.env.MILO_TEST_SEARCH_KEY = '  from-env  '
    try {
      expect(resolveSearchKey({ provider: 'exa', keyEnv: 'MILO_TEST_SEARCH_KEY' }, auth)).toBe(
        'from-env',
      )
    } finally {
      delete process.env.MILO_TEST_SEARCH_KEY
    }
  })
})

describe('createSearchProvider', () => {
  it('needs both a config and a key', () => {
    expect(createSearchProvider(undefined, 'k')).toBeNull()
    expect(createSearchProvider({ provider: 'tavily' }, undefined)).toBeNull()
    expect(createSearchProvider({ provider: 'tavily' }, 'k')?.id).toBe('tavily')
    expect(createSearchProvider({ provider: 'exa' }, 'k')?.id).toBe('exa')
    expect(createSearchProvider({ provider: 'parallel' }, 'k')?.id).toBe('parallel')
  })
})

describe('web_search tool', () => {
  it('formats results as a numbered list, with the date when there is one', async () => {
    const tool = createWebSearchTool({
      id: 'fake',
      search: async () => [{ title: 'A', url: 'https://a', snippet: 's', date: '2026-09-01' }],
    })
    const result = await tool.execute({ query: 'x' }, ctx)
    expect(result.content).toContain('1. A (2026-09-01)')
    expect(result.content).toContain('https://a')
  })

  it('reports failures as tool errors', async () => {
    const tool = createWebSearchTool({
      id: 'fake',
      search: async () => {
        throw new Error('boom')
      },
    })
    const result = await tool.execute({ query: 'x' }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('boom')
  })

  it('is read-only', () => {
    expect(createWebSearchTool({ id: 'fake', search: async () => [] }).readOnly).toBe(true)
  })
})
