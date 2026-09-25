import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import { CdpConnection, CdpError } from '../src/core/browser/cdp.js'

/**
 * The transport, against a real socket rather than a stub: framing, ids,
 * timeouts and the session routing are exactly the parts a fake socket would
 * let pass while the real one failed.
 */
const servers: WebSocketServer[] = []
const open: WebSocket[] = []

interface Harness {
  url: string
  /** The client socket the server is holding, for pushing events at it. */
  client: () => WebSocket
}

function startServer(onMessage: (message: Record<string, unknown>, socket: WebSocket) => void): Promise<Harness> {
  return new Promise((resolve) => {
    const server = new WebSocketServer({ port: 0 })
    servers.push(server)
    const clients: WebSocket[] = []
    server.on('connection', (socket) => {
      clients.push(socket)
      open.push(socket)
      socket.on('message', (raw) => onMessage(JSON.parse(raw.toString()), socket))
    })
    server.once('listening', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({
        url: `ws://127.0.0.1:${port}`,
        client: () => {
          const socket = clients[0]
          if (!socket) throw new Error('the server has no client yet')
          return socket
        },
      })
    })
  })
}

afterEach(async () => {
  // Terminated rather than closed politely: a half-finished test leaves a socket
  // open, and `server.close()` waits for it forever.
  for (const socket of open.splice(0)) socket.terminate()
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(() => done(undefined)))))
})

describe('CdpConnection', () => {
  it('answers a command with its result', async () => {
    const server = await startServer((message, socket) => {
      socket.send(JSON.stringify({ id: message.id, result: { product: 'Chrome/140' } }))
    })
    const connection = await CdpConnection.connect(server.url)
    expect(await connection.send('Browser.getVersion')).toEqual({ product: 'Chrome/140' })
    connection.close()
  })

  it('carries the session id, and only on the commands that have one', async () => {
    const seen: Record<string, unknown>[] = []
    const server = await startServer((message, socket) => {
      seen.push(message)
      socket.send(JSON.stringify({ id: message.id, result: {} }))
    })
    const connection = await CdpConnection.connect(server.url)
    await connection.send('Target.setDiscoverTargets', { discover: true })
    await connection.send('Page.navigate', { url: 'https://example.com' }, { sessionId: 'S1' })
    expect(seen[0]).not.toHaveProperty('sessionId')
    expect(seen[1]).toMatchObject({ sessionId: 'S1', method: 'Page.navigate' })
    connection.close()
  })

  it('raises what the browser reported as a CdpError', async () => {
    const server = await startServer((message, socket) => {
      socket.send(JSON.stringify({ id: message.id, error: { code: -32601, message: 'no such method' } }))
    })
    const connection = await CdpConnection.connect(server.url)
    await expect(connection.send('Nope.nowhere')).rejects.toBeInstanceOf(CdpError)
    connection.close()
  })

  it('fails a command that never comes back', async () => {
    const server = await startServer(() => undefined)
    const connection = await CdpConnection.connect(server.url)
    await expect(connection.send('Never.answers', {}, { timeoutMs: 40 })).rejects.toThrow(/timed out/)
    connection.close()
  })

  it('cancels a command the caller aborted', async () => {
    const server = await startServer(() => undefined)
    const connection = await CdpConnection.connect(server.url)
    const controller = new AbortController()
    const pending = connection.send('Slow.one', {}, { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toThrow(/cancelled/)
    connection.close()
  })

  it('routes an event to its handler, with the session it came from', async () => {
    const server = await startServer(() => undefined)
    const connection = await CdpConnection.connect(server.url)
    const events: { params: Record<string, unknown>; sessionId?: string }[] = []
    connection.on('Page.loadEventFired', (params, sessionId) => events.push({ params, sessionId }))

    server.client().send(JSON.stringify({ method: 'Page.loadEventFired', params: { timestamp: 1 }, sessionId: 'S2' }))
    await new Promise((done) => setTimeout(done, 20))
    expect(events).toEqual([{ params: { timestamp: 1 }, sessionId: 'S2' }])
    connection.close()
  })

  it('fails the commands aimed at a target that went away, and only those', async () => {
    const server = await startServer((message, socket) => {
      socket.send(JSON.stringify({ id: message.id, result: { ok: true } }))
    })
    const connection = await CdpConnection.connect(server.url)
    const doomed = connection.send('Page.navigate', {}, { sessionId: 'S3', timeoutMs: 5_000 })
    const other = connection.send('Browser.getVersion', {}, { timeoutMs: 5_000 })

    server.client().send(JSON.stringify({ method: 'Target.detachedFromTarget', params: { sessionId: 'S3' } }))
    await expect(doomed).rejects.toThrow(/went away/)
    await expect(other).resolves.toEqual({ ok: true })
    connection.close()
  })

  it('fails everything still waiting when the connection closes', async () => {
    const server = await startServer(() => undefined)
    const connection = await CdpConnection.connect(server.url)
    const pending = connection.send('Never.answers', {}, { timeoutMs: 5_000 })
    connection.close()
    await expect(pending).rejects.toThrow(/closed/)
  })

  it('refuses to send once it is closed', async () => {
    const server = await startServer(() => undefined)
    const connection = await CdpConnection.connect(server.url)
    connection.close()
    await expect(connection.send('Browser.getVersion')).rejects.toThrow(/closed/)
  })
})
