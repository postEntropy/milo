import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'

// Pairing writes a device registry and a code under `~/.milo`, so these tests must
// never see the real one: a test that pairs a device is a test that writes one.
const home = mkdtempSync(path.join(tmpdir(), 'milo-pairing-'))
process.env.MILO_HOME = home

const { addDevice, deviceForToken, readDevices, revokeDevice } = await import('../src/gateways/web/devices.js')
const { ClaimLimiter, currentPairing, openPairing, PAIRING_TTL_MS, redeemPairing } = await import(
  '../src/gateways/web/pair.js'
)
const { startWebServer } = await import('../src/gateways/web/http.js')
const { devicesFile } = await import('../src/core/config/paths.js')

const running: Array<{ stop(): Promise<void> }> = []

/**
 * Pairing is what these tests are about, not a whole install behind the server — so this
 * stands in for one. The hub the server builds asks one thing of it: to be told when a
 * session's turn begins or ends, and when a step may have changed what is on disk.
 */
const runtime = { onSessionsChanged: () => () => {}, onWorkChanged: () => () => {} } as never

beforeEach(() => {
  rmSync(path.join(home, 'devices.json'), { force: true })
  rmSync(path.join(home, 'pairing.json'), { force: true })
})

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.stop()))
})

describe('the device registry', () => {
  it('knows a device by the token it was handed, and nothing else by it', () => {
    const { device, token } = addDevice({ name: 'iPhone', platform: 'ios' })
    expect(deviceForToken(token)?.id).toBe(device.id)
    expect(deviceForToken('some other token')).toBeUndefined()
    expect(deviceForToken('')).toBeUndefined()
  })

  it('writes the hash rather than the token, so the file cannot be used to get back in', () => {
    const { token } = addDevice({ name: 'iPhone', platform: 'ios' })
    // A stolen registry must not be a set of working keys.
    expect(readFileSync(devicesFile(), 'utf8')).not.toContain(token)
    expect(statSync(devicesFile()).mode & 0o777).toBe(0o600)
  })

  it('stops recognising a device once it is taken back', () => {
    const { device, token } = addDevice({ name: 'iPhone', platform: 'ios' })
    expect(revokeDevice(device.id)).toBe(true)
    expect(deviceForToken(token)).toBeUndefined()
    expect(readDevices()).toEqual([])
    // Taking back what is not there is not an error, it is a no-op that says so.
    expect(revokeDevice(device.id)).toBe(false)
  })
})

describe('the pairing code', () => {
  it('is spent on the one redemption, so it cannot be replayed', () => {
    const open = openPairing()
    expect(currentPairing()?.code).toBe(open.code)
    expect(redeemPairing(open.code)).toBe(true)
    expect(redeemPairing(open.code)).toBe(false)
    expect(currentPairing()).toBeNull()
  })

  it('leaves the code open after a wrong guess, for its owner to use', () => {
    const open = openPairing()
    const wrong = open.code === '000000' ? '111111' : '000000'
    expect(redeemPairing(wrong)).toBe(false)
    expect(currentPairing()?.code).toBe(open.code)
    expect(redeemPairing(open.code)).toBe(true)
  })

  it('refuses a code that has run out of time', () => {
    const open = openPairing()
    expect(redeemPairing(open.code, Date.now() + PAIRING_TTL_MS)).toBe(false)
  })

  it('supersedes the open code with the next, so one code is never ambiguous', () => {
    const first = openPairing()
    const second = openPairing()
    expect(second.code).not.toBe(first.code)
    expect(currentPairing()?.code).toBe(second.code)
    expect(redeemPairing(first.code)).toBe(false)
  })
})

describe('the claim limiter', () => {
  it('caps the tries one address may make, and lifts the cap with the window', () => {
    const limiter = new ClaimLimiter(3, 60_000)
    const now = Date.now()
    expect(limiter.allow('1.2.3.4', now)).toBe(true)
    expect(limiter.allow('1.2.3.4', now)).toBe(true)
    expect(limiter.allow('1.2.3.4', now)).toBe(true)
    expect(limiter.allow('1.2.3.4', now)).toBe(false)
    // One address walking the code does not lock another out.
    expect(limiter.allow('5.6.7.8', now)).toBe(true)
    expect(limiter.allow('1.2.3.4', now + 60_001)).toBe(true)
  })
})

const claim = (base: string, body: unknown) =>
  fetch(`${base}/pair/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

async function server(): Promise<string> {
  const started = await startWebServer({
    runtime,
    cwd: process.cwd(),
    host: '127.0.0.1',
    port: 0,
    token: 'test-token',
  })
  running.push(started)
  return `http://127.0.0.1:${new URL(started.url).port}`
}

/** What a websocket upgrade came back as: a status, or that it opened. */
function upgrade(url: string): Promise<number | 'open'> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url)
    socket.on('open', () => {
      socket.close()
      resolve('open')
    })
    socket.on('unexpected-response', (_request, response) => {
      response.destroy()
      resolve(response.statusCode ?? 0)
    })
    socket.on('error', () => resolve(-1))
  })
}

describe('redeeming a code at the server', () => {
  it('refuses a claim when no code has been opened', async () => {
    const base = await server()
    expect((await claim(base, { code: '000000', name: 'iPhone', platform: 'ios' })).status).toBe(401)
  })

  it('hands a paired device a token that opens the same gate, and nothing to anyone else', async () => {
    const base = await server()
    const open = openPairing()

    const good = await claim(base, { code: open.code, name: 'iPhone', platform: 'ios' })
    expect(good.status).toBe(200)
    const paired = (await good.json()) as { token: string; deviceId: string; name: string }
    expect(paired.name).toBe('iPhone')
    expect(deviceForToken(paired.token)?.id).toBe(paired.deviceId)

    // The minted token opens the gate the install's own does — past it, whatever
    // the action answers is not a refusal.
    const mine = await fetch(`${base}/api/overview`, {
      method: 'POST',
      headers: { authorization: `Bearer ${paired.token}`, 'content-type': 'application/json' },
      body: '{}',
    })
    expect(mine.status).not.toBe(401)
    // A token nobody was handed does not.
    const theirs = await fetch(`${base}/api/overview`, {
      method: 'POST',
      headers: { authorization: 'Bearer not-a-token', 'content-type': 'application/json' },
      body: '{}',
    })
    expect(theirs.status).toBe(401)
  })

  it('opens the socket the app will hold, with the paired token and not without one', async () => {
    const base = await server()
    const port = new URL(base).port
    const open = openPairing()
    const paired = (await (await claim(base, { code: open.code, name: 'iPhone', platform: 'ios' })).json()) as {
      token: string
    }

    expect(await upgrade(`ws://127.0.0.1:${port}/ws?t=${encodeURIComponent(paired.token)}`)).toBe('open')
    expect(await upgrade(`ws://127.0.0.1:${port}/ws?t=not-a-token`)).toBe(401)
  })

  it('spends the code, so a second claim with the same one is refused', async () => {
    const base = await server()
    const open = openPairing()
    expect((await claim(base, { code: open.code })).status).toBe(200)
    expect((await claim(base, { code: open.code })).status).toBe(401)
  })
})
