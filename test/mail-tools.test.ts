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
    expect(tools.map((tool) => tool.name)).toEqual(['gmail_modify'])
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
