/**
 * Gmail: find messages, read them, and — at the level the grant allows — act on
 * them.
 *
 * Reading is two calls rather than one because that is the shape of the API —
 * `messages.list` answers with ids, and a body only comes from `messages.get`
 * with `format=full`. Searching *then* reading is also the cheaper order: one
 * list plus the messages that mattered, instead of every hit's body.
 *
 * Each write takes the level it needs and refuses below it with the sentence
 * that fixes it, so a missing scope can never surface as a bare 403.
 */
import { authorizedJson, type GoogleOutcome, type GoogleTokens } from './oauth.js'
import { accessLabel, tierAtLeast, type GoogleAccess } from './tiers.js'

const API = 'https://gmail.googleapis.com/gmail/v1/users/me'

/**
 * The grant a write needs, or the sentence saying how to get it. One place, so
 * the policy lives at the single point of decision rather than being re-derived
 * by every caller.
 */
function allowed(access: GoogleAccess, needed: 'modify' | 'compose' | 'send'): GoogleOutcome<never> | null {
  if (tierAtLeast(access, needed)) return null
  return {
    ok: false,
    error:
      `Milo's Google grant is ${accessLabel(access)} — this needs ${accessLabel(needed)}. ` +
      `Reconnect with \`milo google connect --access ${needed}\`.`,
  }
}

/** Bodies are cut here: a newsletter is not worth a context window. */
export const BODY_LIMIT = 4000

export interface MailSummary {
  id: string
  threadId: string
  date?: string
  from?: string
  subject?: string
  snippet?: string
  /** The labels the message carries, which is the state the label picker toggles. */
  labelIds?: string[]
}

export interface MailMessage extends MailSummary {
  text: string
  /** True when the body was cut, so a short read is never mistaken for the whole. */
  truncated: boolean
  /** True when the message has no plain-text part and this is its HTML. */
  html: boolean
}

export interface InboxPage {
  messages: MailSummary[]
  /** Gmail's cursor for the next page; absent when this was the last one. */
  nextPageToken?: string
}

/**
 * The inbox's quick filters, each one Gmail's own `is:` operator and the word the
 * screen draws beside it. Declared once, here, so the query and the row of controls
 * that offers it cannot come to disagree about what a filter is.
 */
export const INBOX_FILTERS = [
  { id: 'unread', label: 'Unread' },
  { id: 'starred', label: 'Starred' },
] as const

export type InboxFilter = (typeof INBOX_FILTERS)[number]['id']

export interface InboxQuery {
  pageToken?: string
  limit?: number
  /** Narrow to one of the quick filters. */
  filter?: InboxFilter
  /** Free text as typed, in Gmail's own syntax — a plain word and `from:ana` alike. */
  search?: string
}

/**
 * The Gmail query a page of the inbox is asked for: the inbox itself, narrowed by the
 * quick filter and by whatever the person typed. Built on the side that speaks Gmail's
 * syntax, so the page sends a word and a filter rather than a query string.
 */
export function inboxQuery(options: { filter?: InboxFilter; search?: string } = {}): string {
  const terms = ['in:inbox']
  if (options.filter) terms.push(`is:${options.filter}`)
  const typed = options.search?.trim()
  if (typed) terms.push(typed)
  return terms.join(' ')
}

export interface MailThread {
  id: string
  messages: MailMessage[]
}

export interface DraftInput {
  to: string
  subject: string
  body: string
  /** Set when the draft answers a thread rather than starting one. */
  threadId?: string
}

/** The URL for one call, with a repeated parameter for each header asked for. */
function endpoint(path: string, query: Record<string, string | string[]> = {}): URL {
  const url = new URL(`${API}/${path}`)
  for (const [key, value] of Object.entries(query)) {
    for (const one of Array.isArray(value) ? value : [value]) url.searchParams.append(key, one)
  }
  return url
}

const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

/** The header the message carries, by name — the API hands them as a list. */
function header(payload: unknown, name: string): string | undefined {
  const headers = (payload as { headers?: unknown }).headers
  if (!Array.isArray(headers)) return undefined
  const found = headers.find(
    (entry) => asString((entry as { name?: unknown }).name)?.toLowerCase() === name.toLowerCase(),
  )
  return found ? asString((found as { value?: unknown }).value) : undefined
}

function summaryOf(id: string, message: unknown): MailSummary {
  const payload = (message as { payload?: unknown }).payload
  const labels = (message as { labelIds?: unknown }).labelIds
  return {
    id,
    threadId: asString((message as { threadId?: unknown }).threadId) ?? '',
    ...(Array.isArray(labels)
      ? { labelIds: labels.filter((label): label is string => typeof label === 'string') }
      : {}),
    ...(header(payload, 'Date') ? { date: header(payload, 'Date')! } : {}),
    ...(header(payload, 'From') ? { from: header(payload, 'From')! } : {}),
    ...(header(payload, 'Subject') ? { subject: header(payload, 'Subject')! } : {}),
    ...(asString((message as { snippet?: unknown }).snippet)
      ? { snippet: asString((message as { snippet?: unknown }).snippet)! }
      : {}),
  }
}

