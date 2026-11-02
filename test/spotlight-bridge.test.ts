import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'

const ENTRY = path.resolve('src/bin/cli.ts')
const TSX = path.resolve('node_modules/.bin/tsx')
const TOKEN = 'spotlight-test-token'

const children: ChildProcessWithoutNullStreams[] = []
const servers: Server[] = []

afterEach(async () => {
  for (const child of children.splice(0)) child.kill()
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))))
})

/** A port nothing listens on: bound once to get a free one, then let go. */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise((resolve) => server.close(resolve))
  return port
}

/** The bridge, started against a temp Milo home that names `port` as the daemon's. */
function bridge(port: number): { child: ChildProcessWithoutNullStreams; reports: Record<string, unknown>[]; next(type: string): Promise<Record<string, unknown>> } {
  const home = mkdtempSync(path.join(tmpdir(), 'milo-bridge-'))
  writeFileSync(
    path.join(home, 'config.yml'),
    `provider: p\nmodel: m\nproviders:\n  p:\n    baseURL: http://127.0.0.1:1/v1\nweb:\n  host: 127.0.0.1\n  port: ${port}\n`,
  )
  writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ providers: {}, gateways: { web: TOKEN } }))
  const child = spawn(TSX, [ENTRY, 'spotlight'], { env: { ...process.env, MILO_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] })
  children.push(child)
  const reports: Record<string, unknown>[] = []
  const waiting: { type: string; resolve(report: Record<string, unknown>): void }[] = []
  createInterface({ input: child.stdout }).on('line', (line) => {
    const report = JSON.parse(line) as Record<string, unknown>
    reports.push(report)
    for (const waiter of waiting.filter((entry) => entry.type === report.type)) {
      waiting.splice(waiting.indexOf(waiter), 1)
      waiter.resolve(report)
    }
  })
  const next = (type: string): Promise<Record<string, unknown>> => {
    const seen = reports.find((report) => report.type === type)
    return seen ? Promise.resolve(seen) : new Promise((resolve) => waiting.push({ type, resolve }))
  }
  return { child, reports, next }
}

/** A daemon as far as the bridge can tell: answers the probe and greets a chat with `ready`. */
async function daemonOn(port: number): Promise<void> {
  const server = createServer((request, response) => {
    request.resume()
    response.writeHead(request.headers.authorization === `Bearer ${TOKEN}` ? 200 : 401).end('{}')
  })
  const sockets = new WebSocketServer({ server })
  sockets.on('connection', (socket) => {
    socket.on('message', () => socket.send(JSON.stringify({ type: 'ready', sessionId: 'session-1' })))
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
}

describe('the popup bridge', () => {
  it('says the daemon is not running and starts nothing', async () => {
    const port = await freePort()
    const { next } = bridge(port)

    expect(await next('offline')).toEqual({ type: 'offline' })
    // A second pass of the retry loop has run by now; a daemon it started would answer.
    await new Promise((resolve) => setTimeout(resolve, 2000))
    const refused = await fetch(`http://127.0.0.1:${port}/api/sessions`, { method: 'POST' }).then(
      () => false,
      () => true,
    )
    expect(refused).toBe(true)
  }, 20_000)

  it('picks the daemon up once it starts, without being restarted', async () => {
    const port = await freePort()
    const { next, reports } = bridge(port)
    await next('offline')

    await daemonOn(port)

    expect(await next('ready')).toEqual({ type: 'ready' })
    expect(reports.some((report) => report.type === 'error')).toBe(false)
  }, 20_000)

  it('exits when its stdin closes while no daemon is there', async () => {
    const port = await freePort()
    const { child, next } = bridge(port)
    await next('offline')

    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve))
    child.stdin.end()

    expect(await exited).toBe(0)
  }, 20_000)
})
