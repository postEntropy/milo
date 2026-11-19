import { spawn } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { fetch } from 'undici'
import { errorMessage } from '../../util/errors.js'

const STARTUP_TIMEOUT_MS = 5_000
const POLL_MS = 25
const HTML_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'

/** Outcome of attempting to scrape an HTML page with Firecrawl Local. */
export type FirecrawlResult =
  | { available: false }
  | { available: true; ok: true; markdown: string }
  | { available: true; ok: false; error: string }

export interface CappedText {
  text: string
  truncated: boolean
}

interface FirecrawlServer {
  url: string
  binary: string
  alive(): boolean
  stop(): void
}

let active: FirecrawlServer | null = null
let starting: Promise<FirecrawlServer> | null = null

/**
 * Reads up to `maxBytes` from a stream and cancels the remainder so a huge
 * or unending response cannot exhaust memory.
 */
export async function readCappedText(
  body: NodeReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<CappedText> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []
  let bytes = 0
  let truncated = false

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (bytes + value.byteLength > maxBytes) {
        chunks.push(decoder.decode(value.subarray(0, maxBytes - bytes), { stream: true }))
        truncated = true
        break
      }
      bytes += value.byteLength
      chunks.push(decoder.decode(value, { stream: true }))
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }

  chunks.push(decoder.decode())
  return { text: chunks.join(''), truncated }
}

/**
 * Scrapes one already-vetted public HTML page through a local `firecrawl-local`
 * instance started with `FIRECRAWL_CLOUD=off` and default private-IP blocking.
 * Returns `{ available: false }` when the binary is absent on this machine.
 */
export async function scrapeWithFirecrawl(
  url: string,
  options: {
    signal: AbortSignal
    timeoutMs: number
    maxBytes: number
    beforeScrape?: () => Promise<void> | void
  },
): Promise<FirecrawlResult> {
  const binary = findFirecrawlBinary()
  if (!binary) return { available: false }

  await options.beforeScrape?.()

  let server: FirecrawlServer
  try {
    server = await ensureServer(binary, options.signal)
  } catch (error) {
    return { available: true, ok: false, error: errorMessage(error) }
  }

  try {
    const response = await fetch(`${server.url}/v2/scrape`, {
      method: 'POST',
      redirect: 'manual',
      signal: options.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url,
        formats: ['markdown'],
        headers: { Accept: HTML_ACCEPT },
        timeout: Math.max(1, Math.round(options.timeoutMs)),
      }),
    })

    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined)
      return {
        available: true,
        ok: false,
        error: `Firecrawl Local returned unexpected redirect (HTTP ${response.status}).`,
      }
    }

    if (!response.body) {
      return { available: true, ok: false, error: 'Firecrawl Local returned an empty response body.' }
    }

    const read = await readCappedText(response.body, options.maxBytes)
    if (read.truncated) {
      return { available: true, ok: false, error: 'Firecrawl Local response exceeded the size limit.' }
    }

    let payload: unknown
    try {
      payload = JSON.parse(read.text)
    } catch {
      return {
        available: true,
        ok: false,
        error: response.ok
          ? 'Firecrawl Local returned invalid JSON.'
          : `Firecrawl Local returned HTTP ${response.status}.`,
      }
    }

    return parseScrapePayload(response.ok, response.status, payload)
  } catch (error) {
    return { available: true, ok: false, error: errorMessage(error) }
  }
}

function parseScrapePayload(ok: boolean, httpStatus: number, raw: unknown): FirecrawlResult {
  if (!raw || typeof raw !== 'object') {
    return { available: true, ok: false, error: 'Firecrawl Local returned an invalid response.' }
  }

  const payload = raw as Record<string, unknown>
  const data = payload.data && typeof payload.data === 'object' ? (payload.data as Record<string, unknown>) : null
  const metadata =
    data?.metadata && typeof data.metadata === 'object' ? (data.metadata as Record<string, unknown>) : null

  const errorText = typeof payload.error === 'string' && payload.error.trim() ? payload.error.trim() : null
  const codeText = typeof payload.code === 'string' && payload.code.trim() ? payload.code.trim() : null
  const warningText =
    (typeof data?.warning === 'string' && data.warning.trim()) ||
    (typeof payload.warning === 'string' && payload.warning.trim()) ||
    null

  if (!ok || payload.success !== true) {
    const detail = errorText ?? warningText ?? codeText ?? `Firecrawl Local failed (HTTP ${httpStatus})`
    return { available: true, ok: false, error: detail }
  }

  // Enforce strictly local execution: reject any cloud handoff or unrecognised source.
  const source = data?.source ?? payload.source
  if (source !== 'local') {
    return {
      available: true,
      ok: false,
      error: `Firecrawl Local returned non-local source (${String(source ?? 'unknown')}).`,
    }
  }

  if (payload.blocked === true || data?.blocked === true) {
    return {
      available: true,
      ok: false,
      error: warningText ?? errorText ?? 'Target blocked local extraction.',
    }
  }

  const statusCode = metadata?.statusCode
  if (typeof statusCode === 'number' && statusCode >= 400) {
    return { available: true, ok: false, error: `HTTP ${statusCode}` }
  }

  const markdown = data?.markdown
  if (typeof markdown !== 'string') {
    return {
      available: true,
      ok: false,
      error: warningText ?? 'Firecrawl Local returned no markdown content.',
    }
  }

  if (!markdown.trim() && warningText) {
    return { available: true, ok: false, error: warningText }
  }

  return { available: true, ok: true, markdown }
}