/** The ids a `messages.list`-shaped payload carries, in order. */
function idsOf(payload: unknown): string[] {
  const messages = (payload as { messages?: unknown } | null)?.messages
  if (!Array.isArray(messages)) return []
  return messages.flatMap((entry) =>
    asString((entry as { id?: unknown }).id) ? [asString((entry as { id?: unknown }).id)!] : [],
  )
}

/**
 * List metadata for a set of ids — the three headers a person chooses by, never
 * the bodies: those come one at a time, for whichever the model decides to read.
 */
async function summariesFor(tokens: GoogleTokens, ids: string[]): Promise<GoogleOutcome<MailSummary[]>> {
  const details = await Promise.all(
    ids.map((id) =>
      authorizedJson(
        tokens,
        endpoint(`messages/${encodeURIComponent(id)}`, { format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] }),
      ),
    ),
  )

  const summaries: MailSummary[] = []
  for (const [index, detail] of details.entries()) {
    if (!detail.ok) return detail
    summaries.push(summaryOf(ids[index]!, detail.value))
  }
  return { ok: true, value: summaries }
}

/**
 * Search, in Gmail's own syntax — the same one the web search box takes, which is
 * worth saying in the tool's words so the model does not invent a query language.
 */
export async function search(
  tokens: GoogleTokens,
  query: string,
  limit: number,
): Promise<GoogleOutcome<MailSummary[]>> {
  const listed = await authorizedJson(tokens, endpoint('messages', { q: query, maxResults: String(limit) }))
  if (!listed.ok) return listed
  const found = idsOf(listed.value)
  if (found.length === 0) return { ok: true, value: [] }
  return summariesFor(tokens, found)
}

/** The message's own words, from whichever part carries them. */
function plainText(payload: unknown): { text: string; html: boolean } {
  const walk = (part: unknown): { text: string; html: boolean } | null => {
    if (!part || typeof part !== 'object') return null
    const { mimeType, body, parts } = part as { mimeType?: unknown; body?: unknown; parts?: unknown }
    const data = (body as { data?: unknown } | undefined)?.data
    if (asString(data)) {
      const decoded = Buffer.from(asString(data)!, 'base64url').toString('utf8')
      if (mimeType === 'text/plain') return { text: decoded, html: false }
      if (mimeType === 'text/html') {
        // Tried after a plain part: a multipart message almost always has one, and
        // this is the fallback for the rest.
        return { text: decoded, html: true }
      }
    }
    if (Array.isArray(parts)) {
      const found = parts.flatMap((child) => {
        const walked = walk(child)
        return walked ? [walked] : []
      })
      return found.find((one) => !one.html) ?? found[0] ?? null
    }
    return null
  }

  return walk(payload) ?? { text: '', html: false }
}

/** One message, out of an API payload, cut to `BODY_LIMIT`. */
function messageOf(id: string, raw: unknown): MailMessage {
  const payload = (raw as { payload?: unknown }).payload
  const { text, html } = plainText(payload)
  const cut = text.length > BODY_LIMIT
  return {
    ...summaryOf(id, raw),
    text: cut ? `${text.slice(0, BODY_LIMIT)}\n… [cut here: ${text.length - BODY_LIMIT} more characters]` : text,
    truncated: cut,
    html,
  }
}

/** One message, in full, cut to `BODY_LIMIT`. */
export async function read(tokens: GoogleTokens, id: string): Promise<GoogleOutcome<MailMessage>> {
  const fetched = await authorizedJson(tokens, endpoint(`messages/${encodeURIComponent(id)}`, { format: 'full' }))
  if (!fetched.ok) return fetched
  return { ok: true, value: messageOf(id, fetched.value) }
}

/** The inbox, a page at a time: `q: 'in:inbox'` with Gmail's own cursor. */
export async function listInbox(
  tokens: GoogleTokens,
  options: InboxQuery = {},
): Promise<GoogleOutcome<InboxPage>> {
  const query: Record<string, string> = { q: inboxQuery(options), maxResults: String(options.limit ?? 20) }
  if (options.pageToken) query.pageToken = options.pageToken

  const listed = await authorizedJson(tokens, endpoint('messages', query))
  if (!listed.ok) return listed

  const found = idsOf(listed.value)
  const summaries = found.length === 0
    ? ({ ok: true, value: [] } as GoogleOutcome<MailSummary[]>)
    : await summariesFor(tokens, found)
  if (!summaries.ok) return summaries

  const next = asString((listed.value as { nextPageToken?: unknown }).nextPageToken)
  return { ok: true, value: { messages: summaries.value, ...(next ? { nextPageToken: next } : {}) } }
}

