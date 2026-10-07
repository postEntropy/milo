import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The flow writes the grant and turns the config on, so it must never see the
// real home: a test that connects an account is a test that writes one.
const home = mkdtempSync(path.join(os.tmpdir(), 'milo-google-connect-'))
process.env.MILO_HOME = home

const { connectGoogle } = await import('../src/core/google/connect.js')
const { TOKEN_ENDPOINT } = await import('../src/core/google/oauth.js')
const { readAuth, readConfig, saveConfig } = await import('../src/core/config/load.js')
const { ConfigSchema } = await import('../src/core/config/schema.js')

/** The real fetch, kept because the loopback request in these tests is real. */
const realFetch = globalThis.fetch

const answer = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** The consent address, once the flow has opened its port. */
async function consentUrlOf(flow: { consent: () => string }): Promise<string> {
  for (let attempt = 0; attempt < 200 && flow.consent() === ''; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const url = flow.consent()
  if (!url) throw new Error('the flow never opened a consent address')
  return url
}

function googleIsFake(): void {
  vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith(TOKEN_ENDPOINT)) {
      return answer({ access_token: 'at', expires_in: 3600, refresh_token: 'rt' })
    }
    if (url.includes('/profile')) return answer({ emailAddress: 'ana@exemplo' })
    // Anything else is the loopback the browser would have hit: leave it real.
    return realFetch(input, init)
  })
}

afterEach(() => vi.unstubAllGlobals())
beforeEach(() => {
  rmSync(path.join(home, 'auth.json'), { force: true })
  // A config with the tools off, which is what a setup that has not connected yet
  // looks like — the flow is what turns them on.
  saveConfig(
    ConfigSchema.parse({
      provider: 'commandcode',
      model: 'some-model',
      providers: { commandcode: { baseURL: 'https://api.commandcode.ai/provider/v1' } },
      gateways: {},
      permissions: { mode: 'ask', allow: [], deny: [], jevThreshold: 0.35, jevTimeoutMs: 1500 },
    }),
  )
})

describe('the connect flow both surfaces drive', () => {
  it('writes the grant and turns the tools on, from the browser coming back', async () => {
    googleIsFake()
    let consent = ''
    const flow = connectGoogle({
      clientId: 'cid',
      clientSecret: 'shh',
      access: 'modify',
      onUrl: (url) => {
        consent = url
      },
    })

    const url = await consentUrlOf({ consent: () => consent })
    const redirect = new URL(new URL(url).searchParams.get('redirect_uri')!)
    const answered = await realFetch(`${redirect.origin}/?code=abc`)
    expect(answered.status).toBe(200)

    const connected = await flow
    expect(connected.ok).toBe(true)
    if (!connected.ok) return
    expect(connected.value.account.refreshToken).toBe('rt')
    expect(connected.value.account.email).toBe('ana@exemplo')
    // The level the person chose is what gets stored — `none` would be a grant
    // nobody asked for.
    expect(connected.value.account.access).toBe('modify')
    expect(connected.value.enabledInConfig).toBe(true)

    expect(readAuth().google?.email).toBe('ana@exemplo')
    expect(readAuth().google?.access).toBe('modify')
    expect(readConfig()?.google.enabled).toBe(true)
  })

  it('refuses to call it a connection when Google returns no refresh token', async () => {
    vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith(TOKEN_ENDPOINT)) return answer({ access_token: 'at', expires_in: 3600 })
      return realFetch(input, init)
    })

    let consent = ''
    const flow = connectGoogle({
      clientId: 'cid',
      clientSecret: 'shh',
      access: 'none',
      onUrl: (url) => {
        consent = url
      },
    })

    const url = await consentUrlOf({ consent: () => consent })
    const redirect = new URL(new URL(url).searchParams.get('redirect_uri')!)
    await realFetch(`${redirect.origin}/?code=abc`)

    const connected = await flow
    expect(connected.ok).toBe(false)
    if (connected.ok) return
    expect(connected.error).toContain('refresh token')
    expect(readAuth().google).toBeUndefined()
  })

  it('says the address is unknown rather than calling a grant proven when Gmail stays quiet', async () => {
    vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith(TOKEN_ENDPOINT)) {
        return answer({ access_token: 'at', expires_in: 3600, refresh_token: 'rt' })
      }
      if (url.includes('/profile')) return answer({}, 200)
      return realFetch(input, init)
    })

    let consent = ''
    const flow = connectGoogle({
      clientId: 'cid',
      clientSecret: 'shh',
      access: 'none',
      onUrl: (url) => {
        consent = url
      },
    })

    const url = await consentUrlOf({ consent: () => consent })
    const redirect = new URL(new URL(url).searchParams.get('redirect_uri')!)
    await realFetch(`${redirect.origin}/?code=abc`)

    const connected = await flow
    expect(connected.ok).toBe(true)
    if (!connected.ok) return
    expect(connected.value.warning).toContain('would not say which address')
    expect(readAuth().google?.refreshToken).toBe('rt')
  })
})
