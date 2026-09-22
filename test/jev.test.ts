import { afterEach, describe, expect, it, vi } from 'vitest'
import { JevReviewer } from '../src/core/tools/jev'

afterEach(() => {
  vi.unstubAllGlobals()
})

const answering = (noul: number) =>
  vi.fn(
    async () =>
      new Response(JSON.stringify({ answers: { dangerous: { noul } } }), { status: 200 }),
  )

describe('JevReviewer', () => {
  it('posts a typed noul question and parses the probability', async () => {
    const fetchMock = answering(0.93)
    vi.stubGlobal('fetch', fetchMock)

    const reviewer = new JevReviewer({
      baseURL: 'https://api.commandcode.ai/provider/v1',
      apiKey: 'k',
    })
    const probability = await reviewer.review('Command to run:\nrm -rf /')

    expect(probability).toBeCloseTo(0.93)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.commandcode.ai/provider/v1/systemone',
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer k' }),
      }),
    )

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(body.model).toBe('typesafe/jev')
    expect(body.questions.dangerous.type).toBe('noul')
    expect(body.state).toContain('rm -rf /')
  })

  it('clamps out-of-range probabilities', async () => {
    vi.stubGlobal('fetch', answering(1.7))
    const reviewer = new JevReviewer({ baseURL: 'https://x.test/v1' })
    expect(await reviewer.review('s')).toBe(1)
  })

  it('serves identical states from the cache', async () => {
    const fetchMock = answering(0.1)
    vi.stubGlobal('fetch', fetchMock)

    const reviewer = new JevReviewer({ baseURL: 'https://x.test/v1' })
    await reviewer.review('same state')
    await reviewer.review('same state')

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('bypasses the cache when disabled', async () => {
    const fetchMock = answering(0.1)
    vi.stubGlobal('fetch', fetchMock)

    const reviewer = new JevReviewer({ baseURL: 'https://x.test/v1', cache: false })
    await reviewer.review('same state')
    await reviewer.review('same state')

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('throws on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })))
    await expect(new JevReviewer({ baseURL: 'https://x.test/v1' }).review('s')).rejects.toThrow(/401/)
  })

  it('throws when the answer carries no probability', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ answers: {} }), { status: 200 })),
    )
    await expect(new JevReviewer({ baseURL: 'https://x.test/v1' }).review('s')).rejects.toThrow(
      /no probability/,
    )
  })

  it('aborts instead of hanging when the request exceeds the timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(new Error('aborted')))
          }),
      ),
    )

    const reviewer = new JevReviewer({ baseURL: 'https://x.test/v1', timeoutMs: 20 })
    await expect(reviewer.review('slow')).rejects.toThrow()
  })
})
