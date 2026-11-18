import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import WebSocket from 'ws'
import { PROTOCOL_VERSION } from '../src/gateways/web/protocol.js'
import { bindProblem, panelHeaders, readRawBody, startWebServer, webReachLines } from '../src/gateways/web/http.js'

const running: Array<{ stop(): Promise<void> }> = []

/**
 * The server is what these tests are about, not a whole install behind it — so this stands
 * in for one. The hub the server builds asks a single thing of it: to be told when a
 * session's turn begins or ends, and when a step may have changed what is on disk. Both are
 * what a page re-reads what it draws on.
 */
const runtime = {
  onSessionsChanged: () => () => {},
  onWorkChanged: () => () => {},
  onSessionFolderChanged: () => () => {},
} as never

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.stop()))
})

describe('web server authentication', () => {
  it('requires its token for API access', async () => {
    const server = await startWebServer({
      runtime,
      cwd: process.cwd(),
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
    })
    running.push(server)
    const response = await fetch(`http://127.0.0.1:${portOf(server.url)}/api/overview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(response.status).toBe(401)
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('requires its token for file uploads', async () => {
    const server = await startWebServer({ runtime, cwd: process.cwd(), host: '127.0.0.1', port: 0, token: 'test-token' })
    running.push(server)
    const response = await fetch(`http://127.0.0.1:${portOf(server.url)}/upload`, { method: 'POST', body: 'file bytes' })
    expect(response.status).toBe(401)
  })

  it('rejects null origins on ws/api/pair and non-JSON simple POSTs on /pair/claim', async () => {
    const server = await startWebServer({ runtime, cwd: process.cwd(), host: '127.0.0.1', port: 0, token: 'test-token' })
    running.push(server)
    const base = `http://127.0.0.1:${portOf(server.url)}`

    const apiNull = await fetch(`${base}/api/overview`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', origin: 'null', 'content-type': 'application/json' },
      body: '{}',
    })
    expect(apiNull.status).toBe(401)

    const pairNull = await fetch(`${base}/pair/claim`, {
      method: 'POST',
      headers: { origin: 'null', 'content-type': 'application/json' },
      body: '{"code":"123456"}',
    })
    expect(pairNull.status).toBe(403)

    const pairSimple = await fetch(`${base}/pair/claim`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{"code":"123456"}',
    })
    expect(pairSimple.status).toBe(415)

    const wsStatus = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${portOf(server.url)}/ws?t=test-token`, { headers: { origin: 'null' } })
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
      ws.on('open', () => { ws.close(); resolve(101) })
      ws.on('error', (err) => reject(err))
    })
    expect(wsStatus).toBe(401)
  })

  it('returns 400 or 503 (never 500) on malformed percent-encoded paths', async () => {
    const server = await startWebServer({ runtime, cwd: process.cwd(), host: '127.0.0.1', port: 0, token: 'test-token' })
    running.push(server)
    const response = await fetch(`http://127.0.0.1:${portOf(server.url)}/%ZZ`)
    expect([400, 503]).toContain(response.status)
  })

  it('accepts raw authenticated file uploads for a later chat send', async () => {
    const server = await startWebServer({ runtime, cwd: process.cwd(), host: '127.0.0.1', port: 0, token: 'test-token' })
    running.push(server)
    const response = await fetch(`http://127.0.0.1:${portOf(server.url)}/upload`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'text/plain', 'x-file-name': 'notes.txt' },
      body: 'file bytes',
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ uploadId: expect.any(String) })
  })

  it('accepts the token it was handed, rather than minting its own', async () => {
    const server = await startWebServer({
      runtime,
      cwd: process.cwd(),
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
    })
    running.push(server)
    const response = await fetch(`http://127.0.0.1:${portOf(server.url)}/api/overview?t=test-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    // Past the auth gate: whatever the action itself answers, it is not a 401.
    // Without this the 401 above still passes if `token` were ignored entirely.
    expect(response.status).not.toBe(401)
  })

  it('lets the token alone decide, whatever origin the request claims', async () => {
    const server = await startWebServer({
      runtime,
      cwd: process.cwd(),
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
    })
    running.push(server)
    // The token is the whole of the authorization. A page reached by another name
    // — a tailnet host, an IPv6 literal, anything behind TLS — presents the same
    // token and is served; the browser's `Origin` is not a second gate.
    const response = await fetch(`http://127.0.0.1:${portOf(server.url)}/api/overview`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        origin: 'https://other.example',
        'content-type': 'application/json',
      },
      body: '{}',
    })
    // Past the gate: whatever the action answers, it is not a refusal.
    expect(response.status).not.toBe(401)
    expect(response.status).not.toBe(403)
  })

  it('refuses a request that carries no token, whatever its origin', async () => {
    const server = await startWebServer({
      runtime,
      cwd: process.cwd(),
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
    })
    running.push(server)
    const response = await fetch(`http://127.0.0.1:${portOf(server.url)}/api/overview`, {
      method: 'POST',
      headers: {
        origin: 'https://attacker.example',
        'content-type': 'application/json',
      },
      body: '{}',
    })
    expect(response.status).toBe(401)
  })

  it('prints an openable address when bound to every interface', async () => {
    const server = await startWebServer({
      runtime,
      cwd: process.cwd(),
      host: '0.0.0.0',
      port: 0,
      token: 'test-token',
    })
    running.push(server)

    // `0.0.0.0` names no machine, so a URL built from it opens nothing anywhere —
    // the phone on the same tailnet included. The URL printed is loopback.
    expect(server.url).not.toContain('0.0.0.0')
    expect(new URL(server.url).hostname).toBe('127.0.0.1')

    // And the names another device would use are listed beside it, on the same
    // port and with the same token.
    for (const url of server.urls) {
      expect(new URL(url).hostname).not.toBe('127.0.0.1')
      expect(new URL(url).port).toBe(String(portOf(server.url)))
      expect(new URL(url).searchParams.get('t')).toBe('test-token')
    }
  })

  it('lists no extra address when the bind is a fixed one', async () => {
    const server = await startWebServer({
      runtime,
      cwd: process.cwd(),
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
    })
    running.push(server)
    expect(server.urls).toEqual([])
  })
})

