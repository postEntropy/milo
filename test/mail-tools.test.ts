import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = mkdtempSync(path.join(os.tmpdir(), 'milo-mail-tools-'))
process.env.MILO_HOME = home

const { createGmailWriteTools } = await import('../src/core/tools/mail-actions.js')
const { createMailLabelTools } = await import('../src/core/tools/mail-labels.js')
const { listLabels } = await import('../src/core/google/labels.js')

/** A grant at `modify`, which is what every account action needs. */
const account = {
  clientId: 'c',
  clientSecret: 's',
  refreshToken: 'r',
  email: 'ana@exemplo',
  access: 'modify' as const,
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Gmail behind a stubbed fetch: the token refresh is answered, the rest is handed on. */
function gmail(handler: (url: string, init?: RequestInit) => Response): void {
  vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input)
    if (url.includes('oauth2.googleapis.com/token')) return json({ access_token: 'at', expires_in: 3600 })
    return handler(url, init)
  })
}

/** A stand-in for the decision model: one answer per message id. */
const classifierOf = (answers: Record<string, { choice: string; confidence?: number }>) =>
  ({ ask: async () => answers }) as never

/** The inbox behind a stubbed Gmail: one message, whose headers are all a person sorts by. */
const inboxWith = (id: string, subject: string): void =>
  gmail((url) => {
    if (url.includes('/messages?')) return json({ messages: [{ id, threadId: `t-${id}` }] })
    return json({
      id,
      threadId: `t-${id}`,
      payload: { headers: [{ name: 'From', value: 'ana@exemplo' }, { name: 'Subject', value: subject }] },
    })
  })

const signal = (): AbortSignal => new AbortController().signal

afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(path.join(home, 'labels.json'), { force: true })
})

describe('the mail_labels tool', () => {
  it('is internal — a label is Milo’s own state, so it never asks', () => {
    const tools = createMailLabelTools({ account, classifier: null })
    expect(tools.map((tool) => tool.name)).toEqual(['mail_labels'])
    expect(tools[0]!.internal).toBe(true)
    expect(tools[0]!.readOnly).toBeUndefined()
  })

  it('creates a label, lists it, and drops it by name', async () => {
    const [tool] = createMailLabelTools({ account, classifier: null })
    const created = await tool!.execute({ action: 'create', name: 'Invoices', color: 'teal' }, {} as never)
    expect(created.content).toContain('Created the label "Invoices"')
    expect(listLabels()).toEqual([expect.objectContaining({ name: 'Invoices', color: 'teal' })])

    const listed = await tool!.execute({ action: 'list' }, {} as never)
    expect(listed.content).toContain('Invoices')

    const dropped = await tool!.execute({ action: 'delete', id: 'invoices' }, {} as never)
    expect(dropped.content).toContain('Dropped the label "Invoices"')
    expect(listLabels()).toEqual([])
  })

  it('answers a label it does not know with the ones it has', async () => {
    const [tool] = createMailLabelTools({ account, classifier: null })
    const result = await tool!.execute({ action: 'delete', id: 'nope' }, {} as never)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('No label "nope"')
  })

  it('puts a label on and takes it off a message by hand', async () => {
    const [tool] = createMailLabelTools({ account, classifier: null })
    await tool!.execute({ action: 'create', name: 'Invoices', color: 'teal' }, {} as never)
    const on = await tool!.execute({ action: 'assign', id: 'm1', label: 'Invoices', on: true }, {} as never)
    expect(on.content).toContain('Put the label "Invoices" on m1')
    const off = await tool!.execute({ action: 'assign', id: 'm1', label: 'Invoices', on: false }, {} as never)
    expect(off.content).toContain('Took the label "Invoices" off m1')
  })

  it('says which messages carry a label, sorting the page to find out', async () => {
    inboxWith('m1', 'a nota')
    const classifier = classifierOf({ m1: { choice: 'receipt', confidence: 0.9 } })
    const [tool] = createMailLabelTools({ account, classifier })

    const result = await tool!.execute({ action: 'messages', label: 'receipt' }, { signal: signal() } as never)
    expect(result.isError).toBeFalsy()
    expect(result.content).toContain('1 message with "Receipts"')
    expect(result.content).toContain('m1')
  })

  it('names a base label before anything was sorted into it, and says when nobody matched', async () => {
    inboxWith('m1', 'a nota')
    const classifier = classifierOf({ m1: { choice: 'newsletter', confidence: 0.9 } })
    const [tool] = createMailLabelTools({ account, classifier })

    // `receipt` was never materialised, yet the fixed taxonomy answers by name.
    const result = await tool!.execute({ action: 'messages', label: 'receipt' }, { signal: signal() } as never)
    expect(result.isError).toBeFalsy()
    expect(result.content).toContain('carry "Receipts"')
  })

  it('cannot match without a classifier, and says so rather than answering nothing', async () => {
    const [tool] = createMailLabelTools({ account, classifier: null })
    const result = await tool!.execute({ action: 'messages', label: 'receipt' }, { signal: signal() } as never)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('no classifier')
  })
})

