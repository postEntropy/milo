import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../src/core/tools/types.js'

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>()
  return {
    ...actual,
    fetch: (input: Parameters<typeof actual.fetch>[0], init?: Parameters<typeof actual.fetch>[1]) => {
      const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (target.startsWith('http://127.0.0.1:')) return actual.fetch(input, init)
      return globalThis.fetch(...([input, init] as Parameters<typeof globalThis.fetch>))
    },
  }
})

vi.mock('node:dns', () => ({
  lookup: (
    _hostname: string,
    _options: unknown,
    callback: (error: Error | null, addresses: { address: string; family: number }[]) => void,
  ) => callback(null, [{ address: '93.184.216.34', family: 4 }]),
}))

const ctx: ToolContext = { cwd: process.cwd(), signal: new AbortController().signal }

const prevEnv = {
  MILO_HOME: process.env.MILO_HOME,
  HOME: process.env.HOME,
  PATH: process.env.PATH,
  FIRECRAWL_CLOUD: process.env.FIRECRAWL_CLOUD,
  FIRECRAWL_API_KEY: process.env.FIRECRAWL_API_KEY,
  FIRECRAWL_API_URL: process.env.FIRECRAWL_API_URL,
  FIRECRAWL_LOCAL_ALLOW_PRIVATE: process.env.FIRECRAWL_LOCAL_ALLOW_PRIVATE,
  FIRECRAWL_LOCAL_TOKEN: process.env.FIRECRAWL_LOCAL_TOKEN,
}

const root = mkdtempSync(path.join(os.tmpdir(), 'milo-firecrawl-test-'))
const miloHome = path.join(root, 'milo')
const binDir = path.join(root, 'bin')
const cargoBinDir = path.join(root, '.cargo', 'bin')
const stateFile = path.join(root, 'state.json')
const pidFile = path.join(root, 'child.pid')
const recordFile = path.join(root, 'invocations.jsonl')

let fetchUrlTool: (typeof import('../src/core/tools/fetch-url.js'))['fetchUrlTool']

async function reloadTools(): Promise<void> {
  vi.resetModules()
  fetchUrlTool = (await import('../src/core/tools/fetch-url.js')).fetchUrlTool
}

function writeFakeBinary(dir: string, behavior: 'server' | 'crash' = 'server'): string {
  const script = path.join(dir, 'firecrawl-local')
  if (behavior === 'crash') {
    writeFileSync(script, '#!/bin/sh\necho "boom" >&2\nexit 1\n')
    chmodSync(script, 0o755)
    return script
  }

  // Node mock server implementing Firecrawl Local's /health and /v2/scrape.
  const body = `#!/usr/bin/env node
const fs = require('node:fs')
const http = require('node:http')

const args = process.argv.slice(2)
const portIdx = args.indexOf('--port')
const hostIdx = args.indexOf('--host')
const port = Number(args[portIdx + 1])
const host = args[hostIdx + 1]
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))

const envSnapshot = {
  args,
  FIRECRAWL_CLOUD: process.env.FIRECRAWL_CLOUD ?? null,
  FIRECRAWL_API_KEY: process.env.FIRECRAWL_API_KEY ?? null,
  FIRECRAWL_API_URL: process.env.FIRECRAWL_API_URL ?? null,
  FIRECRAWL_LOCAL_ALLOW_PRIVATE: process.env.FIRECRAWL_LOCAL_ALLOW_PRIVATE ?? null,
  FIRECRAWL_LOCAL_TOKEN: process.env.FIRECRAWL_LOCAL_TOKEN ?? null,
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    const next = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, 'utf8'))
    if (next.health) {
      send(res, next.health)
    } else {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', engine: 'firecrawl-local', version: '0.1.0' }))
    }
    return
  }
  if (req.method === 'POST' && req.url === '/v2/scrape') {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const reqBody = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      fs.appendFileSync(${JSON.stringify(recordFile)}, JSON.stringify({ envSnapshot, reqBody }) + '\\n')
      const next = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, 'utf8'))
      if (next.delayMs) {
        setTimeout(() => send(res, next), next.delayMs)
      } else {
        send(res, next)
      }
    })
    return
  }
  res.writeHead(404).end()
})

function send(res, next) {
  res.writeHead(next.httpStatus ?? 200, {
    'content-type': next.contentType ?? 'application/json',
    ...(next.headers ?? {}),
  })
  res.end(typeof next.body === 'string' ? next.body : JSON.stringify(next.body))
}

server.listen(port, host)
process.on('SIGTERM', () => server.close(() => process.exit(0)))
setTimeout(() => process.exit(0), 15000).unref()
`
  writeFileSync(script, body)
  chmodSync(script, 0o755)
  return script
}

