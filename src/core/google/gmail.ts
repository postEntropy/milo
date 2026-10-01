/**
 * Gmail, read-only: find messages, then read one.
 *
 * Two calls rather than one because that is the shape of the API — `messages.list`
 * answers with ids, and a body only comes from `messages.get` with `format=full`.
 * Searching *then* reading is also the cheaper order: one list plus the messages
 * that mattered, instead of every hit's body.
 */
import { authorizedJson, type GoogleOutcome, type GoogleTokens } from './oauth.js'

const API = 'https://gmail.googleapis.com/gmail/v1/users/me'

/** Bodies are cut here: a newsletter is not worth a context window. */
export const BODY_LIMIT = 4000

export interface MailSummary {
  id: string
  threadId: string
  date?: string
  from?: string
  subject?: string
  snippet?: string
}

export interface MailMessage extends MailSummary {
  text: string
  /** True when the body was cut, so a short read is never mistaken for the whole. */
  truncated: boolean
  /** True when the message has no plain-text part and this is its HTML. */
  html: boolean
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
  return {
    id,
    threadId: asString((message as { threadId?: unknown }).threadId) ?? '',
    ...(header(payload, 'Date') ? { date: header(payload, 'Date')! } : {}),
    ...(header(payload, 'From') ? { from: header(payload, 'From')! } : {}),
    ...(header(payload, 'Subject') ? { subject: header(payload, 'Subject')! } : {}),
    ...(asString((message as { snippet?: unknown }).snippet)
      ? { snippet: asString((message as { snippet?: unknown }).snippet)! }
      : {}),
  }
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

  const messages = (listed.value as { messages?: unknown }).messages
  const found: string[] = Array.isArray(messages)
    ? messages.flatMap((entry) => (asString((entry as { id?: unknown }).id) ? [asString((entry as { id?: unknown }).id)!] : []))
    : []
  if (found.length === 0) return { ok: true, value: [] }

  // Metadata only, and only the three headers a person chooses by — the bodies
  // come one at a time, for whichever of these the model then decides to read.
  const details = await Promise.all(
    found.map((id) =>
      authorizedJson(
        tokens,
        endpoint(`messages/${id}`, { format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] }),
      ),
    ),
  )

  const summaries: MailSummary[] = []
  for (const [index, detail] of details.entries()) {
    if (!detail.ok) return detail
    summaries.push(summaryOf(found[index]!, detail.value))
  }
  return { ok: true, value: summaries }
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

/** One message, in full, cut to `BODY_LIMIT`. */
export async function read(tokens: GoogleTokens, id: string): Promise<GoogleOutcome<MailMessage>> {
  const fetched = await authorizedJson(tokens, endpoint(`messages/${id}`, { format: 'full' }))
  if (!fetched.ok) return fetched

  const payload = (fetched.value as { payload?: unknown }).payload
  const { text, html } = plainText(payload)
  const cut = text.length > BODY_LIMIT
  return {
    ok: true,
    value: {
      ...summaryOf(id, fetched.value),
      text: cut ? `${text.slice(0, BODY_LIMIT)}\n… [cut here: ${text.length - BODY_LIMIT} more characters]` : text,
      truncated: cut,
      html,
    },
  }
}

/** Who the grant belongs to, read off the profile: the proof `connect` shows. */
export async function profile(tokens: GoogleTokens): Promise<GoogleOutcome<string>> {
  const got = await authorizedJson(tokens, endpoint('profile'))
  if (!got.ok) return got
  const address = asString((got.value as { emailAddress?: unknown }).emailAddress)
  return address ? { ok: true, value: address } : { ok: false, error: 'Gmail did not say which address this is.' }
}