describe('the gmail_modify tool', () => {
  it('is not read-only — it changes the account, so it asks', () => {
    const tools = createGmailWriteTools(account)
    expect(tools.map((tool) => tool.name)).toEqual(['gmail_modify', 'gmail_draft', 'gmail_send'])
    expect(tools[0]!.readOnly).toBeUndefined()
    expect(tools[0]!.internal).toBeUndefined()
  })

  it('bins a message over messages/trash', async () => {
    let asked = ''
    let method = ''
    gmail((url, init) => {
      asked = url
      method = init?.method ?? 'GET'
      return json({ id: 'm1' })
    })

    const [tool] = createGmailWriteTools(account)
    const result = await tool!.execute({ id: 'm1', op: 'trash' }, {} as never)
    expect(result.isError).toBeFalsy()
    expect(result.content).toBe('Moved m1 to the bin.')
    expect(method).toBe('POST')
    expect(asked).toContain('/messages/m1/trash')
  })

  it('archives a message by taking INBOX off', async () => {
    let body = ''
    gmail((_url, init) => {
      body = String(init?.body ?? '')
      return json({ id: 'm1' })
    })

    const [tool] = createGmailWriteTools(account)
    const result = await tool!.execute({ id: 'm1', op: 'archive' }, {} as never)
    expect(result.content).toBe('Archived m1.')
    expect(JSON.parse(body)).toEqual({ removeLabelIds: ['INBOX'] })
  })

  it('passes the grant refusal through, naming the level to reconnect at', async () => {
    gmail(() => json({}))
    const [tool] = createGmailWriteTools({ ...account, access: 'none' as never })
    const result = await tool!.execute({ id: 'm1', op: 'trash' }, {} as never)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('--access modify')
  })

  it('with no account connected, says what to run instead of failing on its own', async () => {
    const [tool] = createGmailWriteTools(null)
    const result = await tool!.execute({ id: 'm1', op: 'trash' }, {} as never)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('milo google connect')
  })
})

/** One of the tools that write mail, by name, at the access level given. */
const writeTool = (
  name: 'gmail_draft' | 'gmail_send',
  access: 'modify' | 'compose' | 'send' = 'send',
) => createGmailWriteTools({ ...account, access }).find((tool) => tool.name === name)!