describe('web server static UI', () => {
  it('serves the manifest as a manifest, so the install can go full screen', async () => {
    const server = await startWebServer({
      runtime,
      cwd: process.cwd(),
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
    })
    running.push(server)
    const response = await fetch(`http://127.0.0.1:${portOf(server.url)}/manifest.webmanifest`)
    expect(response.status).toBe(200)
    // Served as a download, the manifest is ignored: no `display: standalone`,
    // and the phone keeps dressing the app in its own browser chrome.
    expect(response.headers.get('content-type')).toContain('application/manifest+json')
    // Revalidated, not cached for an hour: a manifest left in the browser's cache
    // would keep an installed home screen opening on rules it no longer has.
    expect(response.headers.get('cache-control')).toBe('no-cache')
  })

  it('names the token in the manifest only for a caller that holds it', async () => {
    const server = await startWebServer({ runtime, cwd: process.cwd(), host: '127.0.0.1', port: 0, token: 'test-token' })
    running.push(server)
    const base = `http://127.0.0.1:${portOf(server.url)}`
    // An installed app opens at `start_url`, and an iPhone home screen carries no
    // storage of its own — so this is where the token has to be for it to arrive.
    const mine = await (await fetch(`${base}/manifest.webmanifest?t=test-token`)).json() as { start_url?: string }
    expect(mine.start_url).toBe('/?t=test-token')
    // Handed to anyone else, the manifest says nothing about the token.
    const theirs = await (await fetch(`${base}/manifest.webmanifest`)).json() as { start_url?: string }
    expect(theirs.start_url).toBeUndefined()
  })

  it('points the page at the manifest that carries the token', async () => {
    const server = await startWebServer({ runtime, cwd: process.cwd(), host: '127.0.0.1', port: 0, token: 'test-token' })
    running.push(server)
    const base = `http://127.0.0.1:${portOf(server.url)}`
    const html = await (await fetch(`${base}/?t=test-token`)).text()
    expect(html).toContain('href="/manifest.webmanifest?t=test-token"')
  })
})

