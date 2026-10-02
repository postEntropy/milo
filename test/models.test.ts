import { afterEach, describe, expect, it, vi } from 'vitest'
import { listModels, normalizeModels } from '../src/core/providers/models.js'

afterEach(() => vi.unstubAllGlobals())

describe('normalizeModels', () => {
  it('handles { data: [objects] }', () => {
    expect(normalizeModels({ data: [{ id: 'b' }, { id: 'a', name: 'A' }] })).toEqual([
      { id: 'a', name: 'A' },
      { id: 'b' },
    ])
  })

  it('handles { models: [strings] }', () => {
    expect(normalizeModels({ models: ['x', 'y'] }).map((model) => model.id)).toEqual(['x', 'y'])
  })

  it('handles a bare array and drops duplicates', () => {
    expect(normalizeModels(['a', 'a'])).toEqual([{ id: 'a' }])
  })

  it('prefers display_name and skips entries without an id', () => {
    expect(
      normalizeModels({ data: [{ id: 'm', display_name: 'Model M' }, { name: 'no id' }] }),
    ).toEqual([{ id: 'm', name: 'Model M' }])
  })

  it('reads how much a model holds, under any of the names a catalog uses', () => {
    // Command Code's own catalog answers `context_length`, and the shape is the
    // one the list shows beside the model.
    expect(
      normalizeModels({ data: [
        { id: 'a', context_length: 1_000_000 },
        { id: 'b', context_window: 128_000 },
        { id: 'c', context_size: '32768' },
        { id: 'd', top_provider: { context_length: 200_000 } },
      ] }),
    ).toEqual([
      { id: 'a', context: 1_000_000 },
      { id: 'b', context: 128_000 },
      { id: 'c', context: 32_768 },
      { id: 'd', context: 200_000 },
    ])
  })

  it('says nothing rather than zero when a catalog gives no size', () => {
    expect(normalizeModels({ data: [{ id: 'a' }, { id: 'b', context_length: 0 }, { id: 'c', context_length: 'unknown' }] }))
      .toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
  })
})

describe('listModels', () => {
  it('sends auth and normalizes the response', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ data: [{ id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash' }] }),
          { status: 200 },
        ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const models = await listModels({
      baseURL: 'https://api.commandcode.ai/provider/v1',
      apiKey: 'k',
      wire: 'auto',
    })

    expect(models).toEqual([{ id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash' }])
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.commandcode.ai/provider/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer k' }),
      }),
    )
  })

  it('throws on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })))
    await expect(
      listModels({ baseURL: 'https://x.test/v1', apiKey: false }),
    ).rejects.toThrow(/500/)
  })
})
