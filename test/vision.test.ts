import { afterEach, describe, expect, it, vi } from 'vitest'
import { lookupVisionSupport } from '../src/core/providers/vision.js'

afterEach(() => vi.unstubAllGlobals())

describe('vision capability lookup', () => {
  it('uses the provider catalog when it explicitly lists image input', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [
      { id: 'vision-model', architecture: { input_modalities: ['text', 'image'] } },
    ] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const support = await lookupVisionSupport({ id: 'custom-vision-test', baseURL: 'https://vision-test.example/v1', apiKey: false }, 'vision-model')

    expect(support).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('uses OpenRouter metadata when the provider does not publish modalities', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'gpt-vision' }] }), { status: 200 })
      return new Response(JSON.stringify({ data: { id: 'openai/gpt-vision', architecture: { input_modalities: ['text', 'image'] } } }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const support = await lookupVisionSupport({ id: 'openai', baseURL: 'https://openai-vision-test.example/v1', apiKey: false }, 'gpt-vision')

    expect(support).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith('https://openrouter.ai/api/v1/models/openai/gpt-vision', expect.any(Object))
  })

  it('leaves capability unknown when neither catalog reports it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })))

    const support = await lookupVisionSupport({ id: 'custom-unknown-test', baseURL: 'https://unknown-test.example/v1', apiKey: false }, 'model-without-metadata')

    expect(support).toBeUndefined()
  })
})
