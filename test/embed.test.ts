import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createOllama, createOpenAiEmbeddings, InputRefusedError } from '../src/core/memory/embed.js'

let open: Server | null = null

afterEach(() => {
  open?.close()
  open = null
})

interface Call {
  url?: string
  method?: string
  auth?: string
  body: { model?: string; input?: unknown }
}

/** A stand-in for a provider, answering only the route this client uses. */
async function fakeProvider(
  answer: (call: Call) => { status: number; body: unknown },
): Promise<{ url: string; calls: Call[] }> {
  const calls: Call[] = []
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk: Buffer) => {
      raw += chunk.toString()
    })
    request.on('end', () => {
      const call: Call = {
        url: request.url,
        method: request.method,
        auth: request.headers.authorization,
        body: JSON.parse(raw || '{}'),
      }
      calls.push(call)
      const result = answer(call)
      response.writeHead(result.status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(result.body))
    })
  })
  open = server
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return { url: `http://127.0.0.1:${port}`, calls }
}

describe('the Ollama embedder', () => {
  it('sends the whole batch in one request and returns unit vectors', async () => {
    const ollama = await fakeProvider(() => ({ status: 200, body: { embeddings: [[3, 4], [0, 2]] } }))
    const embedder = createOllama({ url: ollama.url, model: 'bge-m3' })

    const vectors = await embedder.embed(['um', 'dois'])

    expect(ollama.calls).toHaveLength(1)
    expect(ollama.calls[0]!.url).toBe('/api/embed')
    expect(ollama.calls[0]!.method).toBe('POST')
    expect(ollama.calls[0]!.body).toEqual({ model: 'bge-m3', input: ['um', 'dois'] })
    // Normalized on the way in, so every later comparison is a dot product.
    expect([...vectors[0]!].map((value) => Number(value.toFixed(4)))).toEqual([0.6, 0.8])
    expect([...vectors[1]!].map((value) => Number(value.toFixed(4)))).toEqual([0, 1])
  })

  it('asks for nothing when there is nothing to embed', async () => {
    const ollama = await fakeProvider(() => ({ status: 200, body: { embeddings: [] } }))
    const embedder = createOllama({ url: ollama.url, model: 'bge-m3' })

    expect(await embedder.embed([])).toEqual([])
    expect(ollama.calls).toHaveLength(0)
  })

  it('says what the engine answered when it refuses', async () => {
    const ollama = await fakeProvider(() => ({ status: 404, body: { error: 'model not found' } }))
    const embedder = createOllama({ url: ollama.url, model: 'nope' })

    await expect(embedder.embed(['um'])).rejects.toThrow(/404/)
  })

  it('refuses a reply that does not match what was asked', async () => {
    const ollama = await fakeProvider(() => ({ status: 200, body: { embeddings: [[1, 0]] } }))
    const embedder = createOllama({ url: ollama.url, model: 'bge-m3' })

    // One vector for two texts would silently shift every vector by one note.
    await expect(embedder.embed(['um', 'dois'])).rejects.toThrow(/1 vectors for 2 texts/)
  })
})

describe('the hosted embedder', () => {
  it('sends the key and reads the OpenAI-shaped reply', async () => {
    const provider = await fakeProvider(() => ({ status: 200, body: { data: [{ embedding: [0, 5] }] } }))
    const embedder = createOpenAiEmbeddings({
      url: `${provider.url}/v1`,
      model: 'liquid/lfm-2.5-embedding-350m:free',
      apiKey: 'sk-or-test',
    })

    const vectors = await embedder.embed(['uma nota'])

    expect(provider.calls[0]!.url).toBe('/v1/embeddings')
    expect(provider.calls[0]!.method).toBe('POST')
    expect(provider.calls[0]!.auth).toBe('Bearer sk-or-test')
    expect(provider.calls[0]!.body).toEqual({
      model: 'liquid/lfm-2.5-embedding-350m:free',
      input: ['uma nota'],
    })
    expect([...vectors[0]!]).toEqual([0, 1])
  })

  it('refuses a shorter reply, which would misalign every note', async () => {
    const provider = await fakeProvider(() => ({ status: 200, body: { data: [{ embedding: [1, 0] }] } }))
    const embedder = createOpenAiEmbeddings({
      url: provider.url,
      model: 'm',
      apiKey: 'sk-or-test',
    })

    await expect(embedder.embed(['um', 'dois'])).rejects.toThrow(/1 vectors for 2 texts/)
  })

  it('reports what the provider said when it refuses', async () => {
    const provider = await fakeProvider(() => ({ status: 401, body: { error: { message: 'no key' } } }))
    const embedder = createOpenAiEmbeddings({ url: provider.url, model: 'm', apiKey: 'bad' })

    await expect(embedder.embed(['um'])).rejects.toThrow(/401/)
  })

  it('says when the input itself is what was refused', async () => {
    // The store writes off a note the model will not take, and retries anything
    // else — so this distinction is the difference between losing a note to a
    // slow start and leaving one behind that can never be embedded.
    const provider = await fakeProvider(() => ({
      status: 400,
      body: { error: { message: 'Embedding input has 1803 tokens, exceeding the model maximum of 512.' } },
    }))
    const embedder = createOpenAiEmbeddings({ url: provider.url, model: 'm', apiKey: 'k' })

    await expect(embedder.embed(['um'])).rejects.toThrow(InputRefusedError)
  })
})
