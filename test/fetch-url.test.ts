import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../src/core/tools/types.js'

vi.mock('node:dns', () => ({
  lookup: (_hostname: string, _options: unknown, callback: (error: Error | null, addresses: { address: string; family: number }[]) => void) =>
    callback(null, [{ address: '93.184.216.34', family: 4 }]),
}))

// The store pages are kept in is Milo's own, so it is pointed at a scratch home
// for the run instead of the real one — set before the module reads it, which is
// why the import below is dynamic.
const home = mkdtempSync(path.join(os.tmpdir(), 'milo-fetch-'))
process.env.MILO_HOME = home

let fetchUrlTool: (typeof import('../src/core/tools/fetch-url.js'))['fetchUrlTool']
async function reloadFetchUrlTool(): Promise<void> {
  vi.resetModules()
  fetchUrlTool = (await import('../src/core/tools/fetch-url.js')).fetchUrlTool
}
await reloadFetchUrlTool()
const { prunePages } = await import('../src/core/fetched.js')
const { fetchedDir } = await import('../src/core/config/paths.js')

const ctx: ToolContext = { cwd: process.cwd(), signal: new AbortController().signal }

const respond = (
  body: string,
  init: { status?: number; type?: string; headers?: Record<string, string> } = {},
) =>
  new Response(body, {
    status: init.status ?? 200,
    headers: { 'content-type': init.type ?? 'text/html', ...init.headers },
  })

// One fresh Response per call: a body can only be read once.
const stubFetch = (
  body: string,
  init: { status?: number; type?: string; headers?: Record<string, string> } = {},
) => vi.stubGlobal('fetch', vi.fn(async () => respond(body, init)))

afterEach(() => vi.unstubAllGlobals())
beforeEach(async () => {
  await reloadFetchUrlTool()
  // The store on disk is shared across tests otherwise: wipe it between them.
  rmSync(fetchedDir(), { recursive: true, force: true })
})
afterAll(() => rmSync(home, { recursive: true, force: true }))

describe('fetch_url', () => {
  it('is read-only, and says the page is untrusted', () => {
    expect(fetchUrlTool.readOnly).toBe(true)
    expect(fetchUrlTool.description).toContain('untrusted')
  })

  it('turns an HTML page into text', async () => {
    stubFetch('<html><body><h1>Docs</h1><script>track()</script><p>Read me.</p></body></html>')

    const result = await fetchUrlTool.execute({ url: 'https://example.test/docs' }, ctx)

    expect(result.isError).toBeUndefined()
    expect(result.content).toBe('Docs\nRead me.')
  })

  it('returns JSON as it came', async () => {
    stubFetch('{"ok":true}', { type: 'application/json' })

    const result = await fetchUrlTool.execute({ url: 'https://example.test/api' }, ctx)

    expect(result.content).toBe('{"ok":true}')
  })

  it('refuses a protocol that is not http(s)', async () => {
    const result = await fetchUrlTool.execute({ url: 'file:///etc/passwd' }, ctx)

    expect(result.isError).toBe(true)
    expect(result.content).toContain('only http and https')
  })

  it('refuses loopback and private IP addresses before fetching', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchUrlTool.execute({ url: 'http://127.0.0.1/admin' }, ctx)

    expect(result.isError).toBe(true)
    expect(result.content).toContain('private or reserved network addresses')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses credentials embedded in a URL', async () => {
    const result = await fetchUrlTool.execute({ url: 'https://user:secret@example.test/' }, ctx)

    expect(result.isError).toBe(true)
    expect(result.content).toContain('embedded usernames or passwords')
  })

  it('says so when the URL does not parse', async () => {
    const result = await fetchUrlTool.execute({ url: 'not a url' }, ctx)

    expect(result.isError).toBe(true)
    expect(result.content).toContain('not a valid URL')
  })

  it('reports the status instead of returning an error page', async () => {
    stubFetch('<h1>Not found</h1>', { status: 404 })

    const result = await fetchUrlTool.execute({ url: 'https://example.test/gone' }, ctx)

    expect(result.isError).toBe(true)
    expect(result.content).toContain('404')
  })

  it('refuses a body that is not text', async () => {
    stubFetch('PNG', { type: 'image/png' })

    const result = await fetchUrlTool.execute({ url: 'https://example.test/pic.png' }, ctx)

    expect(result.isError).toBe(true)
    expect(result.content).toContain('image/png')
  })

  it('reports a network failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND')
      }),
    )

    const result = await fetchUrlTool.execute({ url: 'https://nope.test' }, ctx)

    expect(result.isError).toBe(true)
    expect(result.content).toContain('ENOTFOUND')
  })

  it('cuts a long page and names the offset that continues', async () => {
    stubFetch('x'.repeat(1200), { type: 'text/plain' })

    const first = await fetchUrlTool.execute(
      { url: 'https://example.test/long', limit: 1000 },
      ctx,
    )
    expect(first.content).toContain('200 more character(s); continue with offset=1000')

    const second = await fetchUrlTool.execute(
      { url: 'https://example.test/long', limit: 1000, offset: 1000 },
      ctx,
    )
    expect(second.content).toHaveLength(200)
  })

  it('says when the offset is past the end', async () => {
    stubFetch('short', { type: 'text/plain' })

    const result = await fetchUrlTool.execute({ url: 'https://example.test/t', offset: 99 }, ctx)

    expect(result.isError).toBe(true)
    expect(result.content).toContain('offset 99 is past the end')
  })

  it('refuses a response the server already declared too large', async () => {
    stubFetch('x', { headers: { 'content-length': String(6 * 1024 * 1024) } })

    const result = await fetchUrlTool.execute({ url: 'https://example.test/huge' }, ctx)

    expect(result.isError).toBe(true)
    expect(result.content).toContain('larger than 5 MB')
  })

  it('converts a page a server sent as text/plain', async () => {
    stubFetch('<!DOCTYPE html><p>hi</p>', { type: 'text/plain' })

    const result = await fetchUrlTool.execute({ url: 'https://example.test/plain' }, ctx)

    expect(result.content).toBe('hi')
  })

  it('stops a body that pours past the cap, and says so', async () => {
    // One chunk over the cap, and a body that never ends: without the cap this
    // read would sit waiting for the end (to the timeout) instead of answering.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(6 * 1024 * 1024)))
      },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { headers: { 'content-type': 'text/plain' } })),
    )

    const result = await fetchUrlTool.execute({ url: 'https://example.test/river' }, ctx)

    expect(result.content).toContain('cut off at 5 MB')
  })
})