interface MockEndpointSpec {
  httpStatus?: number
  contentType?: string
  headers?: Record<string, string>
  body: unknown
  delayMs?: number
}

function setScrapeResponse(spec: MockEndpointSpec & { health?: MockEndpointSpec }) {
  writeFileSync(stateFile, JSON.stringify(spec))
}

function killMockChild(): void {
  try {
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    if (Number.isFinite(pid) && pid > 0) process.kill(pid, 'SIGTERM')
  } catch {
    // Already gone.
  }
  rmSync(pidFile, { force: true })
}

function readRecords(): Array<{ envSnapshot: Record<string, unknown>; reqBody: Record<string, unknown> }> {
  try {
    return readFileSync(recordFile, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

function stubOrigin(body: string, init: { status?: number; type?: string; headers?: Record<string, string> } = {}) {
  const mock = vi.fn(
    async () =>
      new Response(body, {
        status: init.status ?? 200,
        headers: { 'content-type': init.type ?? 'text/html; charset=utf-8', ...init.headers },
      }),
  )
  vi.stubGlobal('fetch', mock)
  return mock
}

beforeEach(async () => {
  rmSync(miloHome, { recursive: true, force: true })
  rmSync(binDir, { recursive: true, force: true })
  rmSync(cargoBinDir, { recursive: true, force: true })
  rmSync(recordFile, { force: true })
  killMockChild()

  process.env.MILO_HOME = miloHome
  process.env.HOME = root
  process.env.PATH = `${binDir}${path.delimiter}${path.dirname(process.execPath)}`
  process.env.FIRECRAWL_CLOUD = 'auto'
  process.env.FIRECRAWL_API_KEY = 'fc-secret-should-not-leak'
  process.env.FIRECRAWL_API_URL = 'https://api.firecrawl.dev'
  process.env.FIRECRAWL_LOCAL_ALLOW_PRIVATE = '1'
  process.env.FIRECRAWL_LOCAL_TOKEN = 'secret-token'

  setScrapeResponse({
    body: {
      success: true,
      data: {
        markdown: '# Rendered\n\nClean markdown from Firecrawl.',
        metadata: { statusCode: 200, engine: 'local-browser' },
        source: 'local',
      },
    },
  })
  await reloadTools()
})

afterEach(() => {
  vi.unstubAllGlobals()
  killMockChild()
})

afterAll(() => {
  killMockChild()
  process.env.MILO_HOME = prevEnv.MILO_HOME
  process.env.HOME = prevEnv.HOME
  process.env.PATH = prevEnv.PATH
  process.env.FIRECRAWL_CLOUD = prevEnv.FIRECRAWL_CLOUD
  process.env.FIRECRAWL_API_KEY = prevEnv.FIRECRAWL_API_KEY
  process.env.FIRECRAWL_API_URL = prevEnv.FIRECRAWL_API_URL
  process.env.FIRECRAWL_LOCAL_ALLOW_PRIVATE = prevEnv.FIRECRAWL_LOCAL_ALLOW_PRIVATE
  process.env.FIRECRAWL_LOCAL_TOKEN = prevEnv.FIRECRAWL_LOCAL_TOKEN
  rmSync(root, { recursive: true, force: true })
})

describe('fetch_url with Firecrawl Local', () => {
  it('forces FIRECRAWL_CLOUD=off, strips cloud/private env vars, and scrapes HTML pages as markdown', async () => {
    const { mkdirSync } = await import('node:fs')
    mkdirSync(binDir, { recursive: true })
    writeFakeBinary(binDir)
    stubOrigin('<html><body><div id="app"></div><script>render()</script></body></html>')

    const result = await fetchUrlTool.execute({ url: 'https://example.test/app' }, ctx)

    expect(result.isError).toBeUndefined()
    expect(result.content).toBe('# Rendered\n\nClean markdown from Firecrawl.')

    const records = readRecords()
    expect(records).toHaveLength(1)
    const { envSnapshot, reqBody } = records[0]!
    expect(envSnapshot.FIRECRAWL_CLOUD).toBe('off')
    expect(envSnapshot.FIRECRAWL_API_KEY).toBeNull()
    expect(envSnapshot.FIRECRAWL_API_URL).toBeNull()
    expect(envSnapshot.FIRECRAWL_LOCAL_ALLOW_PRIVATE).toBeNull()
    expect(envSnapshot.FIRECRAWL_LOCAL_TOKEN).toBeNull()
    expect(envSnapshot.args).toContain('serve')
    expect(envSnapshot.args).toContain('127.0.0.1')
    expect(envSnapshot.args).not.toContain('--allow-private')
    expect(reqBody.url).toBe('https://example.test/app')
    expect(reqBody.formats).toEqual(['markdown'])
    expect((reqBody.headers as Record<string, string>).Accept).toContain('text/html')
  })

  it('discovers firecrawl-local in ~/.cargo/bin even when it is not on PATH', async () => {
    const { mkdirSync } = await import('node:fs')
    mkdirSync(cargoBinDir, { recursive: true })
    writeFakeBinary(cargoBinDir)
    stubOrigin('<html><body><h1>Hello</h1></body></html>')

    const result = await fetchUrlTool.execute({ url: 'https://example.test/cargo' }, ctx)

    expect(result.isError).toBeUndefined()
    expect(result.content).toBe('# Rendered\n\nClean markdown from Firecrawl.')
    expect(readRecords()).toHaveLength(1)
  })

  it('preserves native reading for JSON and plain text without calling Firecrawl', async () => {
    const { mkdirSync } = await import('node:fs')
    mkdirSync(binDir, { recursive: true })
    writeFakeBinary(binDir)

    stubOrigin('{"ok":true}', { type: 'application/json' })
    const jsonResult = await fetchUrlTool.execute({ url: 'https://example.test/api.json' }, ctx)
    expect(jsonResult.isError).toBeUndefined()
    expect(jsonResult.content).toBe('{"ok":true}')

    stubOrigin('plain text line', { type: 'text/plain' })
    const textResult = await fetchUrlTool.execute({ url: 'https://example.test/notes.txt' }, ctx)
    expect(textResult.isError).toBeUndefined()
    expect(textResult.content).toBe('plain text line')

    expect(readRecords()).toHaveLength(0)
  })

  it('preserves pagination and memory/disk cache for scraped pages', async () => {
    const { mkdirSync } = await import('node:fs')
    mkdirSync(binDir, { recursive: true })
    writeFakeBinary(binDir)

    const longMarkdown = `# Long\n\n${'a'.repeat(1200)}`
    setScrapeResponse({
      body: {
        success: true,
        data: { markdown: longMarkdown, metadata: { statusCode: 200 }, source: 'local' },
      },
    })
    const originMock = stubOrigin('<html><body>long</body></html>')

    const first = await fetchUrlTool.execute({ url: 'https://example.test/long', limit: 1000 }, ctx)
    expect(first.isError).toBeUndefined()
    expect(first.content).toContain(`continue with offset=1000`)

    // Second window comes from memory cache — neither origin nor Firecrawl runs again.
    const second = await fetchUrlTool.execute({ url: 'https://example.test/long', limit: 1000, offset: 1000 }, ctx)
    expect(second.isError).toBeUndefined()
    expect(second.content).toBe('a'.repeat(longMarkdown.length - 1000))

    // After a restart (empty memory cache), disk cache still serves the next window.
    await reloadTools()
    const third = await fetchUrlTool.execute({ url: 'https://example.test/long', limit: 1000, offset: 1000 }, ctx)
    expect(third.isError).toBeUndefined()
    expect(third.content).toBe('a'.repeat(longMarkdown.length - 1000))

    expect(originMock).toHaveBeenCalledTimes(1)
    expect(readRecords()).toHaveLength(1)
  })

  it('rejects non-local (cloud) scrape responses explicitly', async () => {
    const { mkdirSync } = await import('node:fs')
    mkdirSync(binDir, { recursive: true })
    writeFakeBinary(binDir)
    stubOrigin('<html><body>hello</body></html>')
    setScrapeResponse({
      body: {
        success: true,
        data: { markdown: 'from cloud', metadata: { statusCode: 200 }, source: 'firecrawl-cloud' },
      },
    })

    const result = await fetchUrlTool.execute({ url: 'https://example.test/cloud' }, ctx)

    expect(result.isError).toBe(true)
    expect(result.content).toContain('non-local source')
  })

  it('reports Firecrawl extraction failures, blocked pages, and embedded HTTP errors explicitly', async () => {
    const { mkdirSync } = await import('node:fs')
    mkdirSync(binDir, { recursive: true })
    writeFakeBinary(binDir)
    stubOrigin('<html><body>hello</body></html>')

    setScrapeResponse({
      body: { success: false, code: 'FETCH_FAILED', error: 'DNS lookup failed' },
    })
    const failed = await fetchUrlTool.execute({ url: 'https://example.test/fail' }, ctx)
    expect(failed.isError).toBe(true)
    expect(failed.content).toContain('DNS lookup failed')

    setScrapeResponse({
      body: {
        success: true,
        data: {
          markdown: '',
          blocked: true,
          warning: 'Blocked by target site',
          metadata: { statusCode: 200 },
          source: 'local',
        },
      },
    })
    const blocked = await fetchUrlTool.execute({ url: 'https://example.test/blocked' }, ctx)
    expect(blocked.isError).toBe(true)
    expect(blocked.content).toContain('Blocked by target site')

    setScrapeResponse({
      body: {
        success: true,
        data: { markdown: '# Not Found', metadata: { statusCode: 404 }, source: 'local' },
      },
    })
    const notFound = await fetchUrlTool.execute({ url: 'https://example.test/missing' }, ctx)
    expect(notFound.isError).toBe(true)
    expect(notFound.content).toContain('404')
  })

  it('reports startup failures explicitly when the binary crashes', async () => {
    const { mkdirSync } = await import('node:fs')
    mkdirSync(binDir, { recursive: true })
    writeFakeBinary(binDir, 'crash')
    stubOrigin('<html><body>hello</body></html>')

    const result = await fetchUrlTool.execute({ url: 'https://example.test/crash' }, ctx)

    expect(result.isError).toBe(true)
    expect(result.content).toContain('firecrawl-local exited on startup')
  })

  it('refuses private addresses and oversized/binary responses before calling Firecrawl', async () => {
    const { mkdirSync } = await import('node:fs')
    mkdirSync(binDir, { recursive: true })
    writeFakeBinary(binDir)

    const priv = await fetchUrlTool.execute({ url: 'http://127.0.0.1:3002/health' }, ctx)
    expect(priv.isError).toBe(true)
    expect(priv.content).toContain('private or reserved network addresses')

    stubOrigin('PNG', { type: 'image/png' })
    const img = await fetchUrlTool.execute({ url: 'https://example.test/pic.png' }, ctx)
    expect(img.isError).toBe(true)
    expect(img.content).toContain('image/png')

    stubOrigin('x', { headers: { 'content-length': String(6 * 1024 * 1024) } })
    const huge = await fetchUrlTool.execute({ url: 'https://example.test/huge' }, ctx)
    expect(huge.isError).toBe(true)
    expect(huge.content).toContain('larger than 5 MB')

    expect(readRecords()).toHaveLength(0)
  })

  it('aborts cleanly when the caller signal cancels an in-flight scrape', async () => {
    const { mkdirSync } = await import('node:fs')
    mkdirSync(binDir, { recursive: true })
    writeFakeBinary(binDir)
    stubOrigin('<html><body>slow</body></html>')
    setScrapeResponse({
      delayMs: 2_000,
      body: {
        success: true,
        data: { markdown: 'late', metadata: { statusCode: 200 }, source: 'local' },
      },
    })

    const controller = new AbortController()
    setTimeout(() => controller.abort(new Error('cancelled by user')), 120)

    const result = await fetchUrlTool.execute(
      { url: 'https://example.test/slow' },
      { cwd: process.cwd(), signal: controller.signal },
    )

    expect(result.isError).toBe(true)
    expect(result.content).toContain('Failed to fetch')
  })

  it('caps scraped markdown above 5 MB and rejects oversized Firecrawl payloads', async () => {
    const { mkdirSync } = await import('node:fs')
    mkdirSync(binDir, { recursive: true })
    writeFakeBinary(binDir)
    stubOrigin('<html><body>huge</body></html>')

    setScrapeResponse({
      body: {
        success: true,
        data: { markdown: 'x'.repeat(5 * 1024 * 1024 + 50), metadata: { statusCode: 200 }, source: 'local' },
      },
    })
    const capped = await fetchUrlTool.execute({ url: 'https://example.test/big-md' }, ctx)
    expect(capped.isError).toBeUndefined()
    expect(capped.content).toContain('cut off at 5 MB')

    setScrapeResponse({
      body: {
        success: true,
        data: { markdown: 'x'.repeat(10 * 1024 * 1024 + 100), metadata: { statusCode: 200 }, source: 'local' },
      },
    })
    const oversized = await fetchUrlTool.execute({ url: 'https://example.test/too-big' }, ctx)
    expect(oversized.isError).toBe(true)
    expect(oversized.content).toContain('exceeded the size limit')
  })

  it('does not spawn firecrawl-local when the caller signal is already aborted', async () => {
    const { existsSync, mkdirSync } = await import('node:fs')
    mkdirSync(binDir, { recursive: true })
    writeFakeBinary(binDir)
    stubOrigin('<html><body>hello</body></html>')

    const controller = new AbortController()
    controller.abort(new Error('already aborted'))

    const result = await fetchUrlTool.execute(
      { url: 'https://example.test/aborted' },
      { cwd: process.cwd(), signal: controller.signal },
    )

    expect(result.isError).toBe(true)
    expect(existsSync(pidFile)).toBe(false)
  })

  it('restarts the local server on the next call if the child process dies', async () => {
    const { mkdirSync } = await import('node:fs')
    mkdirSync(binDir, { recursive: true })
    writeFakeBinary(binDir)
    stubOrigin('<html><body>hello</body></html>')

    const first = await fetchUrlTool.execute({ url: 'https://example.test/one' }, ctx)
    expect(first.isError).toBeUndefined()

    const firstPid = Number(readFileSync(pidFile, 'utf8').trim())
    killMockChild()
    // Give the OS a moment to reap the child before the next call.
    await new Promise((resolve) => setTimeout(resolve, 60))

    const second = await fetchUrlTool.execute({ url: 'https://example.test/two' }, ctx)
    expect(second.isError).toBeUndefined()
    const secondPid = Number(readFileSync(pidFile, 'utf8').trim())
    expect(secondPid).not.toBe(firstPid)
  })

  it('caps multibyte UTF-8 markdown at 5 MiB without splitting a sequence and keeps char pagination', async () => {
    const { mkdirSync } = await import('node:fs')
    mkdirSync(binDir, { recursive: true })
    writeFakeBinary(binDir)
    stubOrigin('<html><body>multibyte</body></html>')

    // 2,000,000 chars (< 5M chars) * 3 UTF-8 bytes/char = 6,000,000 bytes (> 5 MiB).
    // 5 MiB (5,242,880) % 3 === 2, so the byte cap lands mid-sequence.
    const multibyte = '中'.repeat(2_000_000)
    expect(multibyte.length).toBeLessThan(5_000_000)
    expect(Buffer.byteLength(multibyte, 'utf8')).toBeGreaterThan(5 * 1024 * 1024)

    setScrapeResponse({
      body: {
        success: true,
        data: { markdown: multibyte, metadata: { statusCode: 200 }, source: 'local' },
      },
    })

    const first = await fetchUrlTool.execute({ url: 'https://example.test/utf8', limit: 100 }, ctx)
    expect(first.isError).toBeUndefined()
    const expectedChars = Math.floor((5 * 1024 * 1024) / 3) // 1,747,626 complete chars
    expect(first.content).toContain('中'.repeat(100))
    expect(first.content).toContain(`… ${expectedChars - 100} more character(s); continue with offset=100`)
    expect(first.content).toContain('cut off at 5 MB')

    const tail = await fetchUrlTool.execute(
      { url: 'https://example.test/utf8', offset: expectedChars - 10, limit: 100 },
      ctx,
    )
    expect(tail.isError).toBeUndefined()
    expect(tail.content.startsWith('中'.repeat(10))).toBe(true)
    expect(tail.content).not.toContain('\uFFFD')
    expect(tail.content).toContain('cut off at 5 MB')
  })

  it('does not follow 3xx redirects returned by the local Firecrawl server on /v2/scrape or /health', async () => {
    const { mkdirSync } = await import('node:fs')
    const { createServer } = await import('node:http')
    mkdirSync(binDir, { recursive: true })
    writeFakeBinary(binDir)
    stubOrigin('<html><body>redirect test</body></html>')

    let targetHits = 0
    const target = createServer((_req, res) => {
      targetHits += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ success: true, data: { markdown: 'hijacked', source: 'local' } }))
    })
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', () => resolve()))
    const addr = target.address()
    const targetPort = typeof addr === 'object' && addr ? addr.port : 0

    try {
      setScrapeResponse({
        httpStatus: 302,
        headers: { location: `http://127.0.0.1:${targetPort}/hijack` },
        body: '',
      })
      const scrapeRedirect = await fetchUrlTool.execute({ url: 'https://example.test/redir-scrape' }, ctx)
      expect(scrapeRedirect.isError).toBe(true)
      expect(scrapeRedirect.content).toContain('302')
      expect(targetHits).toBe(0)

      await reloadTools()
      killMockChild()
      setScrapeResponse({
        health: {
          httpStatus: 302,
          headers: { location: `http://127.0.0.1:${targetPort}/hijack-health` },
          body: '',
        },
        body: { success: true, data: { markdown: 'ok', source: 'local' } },
      })
      const healthRedirect = await fetchUrlTool.execute({ url: 'https://example.test/redir-health' }, ctx)
      expect(healthRedirect.isError).toBe(true)
      expect(healthRedirect.content).toContain('302')
      expect(targetHits).toBe(0)
    } finally {
      await new Promise<void>((resolve) => target.close(() => resolve()))
    }
  })
})
