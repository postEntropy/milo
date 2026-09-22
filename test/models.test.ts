import { afterEach, describe, expect, it, vi } from 'vitest'
import { listModels, normalizeModels } from '../src/core/providers/models'

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