describe('fetch_url page cache', () => {
  const doc = 'y'.repeat(60_000)

  it('serves the next window of a page without fetching it again', async () => {
    const fetchMock = vi.fn(async () => respond(doc, { type: 'text/plain' }))
    vi.stubGlobal('fetch', fetchMock)

    const first = await fetchUrlTool.execute(
      { url: 'https://example.test/doc', limit: 30_000 },
      ctx,
    )
    const second = await fetchUrlTool.execute(
      { url: 'https://example.test/doc', limit: 30_000, offset: 30_000 },
      ctx,
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(first.content).toContain('continue with offset=30000')
    expect(second.content).toHaveLength(30_000)
  })

  it('always fetches a fresh read, cached or not', async () => {
    const fetchMock = vi.fn(async () => respond('hello', { type: 'text/plain' }))
    vi.stubGlobal('fetch', fetchMock)

    await fetchUrlTool.execute({ url: 'https://example.test/now' }, ctx)
    await fetchUrlTool.execute({ url: 'https://example.test/now' }, ctx)

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('reads but does not keep a page too big to hold', async () => {
    const fetchMock = vi.fn(async () => respond('z'.repeat(1_500_000), { type: 'text/plain' }))
    vi.stubGlobal('fetch', fetchMock)

    await fetchUrlTool.execute({ url: 'https://example.test/wide' }, ctx)
    await fetchUrlTool.execute({ url: 'https://example.test/wide', offset: 1000 }, ctx)

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('keeps a page on disk, so a later window survives the memory cache', async () => {
    const fetchMock = vi.fn(async () => respond(doc, { type: 'text/plain' }))
    vi.stubGlobal('fetch', fetchMock)

    const first = await fetchUrlTool.execute(
      { url: 'https://example.test/kept', limit: 30_000 },
      ctx,
    )
    // As if the process had restarted: the memory cache is empty, the file is not.
    await reloadFetchUrlTool()
    const second = await fetchUrlTool.execute(
      { url: 'https://example.test/kept', limit: 30_000, offset: 30_000 },
      ctx,
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(first.content).toContain('continue with offset=30000')
    expect(second.content).toHaveLength(30_000)
  })

  it('reads a page again once the store has dropped it', async () => {
    const fetchMock = vi.fn(async (input: string | URL) =>
      respond(`page of ${String(input)}`, { type: 'text/plain' }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await fetchUrlTool.execute({ url: 'https://example.test/gone' }, ctx)
    await reloadFetchUrlTool()
    prunePages(0) // nothing is kept: the file is gone too
    await fetchUrlTool.execute({ url: 'https://example.test/gone', offset: 5 }, ctx)

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

/** A real socket, for the part a stubbed fetch cannot vouch for. */
describe('fetch_url over a real connection', () => {
  let server: Server
  let base: string

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<title>Local</title><p>served for real</p>')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    base = `http://127.0.0.1:${port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('refuses a private address before opening a connection', async () => {
    const result = await fetchUrlTool.execute({ url: `${base}/page` }, ctx)

    expect(result.isError).toBe(true)
    expect(result.content).toContain('private or reserved network addresses')
  })
})