function findFirecrawlBinary(): string | null {
  const name = process.platform === 'win32' ? 'firecrawl-local.exe' : 'firecrawl-local'
  const pathDirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  const home = process.env.HOME?.trim() || os.homedir()
  const dirs = [...new Set([...pathDirs, path.join(home, '.cargo', 'bin')])]

  for (const dir of dirs) {
    const candidate = path.join(dir, name)
    if (isExecutable(candidate)) return candidate
  }
  return null
}

function isExecutable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false
    if (process.platform !== 'win32') accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function ensureServer(binary: string, signal: AbortSignal): Promise<FirecrawlServer> {
  if (signal.aborted) throw signal.reason ?? new Error('Aborted')
  if (active && active.binary === binary && active.alive()) return active
  if (active) {
    active.stop()
    active = null
  }
  if (!starting) {
    starting = startServer(binary).finally(() => {
      starting = null
    })
  }
  return withAbort(starting, signal)
}

async function startServer(binary: string): Promise<FirecrawlServer> {
  const port = await freeLoopbackPort()
  const url = `http://127.0.0.1:${port}`
  const env = localFirecrawlEnv(process.env)

  const child = spawn(binary, ['serve', '--host', '127.0.0.1', '--port', String(port)], {
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  })

  let stderrTail = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-500)
  })

  let spawnError: Error | null = null
  child.once('error', (error) => {
    spawnError = error
  })

  const stop = () => {
    if (child.exitCode === null && !child.killed) child.kill('SIGTERM')
  }
  process.once('exit', stop)

  const server: FirecrawlServer = {
    url,
    binary,
    alive: () => child.exitCode === null && !child.killed,
    stop,
  }
  child.once('exit', () => {
    process.off('exit', stop)
    if (active === server) active = null
  })

  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (spawnError) {
      process.off('exit', stop)
      throw spawnError
    }
    if (child.exitCode !== null) {
      process.off('exit', stop)
      const detail = stderrTail.trim() ? `: ${stderrTail.trim()}` : ''
      throw new Error(`firecrawl-local exited on startup (exit ${child.exitCode})${detail}`)
    }
    let redirectStatus: number | null = null
    try {
      const response = await fetch(`${url}/health`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(500),
      })
      if (response.status >= 300 && response.status < 400) {
        redirectStatus = response.status
        await response.body?.cancel().catch(() => undefined)
      } else if (response.ok) {
        const health = (await response.json()) as { status?: unknown; engine?: unknown }
        if (health.status === 'ok' && health.engine === 'firecrawl-local') {
          // Let short-lived CLI commands exit naturally once their turn finishes;
          // the `exit` listener above stops the child process on the way out.
          child.unref()
          ;(child.stderr as { unref?: () => void } | null)?.unref?.()
          active = server
          return server
        }
      } else {
        await response.body?.cancel().catch(() => undefined)
      }
    } catch {
      // Not listening yet.
    }
    if (redirectStatus !== null) {
      stop()
      process.off('exit', stop)
      throw new Error(`firecrawl-local /health returned unexpected redirect (HTTP ${redirectStatus})`)
    }
    await delay(POLL_MS)
  }

  stop()
  process.off('exit', stop)
  throw new Error('firecrawl-local did not become ready in time')
}

function localFirecrawlEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, FIRECRAWL_CLOUD: 'off' }
  delete env.FIRECRAWL_API_KEY
  delete env.FIRECRAWL_API_URL
  delete env.FIRECRAWL_LOCAL_ALLOW_PRIVATE
  delete env.FIRECRAWL_LOCAL_TOKEN
  return env
}

function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close((error) => {
        if (error) reject(error)
        else if (!port) reject(new Error('could not allocate a loopback port for firecrawl-local'))
        else resolve(port)
      })
    })
  })
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('Aborted'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('Aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
