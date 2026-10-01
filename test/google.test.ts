import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { challengeFor, consentUrl, DRIVE_READONLY, GMAIL_READONLY, refreshAccessToken } from '../src/core/google/oauth.js'
import { read as readFile, search as searchFiles } from '../src/core/google/drive.js'
import { read as readMessage, search as searchMail, type MailSummary } from '../src/core/google/gmail.js'
import { GOOGLE_STEPS, googleStepsInWords } from '../src/core/google/walkthrough.js'
import { clientFromCredentials } from '../src/bin/google.js'
import { createDriveTools } from '../src/core/tools/drive.js'
import { createGmailTools } from '../src/core/tools/gmail.js'

const tokens = { accessToken: 't', expiresAt: Date.now() + 60_000 }
const answer = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

afterEach(() => vi.unstubAllGlobals())

describe('Google consent', () => {
  it('asks for exactly the read scopes, offline, with PKCE', () => {
    const url = new URL(consentUrl({ clientId: 'cid', redirectUri: 'http://127.0.0.1:1/', verifier: 'v' }))
    // The exact list rather than a "contains": a write scope sneaking in here
    // would break this test, which is the point of it.
    expect(url.searchParams.get('scope')?.split(' ')).toEqual([GMAIL_READONLY, DRIVE_READONLY])
    // Without `offline` no refresh token comes at all — and nothing outlives the process.
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toBe(challengeFor('v'))
    expect(url.searchParams.get('client_id')).toBe('cid')
  })

  it('makes the challenge the verifier SHA-256, in base64url', () => {
    // The value for `abc` is the one from RFC 7636, which is what Google checks at the exchange.
    expect(challengeFor('abc')).toBe('ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0')
  })

  it('explains a dead grant in terms of what to do', async () => {
    vi.stubGlobal('fetch', async () => answer({ error: 'invalid_grant' }, 400))
    const got = await refreshAccessToken({ clientId: 'c', clientSecret: 's', refreshToken: 'r' })

    expect(got.ok).toBe(false)
    if (got.ok) return
    // The cause nobody guesses: an app in "Testing" kills the token every seven days.
    expect(got.error).toContain('seven days')
    expect(got.error).toContain('milo google connect')
  })
})

describe('Gmail against a fake answer', () => {
  it('lists what matched, with the headers a person chooses by', async () => {
    vi.stubGlobal('fetch', async (input: URL | string) => {
      const url = String(input)
      if (url.includes('/messages?')) return answer({ messages: [{ id: 'm1', threadId: 'th1' }] })
      return answer({
        id: 'm1',
        threadId: 'th1',
        snippet: 'um trecho',
        payload: {
          headers: [
            { name: 'From', value: 'ana@exemplo' },
            { name: 'Subject', value: 'a nota' },
            { name: 'Date', value: 'hoje' },
          ],
        },
      })
    })

    const found = await searchMail(tokens, 'from:ana', 5)
    expect(found.ok).toBe(true)
    if (!found.ok) return
    expect(found.value).toEqual<MailSummary[]>([
      { id: 'm1', threadId: 'th1', date: 'hoje', from: 'ana@exemplo', subject: 'a nota', snippet: 'um trecho' },
    ])
  })

  it('decodes the body and says when it was cut', async () => {
    const body = 'x'.repeat(5000)
    vi.stubGlobal('fetch', async () =>
      answer({
        id: 'm1',
        threadId: 'th1',
        payload: {
          mimeType: 'text/plain',
          headers: [{ name: 'Subject', value: 'longa' }],
          body: { data: Buffer.from(body).toString('base64url') },
        },
      }),
    )

    const got = await readMessage(tokens, 'm1')
    expect(got.ok).toBe(true)
    if (!got.ok) return
    expect(got.value.truncated).toBe(true)
    expect(got.value.html).toBe(false)
    // The cut is announced: a body that stops mid-sentence reads as the whole body.
    expect(got.value.text).toContain('more characters')
  })

  it('says what to do when the token is no longer good', async () => {
    vi.stubGlobal('fetch', async () => answer({ error: 'unauthorized' }, 401))
    const found = await searchMail(tokens, 'x', 1)
    expect(found.ok).toBe(false)
    if (found.ok) return
    expect(found.error).toContain('milo google connect')
  })
})