describe('the gmail_draft tool', () => {
  const drafter = (access: 'modify' | 'compose' = 'compose') => writeTool('gmail_draft', access)

  it('is not read-only — it writes to the account, so it asks', () => {
    const draft = drafter()
    expect(draft.name).toBe('gmail_draft')
    expect(draft.readOnly).toBeUndefined()
    expect(draft.internal).toBeUndefined()
  })

  it('leaves the message in Drafts, over drafts rather than messages/send', async () => {
    let asked = ''
    let body = ''
    gmail((url, init) => {
      asked = url
      body = String(init?.body ?? '')
      return json({ id: 'd1' })
    })

    const result = await drafter().execute(
      { to: 'ana@exemplo', subject: 'Weekly note', body: 'All good.' },
      {} as never,
    )

    expect(result.isError).toBeFalsy()
    expect(result.content).toBe('Drafted "Weekly note" to ana@exemplo — it sits in Drafts, nothing was sent.')
    expect(asked).toContain('/drafts')
    expect(asked).not.toContain('/messages/send')
    const payload = JSON.parse(body) as { message: { raw: string } }
    const raw = Buffer.from(payload.message.raw, 'base64url').toString('utf8')
    expect(raw).toContain('To: ana@exemplo')
    expect(raw).toContain('Subject: Weekly note')
  })

  it('answers in the thread it was given, rather than starting one', async () => {
    let body = ''
    gmail((_url, init) => {
      body = String(init?.body ?? '')
      return json({ id: 'd2' })
    })

    await drafter().execute(
      { to: 'ana@exemplo', subject: 'Re: Weekly note', body: 'Thanks.', threadId: 't-1' },
      {} as never,
    )
    expect((JSON.parse(body) as { message: { threadId?: string } }).message.threadId).toBe('t-1')
  })

  it('passes the grant refusal through, naming the level to reconnect at', async () => {
    gmail(() => json({}))
    const result = await drafter('modify').execute(
      { to: 'ana@exemplo', subject: 's', body: 'b' },
      {} as never,
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain('--access compose')
  })

  it('refuses an address that is not one, and writes nothing', async () => {
    const asked: string[] = []
    gmail((url) => {
      asked.push(url)
      return json({ id: 'd1' })
    })

    const result = await drafter().execute({ to: 'ana', subject: 's', body: 'b' }, {} as never)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('not an email address')
    expect(asked.some((url) => url.includes('/drafts'))).toBe(false)
  })

  it('with no account connected, says what to run instead of failing on its own', async () => {
    const draft = createGmailWriteTools(null).find((tool) => tool.name === 'gmail_draft')!
    const result = await draft.execute({ to: 'ana@exemplo', subject: 's', body: 'b' }, {} as never)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('milo google connect')
  })
})

describe('the gmail_send tool', () => {
  const sender = (access: 'compose' | 'send' = 'send') => writeTool('gmail_send', access)

  it('is not read-only — it sends as the person, so it asks', () => {
    const send = sender()
    expect(send.name).toBe('gmail_send')
    expect(send.readOnly).toBeUndefined()
    expect(send.internal).toBeUndefined()
  })

  it('sends over messages/send, in the shape Gmail carries', async () => {
    let asked = ''
    let body = ''
    gmail((url, init) => {
      asked = url
      body = String(init?.body ?? '')
      return json({ id: 'm1' })
    })

    const result = await sender().execute(
      { to: 'ana@exemplo', subject: 'Weekly note', body: 'All good.' },
      {} as never,
    )

    expect(result.isError).toBeFalsy()
    expect(result.content).toBe('Sent "Weekly note" to ana@exemplo.')
    expect(asked).toContain('/messages/send')
    const payload = JSON.parse(body) as { raw: string; threadId?: string }
    // A new message is not threaded onto anything.
    expect(payload.threadId).toBeUndefined()
    const raw = Buffer.from(payload.raw, 'base64url').toString('utf8')
    expect(raw).toContain('To: ana@exemplo')
    expect(raw).toContain('Subject: Weekly note')
    expect(raw).toContain(Buffer.from('All good.', 'utf8').toString('base64'))
  })

  it('answers in the thread it was given, rather than starting one', async () => {
    let body = ''
    gmail((_url, init) => {
      body = String(init?.body ?? '')
      return json({ id: 'm2' })
    })

    await sender().execute(
      { to: 'ana@exemplo', subject: 'Re: Weekly note', body: 'Thanks.', threadId: 't-1' },
      {} as never,
    )
    expect((JSON.parse(body) as { threadId?: string }).threadId).toBe('t-1')
  })

  it('passes the grant refusal through, naming the level to reconnect at', async () => {
    gmail(() => json({}))
    const result = await sender('compose').execute(
      { to: 'ana@exemplo', subject: 's', body: 'b' },
      {} as never,
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain('--access send')
  })

  it('refuses an address that is not one, and sends nothing', async () => {
    const asked: string[] = []
    gmail((url) => {
      asked.push(url)
      return json({ id: 'm1' })
    })

    const result = await sender().execute({ to: 'ana', subject: 's', body: 'b' }, {} as never)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('not an email address')
    expect(asked.some((url) => url.includes('/messages/send'))).toBe(false)
  })

  it('refuses to send a message with nothing in it', async () => {
    gmail(() => json({ id: 'm1' }))
    const result = await sender().execute({ to: 'ana@exemplo', subject: 's', body: '  ' }, {} as never)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('empty')
  })

  it('with no account connected, says what to run instead of failing on its own', async () => {
    const send = createGmailWriteTools(null).find((tool) => tool.name === 'gmail_send')!
    const result = await send.execute({ to: 'ana@exemplo', subject: 's', body: 'b' }, {} as never)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('milo google connect')
  })
})
