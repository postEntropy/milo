import { afterEach, describe, expect, it } from 'vitest'
import { Readable } from 'node:stream'
import { bindProblem, panelHeaders, readRawBody, startWebServer, webReachLines } from '../src/gateways/web/http.js'

const running: Array<{ stop(): Promise<void> }> = []

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.stop()))
})

describe('web server authentication', () => {
  it('requires its token for API access', async () => {
    const server = await startWebServer({
      runtime: {} as never,
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
    const server = await startWebServer({ runtime: {} as never, cwd: process.cwd(), host: '127.0.0.1', port: 0, token: 'test-token' })
    running.push(server)
    const response = await fetch(`http://127.0.0.1:${portOf(server.url)}/upload`, { method: 'POST', body: 'file bytes' })
    expect(response.status).toBe(401)
  })

  it('accepts raw authenticated file uploads for a later chat send', async () => {
    const server = await startWebServer({ runtime: {} as never, cwd: process.cwd(), host: '127.0.0.1', port: 0, token: 'test-token' })
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
      runtime: {} as never,
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

  it('does not accept cross-origin API writes', async () => {
    const server = await startWebServer({
      runtime: {} as never,
      cwd: process.cwd(),
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
    })
    running.push(server)
    const response = await fetch(`http://127.0.0.1:${portOf(server.url)}/api/overview`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        origin: 'https://attacker.example',
        'content-type': 'application/json',
      },
      body: '{}',
    })
    expect(response.status).toBe(403)
  })

  it('prints an openable address when bound to every interface', async () => {
    const server = await startWebServer({
      runtime: {} as never,
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
      runtime: {} as never,
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
      runtime: {} as never,
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
      runtime: {} as never,
      cwd: process.cwd(),
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
    })
    running.push(first)
    const port = portOf(first.url)

    const error = await startWebServer({
      runtime: {} as never,
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