describe('the way to connecting', () => {
  it('reads the credentials.json from Google shortcut, in both shapes', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'milo-creds-'))
    try {
      const desktop = path.join(dir, 'desktop.json')
      writeFileSync(desktop, JSON.stringify({ installed: { client_id: 'id-1', client_secret: 's-1' } }))
      expect(clientFromCredentials(desktop)).toEqual({ clientId: 'id-1', clientSecret: 's-1' })

      // A web-type client keeps the same fields elsewhere, and refusing it would
      // be a rule about a file that is not ours.
      const web = path.join(dir, 'web.json')
      writeFileSync(web, JSON.stringify({ web: { client_id: 'id-2', client_secret: 's-2' } }))
      expect(clientFromCredentials(web)).toEqual({ clientId: 'id-2', clientSecret: 's-2' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('numbers the steps, and every link is a link', () => {
    const lines = googleStepsInWords()
    expect(lines[0]).toMatch(/^1\. /)
    const urls = lines.filter((line) => line.trim().startsWith('http'))
    expect(urls).toHaveLength(GOOGLE_STEPS.filter((step) => step.url).length)
    // The ones Google's own docs give as canonical, so they do not become a dead link.
    expect(urls.join('\n')).toContain('apis/enableflow;apiid=gmail.googleapis.com')
    expect(urls.join('\n')).toContain('apis/enableflow;apiid=drive.googleapis.com')
  })

  it('hands the code the browser brought to the local port, and closes the flow', async () => {
    const { awaitCode } = await import('../src/core/google/oauth.js')
    let consent = ''
    const flow = awaitCode({
      clientId: 'cid',
      verifier: 'v',
      timeoutMs: 5000,
      onUrl: (given) => {
        consent = given
      },
    })

    // `onUrl` arrives before the answer — it is the address the flow opens, and the
    // one Google would hit with the code. Hitting it is what proves the port.
    for (let attempt = 0; attempt < 100 && consent === ''; attempt += 1) await new Promise((r) => setTimeout(r, 10))
    const redirect = new URL(new URL(consent).searchParams.get('redirect_uri')!)

    const answered = await fetch(`${redirect.origin}/?code=abc`)
    expect(answered.status).toBe(200)
    expect(await answered.text()).toContain('Connected')

    expect(await flow).toEqual({ ok: true, value: { code: 'abc', redirectUri: redirect.toString() } })
  })
})

describe('the Gmail tools', () => {
  it('are read-only — nothing here writes', () => {
    const tools = createGmailTools(null)
    expect(tools.map((tool) => tool.name)).toEqual(['gmail_search', 'gmail_read'])
    expect(tools.every((tool) => tool.readOnly)).toBe(true)
  })

  it('with no account connected, say what is missing instead of failing on their own', async () => {
    const tools = createGmailTools(null)
    const found = await tools[0]!.execute({ query: 'is:unread' }, {} as never)
    expect(found.isError).toBe(true)
    expect(found.content).toContain('milo google connect')
  })
})

describe('Drive against a fake answer', () => {
  it('leaves the bin out of the search, because the Drive default includes it', async () => {
    let asked = ''
    vi.stubGlobal('fetch', async (input: URL | string) => {
      asked = String(input)
      return answer({ files: [], incompleteSearch: false })
    })

    await searchFiles(tokens, "name contains 'nota'", 5)
    // `URLSearchParams` writes a space as `+`, so the reading happens after that.
    const query = decodeURIComponent(asked).replace(/\+/g, ' ')
    expect(query).toContain("(name contains 'nota') and trashed = false")
    // Newest first: the last thing touched is usually the one being looked for.
    expect(query).toContain('modifiedTime desc')
  })

  it('passes it on when Drive says the search was partial', async () => {
    vi.stubGlobal('fetch', async () => answer({ files: [], incompleteSearch: true }))
    const listed = await searchFiles(tokens, 'x', 5)
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    expect(listed.value.incomplete).toBe(true)
  })

  it('exports a Google file instead of trying to download it', async () => {
    let exported = ''
    vi.stubGlobal('fetch', async (input: URL | string) => {
      const url = String(input)
      if (url.includes('/export')) {
        exported = url
        return new Response('o texto do documento')
      }
      if (url.includes('alt=media')) throw new Error('a native file has no bytes to download')
      return answer({ id: 'd1', name: 'Doc', mimeType: 'application/vnd.google-apps.document' })
    })

    const got = await readFile(tokens, 'd1')
    expect(got.ok).toBe(true)
    if (!got.ok) return
    expect(exported).toContain('mimeType=text%2Fplain')
    expect(got.value.exported).toBe(true)
    expect(got.value.text).toBe('o texto do documento')
  })

  it('downloads an ordinary file', async () => {
    vi.stubGlobal('fetch', async (input: URL | string) => {
      const url = String(input)
      if (url.includes('alt=media')) return new Response('linha\noutra linha')
      return answer({ id: 'f1', name: 'nota.txt', mimeType: 'text/plain' })
    })

    const got = await readFile(tokens, 'f1')
    expect(got.ok).toBe(true)
    if (!got.ok) return
    expect(got.value.exported).toBe(false)
    expect(got.value.text).toContain('outra linha')
  })

  it('says it is a folder, and what the next move is', async () => {
    vi.stubGlobal('fetch', async () =>
      answer({ id: 'p1', name: 'Contratos', mimeType: 'application/vnd.google-apps.folder' }),
    )

    const got = await readFile(tokens, 'p1')
    expect(got.ok).toBe(true)
    if (!got.ok) return
    expect(got.value.text).toContain('is a folder')
    expect(got.value.text).toContain("'p1' in parents")
  })

  it('does not pretend to have read what it cannot read', async () => {
    vi.stubGlobal('fetch', async () => answer({ id: 'b1', name: 'contrato.pdf', mimeType: 'application/pdf' }))
    const got = await readFile(tokens, 'b1')
    expect(got.ok).toBe(false)
    if (got.ok) return
    expect(got.error).toContain('application/pdf')
  })
})

describe('the Drive tools', () => {
  it('are read-only', () => {
    const tools = createDriveTools(null)
    expect(tools.map((tool) => tool.name)).toEqual(['drive_search', 'drive_read'])
    expect(tools.every((tool) => tool.readOnly)).toBe(true)
  })
})