/** One thread, every message in it, bodies and all. */
export async function readThread(tokens: GoogleTokens, threadId: string): Promise<GoogleOutcome<MailThread>> {
  const got = await authorizedJson(tokens, endpoint(`threads/${encodeURIComponent(threadId)}`, { format: 'full' }))
  if (!got.ok) return got
  const entries = (got.value as { messages?: unknown }).messages
  const list = Array.isArray(entries) ? entries : []
  return {
    ok: true,
    value: {
      id: threadId,
      messages: list.map((entry, index) =>
        messageOf(asString((entry as { id?: unknown }).id) ?? `${threadId}-${index}`, entry),
      ),
    },
  }
}

/** A label change on one message — what archive, read and the label edits all are. */
export async function modifyMessage(
  tokens: GoogleTokens,
  access: GoogleAccess,
  id: string,
  change: { add?: string[]; remove?: string[] },
): Promise<GoogleOutcome<{ id: string }>> {
  const denied = allowed(access, 'modify')
  if (denied) return denied

  const changed = await authorizedJson(tokens, endpoint(`messages/${encodeURIComponent(id)}/modify`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...(change.add && change.add.length > 0 ? { addLabelIds: change.add } : {}),
      ...(change.remove && change.remove.length > 0 ? { removeLabelIds: change.remove } : {}),
    }),
  })
  if (!changed.ok) return changed
  return { ok: true, value: { id } }
}

/** Out of the inbox, kept — `INBOX` is a label like any other. */
export function archive(tokens: GoogleTokens, access: GoogleAccess, id: string): Promise<GoogleOutcome<{ id: string }>> {
  return modifyMessage(tokens, access, id, { remove: ['INBOX'] })
}

/** Read or unread: `UNREAD` present means unread. */
export function setRead(
  tokens: GoogleTokens,
  access: GoogleAccess,
  id: string,
  read: boolean,
): Promise<GoogleOutcome<{ id: string }>> {
  return modifyMessage(tokens, access, id, read ? { remove: ['UNREAD'] } : { add: ['UNREAD'] })
}

/** A message Gmail will carry, as RFC 822 in the base64url the API takes. */
function rawMessage(mail: { to: string; subject: string; body: string }): string {
  // Newlines in a header are how a value becomes a second header; an address or a
  // subject is one line, so any it carries is folded away rather than passed on.
  const oneLine = (value: string): string => value.replace(/[\r\n]+/g, ' ').trim()
  const headers = [
    `To: ${oneLine(mail.to)}`,
    `Subject: ${oneLine(mail.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
  ]
  return Buffer.from([...headers, '', mail.body].join('\r\n'), 'utf8').toString('base64url')
}

/** A draft, written and left in Drafts — nothing is sent by this call. */
export async function createDraft(
  tokens: GoogleTokens,
  access: GoogleAccess,
  draft: DraftInput,
): Promise<GoogleOutcome<{ id: string }>> {
  const denied = allowed(access, 'compose')
  if (denied) return denied

  const created = await authorizedJson(tokens, endpoint('drafts'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      message: { raw: rawMessage(draft), ...(draft.threadId ? { threadId: draft.threadId } : {}) },
    }),
  })
  if (!created.ok) return created
  const id = asString((created.value as { id?: unknown }).id)
  return id
    ? { ok: true, value: { id } }
    : { ok: false, error: 'Gmail created a draft without saying which one.' }
}

/** A message sent as the account. The only call here that leaves the account. */
export async function sendMessage(
  tokens: GoogleTokens,
  access: GoogleAccess,
  mail: { to: string; subject: string; body: string },
): Promise<GoogleOutcome<{ id: string }>> {
  const denied = allowed(access, 'send')
  if (denied) return denied

  const sent = await authorizedJson(tokens, endpoint('messages/send'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ raw: rawMessage(mail) }),
  })
  if (!sent.ok) return sent
  const id = asString((sent.value as { id?: unknown }).id)
  return id
    ? { ok: true, value: { id } }
    : { ok: false, error: 'Gmail sent the message without saying which one.' }
}

/** Who the grant belongs to, read off the profile: the proof `connect` shows. */
export async function profile(tokens: GoogleTokens): Promise<GoogleOutcome<string>> {
  const got = await authorizedJson(tokens, endpoint('profile'))
  if (!got.ok) return got
  const address = asString((got.value as { emailAddress?: unknown }).emailAddress)
  return address ? { ok: true, value: address } : { ok: false, error: 'Gmail did not say which address this is.' }
}
