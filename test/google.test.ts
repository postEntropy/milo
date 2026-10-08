import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  challengeFor,
  consentUrl,
  DRIVE_READONLY,
  GMAIL_COMPOSE,
  GMAIL_MODIFY,
  GMAIL_READONLY,
  GMAIL_SEND,
  GOOGLE_READ_SCOPES,
  refreshAccessToken,
  scopesFor,
} from '../src/core/google/oauth.js'
import { read as readFile, search as searchFiles } from '../src/core/google/drive.js'
import {
  archive,
  createDraft,
  listInbox,
  read as readMessage,
  search as searchMail,
  sendMessage,
  setRead,
  trashMessage,
  unreadSince,
  type MailSummary,
} from '../src/core/google/gmail.js'
import { googleState } from '../src/core/google/state.js'
import { accessOf, GOOGLE_TIERS, type GoogleAccess } from '../src/core/google/tiers.js'
import { GOOGLE_STEPS, googleStepsInWords } from '../src/core/google/walkthrough.js'
import { clientFromCredentials, runGoogle } from '../src/bin/google.js'
import { createDriveTools } from '../src/core/tools/drive.js'
import { createGmailTools } from '../src/core/tools/gmail.js'

const tokens = { accessToken: 't', expiresAt: Date.now() + 60_000 }
const answer = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

afterEach(() => vi.unstubAllGlobals())

describe('Google consent', () => {
  const url = (access: GoogleAccess): URL =>
    new URL(consentUrl({ clientId: 'cid', redirectUri: 'http://127.0.0.1:1/', verifier: 'v', access }))

  it('asks for exactly the read scopes at the read-only level — no write scope', () => {
    // The exact list rather than a "contains": a write scope sneaking into the
    // read-only grant would break this test, which is the point of it.
    expect(url('none').searchParams.get('scope')?.split(' ')).toEqual([GMAIL_READONLY, DRIVE_READONLY])
  })

  it('widens the grant one level at a time, and never past the level chosen', () => {
    expect(scopesFor('none')).toEqual(GOOGLE_READ_SCOPES)
    expect(scopesFor('modify')).toEqual([...GOOGLE_READ_SCOPES, GMAIL_MODIFY])
    expect(scopesFor('compose')).toEqual([...GOOGLE_READ_SCOPES, GMAIL_MODIFY, GMAIL_COMPOSE])
    expect(scopesFor('send')).toEqual([...GOOGLE_READ_SCOPES, GMAIL_MODIFY, GMAIL_COMPOSE, GMAIL_SEND])
  })

  it('carries the chosen level in the consent URL, offline, with PKCE', () => {
    expect(url('send').searchParams.get('scope')?.split(' ')).toContain(GMAIL_SEND)
    // Without `offline` no refresh token comes at all — and nothing outlives the process.
    expect(url('none').searchParams.get('access_type')).toBe('offline')
    expect(url('none').searchParams.get('code_challenge_method')).toBe('S256')
    expect(url('none').searchParams.get('code_challenge')).toBe(challengeFor('v'))
    expect(url('none').searchParams.get('client_id')).toBe('cid')
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

describe('Gmail beyond reading', () => {
  it('refuses a write the grant does not cover, and says how to get it', async () => {
    const archived = await archive(tokens, 'none', 'm1')
    expect(archived.ok).toBe(false)
    if (archived.ok) return
    expect(archived.error).toContain('--access modify')
    expect(archived.error).toContain('Read only')
  })

  it('keeps each write behind the level it needs, and no lower', async () => {
    const draft = await createDraft(tokens, 'modify', { to: 'a@b', subject: 's', body: 'b' })
    expect(draft.ok).toBe(false)
    if (!draft.ok) expect(draft.error).toContain('--access compose')

    const sent = await sendMessage(tokens, 'compose', { to: 'a@b', subject: 's', body: 'b' })
    expect(sent.ok).toBe(false)
    if (!sent.ok) expect(sent.error).toContain('--access send')
  })

  it('archives by taking INBOX off, over a POST', async () => {
    let method = ''
    let body = ''
    vi.stubGlobal('fetch', async (_input: URL | string, init?: RequestInit) => {
      method = init?.method ?? 'GET'
      body = String(init?.body ?? '')
      return answer({ id: 'm1', threadId: 't1' })
    })

    const done = await archive(tokens, 'modify', 'm1')
    expect(done.ok).toBe(true)
    expect(method).toBe('POST')
    expect(JSON.parse(body)).toEqual({ removeLabelIds: ['INBOX'] })
  })

  it('bins a message over messages/trash, at the modify level', async () => {
    let asked = ''
    let method = ''
    vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) => {
      asked = String(input)
      method = init?.method ?? 'GET'
      return answer({ id: 'm1', threadId: 't1' })
    })

    const done = await trashMessage(tokens, 'modify', 'm1')
    expect(done.ok).toBe(true)
    if (!done.ok) return
    expect(done.value.id).toBe('m1')
    // Gmail's `trash`, not `delete`: the message stays in the account.
    expect(method).toBe('POST')
    expect(asked).toContain('/messages/m1/trash')
    expect(asked).not.toContain('/delete')
  })

  it('refuses to bin a message below the modify level, and says how to get it', async () => {
    const denied = await trashMessage(tokens, 'none', 'm1')
    expect(denied.ok).toBe(false)
    if (denied.ok) return
    expect(denied.error).toContain('--access modify')
    expect(denied.error).toContain('Read only')
  })

  it('marks read by clearing UNREAD, and unread by putting it back', async () => {
    const bodies: string[] = []
    vi.stubGlobal('fetch', async (_input: URL | string, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ''))
      return answer({ id: 'm1' })
    })

    await setRead(tokens, 'modify', 'm1', true)
    await setRead(tokens, 'modify', 'm1', false)
    expect(bodies.map((one) => JSON.parse(one))).toEqual([
      { removeLabelIds: ['UNREAD'] },
      { addLabelIds: ['UNREAD'] },
    ])
  })

  it('writes a draft as RFC 822, folding a header someone tried to inject', async () => {
    let sent = ''
    vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/drafts')) {
        sent = String(init?.body ?? '')
        return answer({ id: 'd1' })
      }
      throw new Error(`unexpected ${url}`)
    })

    const draft = await createDraft(tokens, 'compose', {
      to: 'ana@exemplo',
      subject: 'nota\r\nBcc: evil@x',
      body: 'oi',
    })
    expect(draft.ok).toBe(true)
    const raw = Buffer.from(JSON.parse(sent).message.raw, 'base64url').toString('utf8')
    expect(raw).toContain('To: ana@exemplo')
    // The newline is gone, so the value stays one header instead of becoming two.
    expect(raw).toContain('Subject: nota Bcc: evil@x')
    expect(raw).not.toContain('\r\nBcc:')
  })

  it('sends at the send level, over messages/send', async () => {
    let asked = ''
    vi.stubGlobal('fetch', async (input: URL | string) => {
      asked = String(input)
      return answer({ id: 'm9' })
    })

    const sent = await sendMessage(tokens, 'send', { to: 'ana@exemplo', subject: 'oi', body: 'texto' })
    expect(sent.ok).toBe(true)
    if (!sent.ok) return
    expect(sent.value.id).toBe('m9')
    expect(asked).toContain('/messages/send')
  })

  it('carries the label ids a message has, which is how the list tells read from unread', async () => {
    vi.stubGlobal('fetch', async () =>
      answer({
        id: 'm1',
        threadId: 't1',
        labelIds: ['INBOX', 'UNREAD'],
        payload: { headers: [{ name: 'Subject', value: 'a nota' }] },
      }),
    )

    const message = await readMessage(tokens, 'm1')
    expect(message.ok).toBe(true)
    if (!message.ok) return
    expect(message.value.labelIds).toEqual(['INBOX', 'UNREAD'])
  })

  it('pages the inbox with in:inbox, handing Gmail its own cursor back', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', async (input: URL | string) => {
      const url = String(input)
      urls.push(url)
      if (url.includes('/messages?')) {
        return answer({ messages: [{ id: 'm1', threadId: 't1' }], nextPageToken: 'cursor' })
      }
      return answer({ id: 'm1', threadId: 't1', payload: { headers: [{ name: 'Subject', value: 'a nota' }] } })
    })

    const page = await listInbox(tokens, { limit: 5 })
    expect(page.ok).toBe(true)
    if (!page.ok) return
    expect(page.value.nextPageToken).toBe('cursor')
    expect(page.value.messages[0]?.subject).toBe('a nota')
    expect(decodeURIComponent(urls[0]!).replace(/\+/g, ' ')).toContain('in:inbox')
  })
})

