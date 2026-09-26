import { afterEach, describe, expect, it } from 'vitest'
import { startWebServer } from '../src/gateways/web/http.js'

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
      identity: { provider: 'test', model: 'test-model' },
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

  it('does not accept cross-origin API writes', async () => {
    const server = await startWebServer({
      runtime: {} as never,
      cwd: process.cwd(),
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      identity: { provider: 'test', model: 'test-model' },
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
})

function portOf(url: string): number {
  return Number(new URL(url).port)
}