describe('web server panel artifacts', () => {
  it('sandboxes a panel artifact, so a direct hit on it cannot reach the app', () => {
    const headers = panelHeaders('image/svg+xml', 12)
    expect(headers).toMatchObject({
      'content-type': 'image/svg+xml',
      'content-disposition': 'inline',
      'x-content-type-options': 'nosniff',
      // Bare `sandbox` would also strip the panel's own pages of their scripts;
      // the allowances keep HTML and the PDF viewer working under an opaque origin.
      'content-security-policy': 'sandbox allow-scripts allow-forms allow-popups allow-modals',
    })
  })

  it('serves a panel artifact via an artifact-scoped ticket without accepting it on API or WS', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'milo-panel-ticket-'))
    const htmlFile = path.join(dir, 'chart.html')
    writeFileSync(htmlFile, '<h1>hi</h1>', 'utf8')
    const stubSession = {
      id: 'sess-panel',
      backend: { kind: 'milo' as const },
      backendView: { kind: 'milo' as const },
      planMode: false,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      project: null,
      appendNotice: async () => undefined,
      refreshFolder: () => {},
      setPlan: () => {},
    }
    const stubRuntime = {
      ...(runtime as Record<string, unknown>),
      provider: { id: 'test' },
      providerName: 'Test',
      model: 'test-model',
      sessionFor: async () => stubSession,
      getSession: async () => stubSession,
    } as never
    try {
      const server = await startWebServer({ runtime: stubRuntime, cwd: dir, host: '127.0.0.1', port: 0, token: 'test-token' })
      running.push(server)
      const base = `http://127.0.0.1:${portOf(server.url)}`

      const ws = new WebSocket(`ws://127.0.0.1:${portOf(server.url)}/ws?t=test-token`)
      const ready = await new Promise<{ attachments: string[] }>((resolve, reject) => {
        const attachments: string[] = []
        ws.on('error', reject)
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, chatId: '11111111-2222-3333-4444-555555555555' }))
        })
        ws.on('message', async (raw) => {
          const frame = JSON.parse(raw.toString()) as { type: string; message?: string; attachments?: Array<{ id: string }> }
          if (frame.type === 'error') {
            reject(new Error(`WS error frame: ${frame.message ?? raw.toString()}`))
          } else if (frame.type === 'ready') {
            await server.deliver('11111111-2222-3333-4444-555555555555', {
              text: 'here',
              files: [{ path: htmlFile, name: 'chart.html', mimeType: 'text/html' }],
            })
          } else if (frame.type === 'command-result' && frame.attachments?.[0]?.id) {
            attachments.push(frame.attachments[0].id)
            resolve({ attachments })
          }
        })
      })
      ws.close()

      const id = ready.attachments[0]!
      const ticketRes = await fetch(`${base}/api/panel-ticket`, {
        method: 'POST',
        headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      expect(ticketRes.status).toBe(200)
      const { ticket } = await ticketRes.json() as { ticket: string }

      const panelOk = await fetch(`${base}/panel/${id}?p=${encodeURIComponent(ticket)}`)
      expect(panelOk.status).toBe(200)
      expect(await panelOk.text()).toBe('<h1>hi</h1>')

      expect((await fetch(`${base}/panel/other-id?p=${encodeURIComponent(ticket)}`)).status).toBe(401)
      expect((await fetch(`${base}/attachment/${id}?t=${encodeURIComponent(ticket)}`)).status).toBe(401)
      expect((await fetch(`${base}/api/overview?t=${encodeURIComponent(ticket)}`, { method: 'POST', body: '{}' })).status).toBe(401)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the upload body reader', () => {
  it('reads a body under its ceiling whole', async () => {
    const stream = Readable.from([Buffer.from('hello '), Buffer.from('world')])
    expect((await readRawBody(stream as never, 1024)).toString()).toBe('hello world')
  })

  it('refuses a body past its ceiling rather than buffering it whole', async () => {
    const megabyte = Buffer.alloc(1024 * 1024)
    const stream = Readable.from([megabyte, megabyte, megabyte])

    await expect(readRawBody(stream as never, 2 * 1024 * 1024)).rejects.toThrow(/larger than 2 MB/)
  })
})

describe('webReachLines', () => {
  it('says nothing extra for a bind that names itself', () => {
    expect(webReachLines('127.0.0.1', [])).toEqual([])
    expect(webReachLines('192.168.100.100', [])).toEqual([])
  })

  it('calls 0.0.0.0 what it is, and names what to open instead', () => {
    const lines = webReachLines('0.0.0.0', ['http://192.168.100.100:7717/?t=x'])
    // The trap this exists for: the URL looks right, the daemon is up, and the
    // device meant to use it reaches nothing.
    expect(lines[0]).toContain('0.0.0.0 is not a name another device opens')
    expect(lines[1]).toContain('http://192.168.100.100:7717/?t=x')
  })

  it('still warns when the machine has no address to offer', () => {
    expect(webReachLines('::', [])[0]).toContain('not a name another device opens')
  })
})

describe('bindProblem', () => {
  it('says what to change, not just which errno fired', () => {
    expect(bindProblem({ code: 'EADDRINUSE' }, '0.0.0.0', 7717)).toContain('7717 is already in use')
    expect(bindProblem({ code: 'EADDRNOTAVAIL' }, '10.0.0.9', 7717)).toContain(
      '10.0.0.9 is not an address of this machine',
    )
    expect(bindProblem({ code: 'EACCES' }, '127.0.0.1', 80)).toContain('privileges')
    expect(bindProblem(new Error('something else'), '127.0.0.1', 7717)).toBe('something else')
  })

  it('reads a real refusal', async () => {
    const first = await startWebServer({
      runtime,
      cwd: process.cwd(),
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
    })
    running.push(first)
    const port = portOf(first.url)

    const error = await startWebServer({
      runtime,
      cwd: process.cwd(),
      host: '127.0.0.1',
      port,
      token: 'test-token',
    }).then(
      () => null,
      (caught: unknown) => caught,
    )

    expect(error).not.toBeNull()
    expect(bindProblem(error, '127.0.0.1', port)).toContain(`port ${port} is already in use`)
  })
})

function portOf(url: string): number {
  return Number(new URL(url).port)
}