describe('the unread badge count', () => {
  it('counts the unread newer than a moment, and says when there are more', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', async (input: URL | string) => {
      urls.push(String(input))
      return answer({ messages: [{ id: 'm1' }, { id: 'm2' }], nextPageToken: 'cursor' })
    })

    const counted = await unreadSince(tokens, 1_700_000_000_000)
    expect(counted.ok).toBe(true)
    if (!counted.ok) return
    expect(counted.value).toEqual({ count: 2, more: true })
    const query = new URL(urls[0]!).searchParams
    expect(query.get('q')).toBe('in:inbox is:unread after:1700000000')
    expect(query.get('maxResults')).toBe('99')
  })

  it('counts every unread in the inbox when the inbox was never looked at', async () => {
    let q = ''
    vi.stubGlobal('fetch', async (input: URL | string) => {
      q = new URL(String(input)).searchParams.get('q') ?? ''
      return answer({ messages: [{ id: 'm1' }] })
    })

    const counted = await unreadSince(tokens, 0)
    expect(counted.ok).toBe(true)
    if (!counted.ok) return
    expect(counted.value).toEqual({ count: 1, more: false })
    expect(q).toBe('in:inbox is:unread')
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
      access: 'none',
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

describe('the access level', () => {
  const io = (): { out: string[]; err: string[]; io: Parameters<typeof runGoogle>[1] } => {
    const out: string[] = []
    const err: string[] = []
    return { out, err, io: { out: (line) => out.push(line), err: (line) => err.push(line), ask: async () => '', askHidden: async () => '' } }
  }

  it('has no default: a connect run with no terminal to ask on stops', async () => {
    const { err, io: streams } = io()
    const code = await runGoogle(['google', 'connect', '--client-id', 'x', '--client-secret', 'y'], streams)
    expect(code).toBe(1)
    expect(err.join('\n')).toContain('No access level was chosen')
    expect(err.join('\n')).toContain(GOOGLE_TIERS.map((tier) => tier.id).join(', '))
  })

  it('refuses a level it does not know, and answers with the valid ones', async () => {
    const { err, io: streams } = io()
    const code = await runGoogle(
      ['google', 'connect', '--client-id', 'x', '--client-secret', 'y', '--access', 'everything'],
      streams,
    )
    expect(code).toBe(1)
    expect(err.join('\n')).toContain('Unknown access level: everything')
    expect(err.join('\n')).toContain('none')
  })

  it('reads a grant made before the choice existed as read-only', () => {
    expect(accessOf({})).toBe('none')
    const state = googleState(null, {
      providers: {},
      gateways: {},
      search: {},
      google: { clientId: 'c', clientSecret: 's', refreshToken: 'r' },
    })
    expect(state).toMatchObject({ kind: 'connected', access: 'none' })
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
