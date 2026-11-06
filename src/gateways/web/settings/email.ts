import { tokenSource, type TokenSource } from '../../../core/google/access.js'
import { ASSIST_MODES, emailAssist, type AssistMode } from '../../../core/google/assist.js'
import {
  applyMailOperation, createDraft, INBOX_FILTERS, isMailOperation, listInbox,
  MAIL_OPERATIONS, read as readMail, readBody, readThread, search as searchMail,
  sendMessage, unreadSince, type DraftInput, type InboxFilter, type MailSummary,
} from '../../../core/google/gmail.js'
import { htmlToText } from '../../../core/tools/html.js'
import type { GoogleOutcome, GoogleTokens } from '../../../core/google/oauth.js'
import { LABEL_COLORS, createLabel, deleteLabel, labelMessages, toggleAssignment, unsorted } from '../../../core/google/labels.js'
import { markSeen, seenAt } from '../../../core/google/seen.js'
import { googleState } from '../../../core/google/state.js'
import { GOOGLE_TIERS, accessOf, type GoogleAccess } from '../../../core/google/tiers.js'
import { readAuth, readConfig } from '../../../core/config/load.js'
import type { AgentRuntime } from '../../../core/runtime.js'
import { optionalText } from './input.js'

export class WebEmailSettings {
  private mail: { refreshToken: string; source: TokenSource } | null = null

  constructor(private readonly runtime: AgentRuntime) {}

  handle(action: string, body: Record<string, unknown>): Promise<unknown> | unknown {
    switch (action) {
      case 'email-status': return this.emailStatus()
      case 'email-unread': return this.emailUnread()
      case 'email-seen': return this.emailSeen()
      case 'email-inbox': return this.emailInbox(body)
      case 'email-sort': return this.emailSort(body)
      case 'email-body': return this.emailBody(body)
      case 'email-message': return this.emailMessage(body)
      case 'email-thread': return this.emailThread(body)
      case 'email-modify': return this.emailModify(body)
      case 'email-draft': return this.emailDraft(body)
      case 'email-send': return this.emailSend(body)
      case 'email-assist': return this.emailAssist(body)
      case 'email-label-create': return this.emailLabelCreate(body)
      case 'email-label-delete': return this.emailLabelDelete(body)
      case 'email-label-assign': return this.emailLabelAssign(body)
      default: throw new Error(`Unknown Email action: "${action}".`)
    }
  }

  private emailStatus(): unknown {
    return {
      ...googleState(readConfig(), readAuth()),
      tiers: GOOGLE_TIERS.map(({ id, label, description }) => ({ id, label, description })),
      // The quick filters the inbox can be narrowed by, named once in the core so the
      // query and the controls that offer it cannot drift apart.
      filters: INBOX_FILTERS.map(({ id, label }) => ({ id, label })),
      // Whether Milo can sort the mail at all. Said here, up front, so the screen
      // can tell the person rather than promise a sorting that will never come.
      sorting: this.runtime.classifier !== null,
    }
  }

  /**
   * The sidebar's badge: unread mail in the inbox that arrived after the person
   * last looked. Zero when no account is connected, so the number is drawn only
   * when there is a grant behind it.
   */
  private async emailUnread(): Promise<unknown> {
    if (!readAuth().google?.refreshToken) return { count: 0, more: false }
    return this.mailCall((tokens) => unreadSince(tokens, seenAt()))
  }

  /** The inbox was looked at: the badge starts counting from now. */
  private async emailSeen(): Promise<unknown> {
    return markSeen()
  }

  /**
   * A page of the inbox, each message carrying the labels Milo has already sorted it
   * into — and nothing else. The classifier is never on this path: the mail is drawn
   * from the store as it is, and the messages with no label yet come back as `unsorted`
   * for `email-sort` to ask about. A slow or down classifier used to hold the whole
   * inbox behind its timeout; now it can only delay the labels, never the mail.
   *
   * The quick filter and the search narrow the Gmail query itself, so a page is a page
   * of what was asked for. A label is Milo's own and does not change that query, so it
   * is not read for here — the surface filters the page it drew.
   */
  private async emailInbox(body: Record<string, unknown>): Promise<unknown> {
    const pageToken = optionalText(body.pageToken)
    const limit = typeof body.limit === 'number' && body.limit > 0 ? Math.min(Math.floor(body.limit), 50) : 20
    const filter = inboxFilter(body.filter)
    const search = optionalText(body.search)
    const page = await this.mailCall((tokens) => listInbox(tokens, {
      ...(pageToken ? { pageToken } : {}),
      limit,
      ...(filter ? { filter } : {}),
      ...(search ? { search } : {}),
    }))
    const { byMessage, labels } = await labelMessages(null, page.messages)
    return {
      messages: page.messages.map((message) => ({ ...message, labels: byMessage.get(message.id) ?? [] })),
      ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}),
      labels,
      colors: LABEL_COLORS,
      unsorted: unsorted(page.messages),
    }
  }

  /**
   * Sorts the mail the inbox handed back and could not place. A separate call on
   * purpose: this is the only mail path that reaches the classifier, so the inbox
   * itself is never waiting on it. The rows come back from the client rather than
   * being listed again — re-fetching a page's metadata just to sort it would double
   * every Gmail call the inbox already made.
   */
  private async emailSort(body: Record<string, unknown>): Promise<unknown> {
    const messages = sortableMessages(body.messages)
    if (!this.runtime.classifier || messages.length === 0) return { byMessage: {}, labels: [] }
    const { byMessage, labels } = await labelMessages(this.runtime.classifier, messages)
    return { byMessage: Object.fromEntries(byMessage), labels }
  }

  /**
   * One message's body past the `BODY_LIMIT` the thread draws. A text body is paged
   * from `offset`; an HTML one is answered whole, since only a whole document renders.
   */
  private emailBody(body: Record<string, unknown>): Promise<unknown> {
    const id = googleId(body.id)
    const offset = typeof body.offset === 'number' && body.offset > 0 ? Math.floor(body.offset) : 0
    return this.mailCall((tokens) => readBody(tokens, id, offset))
  }

  /** The person's own label, added to the set. Local to Milo — nothing reaches Gmail. */
  private async emailLabelCreate(body: Record<string, unknown>): Promise<unknown> {
    const result = await createLabel(optionalText(body.name) ?? '', optionalText(body.color) ?? '')
    if (!result.ok) throw new Error(result.error)
    return { labels: result.labels, colors: LABEL_COLORS }
  }

  private async emailLabelDelete(body: Record<string, unknown>): Promise<unknown> {
    const result = await deleteLabel(optionalText(body.id) ?? '')
    if (!result.ok) throw new Error(result.error)
    return { labels: result.labels, colors: LABEL_COLORS }
  }

  /** Puts a label on one message or takes it off, by hand. Milo's own, so no grant. */
  private async emailLabelAssign(body: Record<string, unknown>): Promise<unknown> {
    const id = googleId(body.id)
    const label = optionalText(body.label)
    if (!label) throw new Error('A label is required.')
    const on = body.on !== false
    const result = await toggleAssignment(id, label, on)
    if (!result.ok) throw new Error(result.error)
    return { id, label, on, labels: result.labels }
  }

  private emailMessage(body: Record<string, unknown>): Promise<unknown> {
    const id = googleId(body.id)
    return this.mailCall((tokens) => readMail(tokens, id))
  }

  /**
   * One thread, each message carrying the labels already sorted onto it. It is a
   * lookup, not a sort — the inbox is what sorts — so opening a thread asks the
   * classifier nothing and is never slower for it.
   */
  private async emailThread(body: Record<string, unknown>): Promise<unknown> {
    const id = googleId(body.threadId ?? body.id)
    const thread = await this.mailCall((tokens) => readThread(tokens, id))
    const { byMessage } = await labelMessages(null, thread.messages)
    return {
      ...thread,
      messages: thread.messages.map((message) => ({ ...message, labels: byMessage.get(message.id) ?? [] })),
    }
  }

  /** What a message answers to: out of the inbox, read or unread, and into the bin. */
  private async emailModify(body: Record<string, unknown>): Promise<unknown> {
    const id = googleId(body.id)
    const op = optionalText(body.op) ?? ''
    // An argument it does not know answers with the ones it does.
    if (!isMailOperation(op)) {
      throw new Error(`Unknown mail action "${op || '(none)'}" — one of ${MAIL_OPERATIONS.join(', ')}.`)
    }
    // The move and its wording live in the core, shared with the agent's tool.
    const done = await this.mailCall((tokens, access) => applyMailOperation(tokens, access, id, op))
    return { done }
  }

  private emailDraft(body: Record<string, unknown>): Promise<unknown> {
    const draft = draftInput(body.draft)
    return this.mailCall((tokens, access) => createDraft(tokens, access, draft))
  }

  private emailSend(body: Record<string, unknown>): Promise<unknown> {
    const mail = draftInput(body.draft)
    return this.mailCall((tokens, access) => sendMessage(tokens, access, mail))
  }

  /**
   * The agentic reading: the model is asked about mail the server has already
   * fetched. The unread summary reads the unread; summarize and draft read one
   * thread. The answer is text, and a draft is only a body — the screen puts the
   * recipient and subject on it, from the message it is looking at.
   */
  private async emailAssist(body: Record<string, unknown>): Promise<unknown> {
    const mode = optionalText(body.mode) ?? ''
    if (!(ASSIST_MODES as string[]).includes(mode)) {
      throw new Error(`Unknown mail assistance "${mode || '(none)'}" — one of ${ASSIST_MODES.join(', ')}.`)
    }

    if (mode === 'summarize-unread') {
      const found = await this.mailCall((tokens) => searchMail(tokens, 'is:unread newer_than:3d', 20))
      if (found.length === 0) return { text: 'Nothing unread in the last three days.' }
      const mail = found
        .map((message) => `- ${message.from ?? '(unknown sender)'} — ${message.subject ?? '(no subject)'}${message.snippet ? ` — ${message.snippet}` : ''}`)
        .join('\n')
      return { text: await this.askModel('summarize-unread', mail) }
    }

    const id = googleId(body.threadId)
    const thread = await this.mailCall((tokens) => readThread(tokens, id))
    if (thread.messages.length === 0) throw new Error('That thread has no messages to read.')
    // An HTML-only message is stripped to its words before it reaches the model:
    // sending the markup spends the window on tags the model cannot use.
    const bodyOf = (message: (typeof thread.messages)[number]): string =>
      message.html ? htmlToText(message.text) : message.text
    const mail = thread.messages
      .map((message) => `From: ${message.from ?? '(unknown)'}\nDate: ${message.date ?? '(no date)'}\nSubject: ${message.subject ?? '(no subject)'}\n\n${bodyOf(message)}`)
      .join('\n\n---\n\n')
    return { text: await this.askModel(mode as AssistMode, mail) }
  }

  private async askModel(mode: AssistMode, mail: string): Promise<string> {
    const answer = await emailAssist({ provider: this.runtime.provider, model: this.runtime.model, mode, mail })
    if (!answer.ok) throw new Error(answer.error)
    return answer.text
  }

  private mailToken(): TokenSource {
    const account = readAuth().google
    const refresh = account?.refreshToken ?? ''
    if (this.mail?.refreshToken !== refresh) {
      this.mail = { refreshToken: refresh, source: tokenSource(account ?? null) }
    }
    return this.mail.source
  }

  /**
   * One Gmail call, with the two things every one of them needs done first: a
   * token, and the level the grant was made at. A failure that is the flow's own —
   * not connected, or above the grant — leaves here as the sentence the screen
   * shows, never as a bare 403.
   */
  private async mailCall<T>(
    work: (tokens: GoogleTokens, access: GoogleAccess) => Promise<GoogleOutcome<T>>,
  ): Promise<T> {
    const tokens = await this.mailToken()()
    if (!tokens.ok) throw new Error(tokens.error)
    const got = await work(tokens.value, accessOf(readAuth().google))
    if (!got.ok) throw new Error(got.error)
    return got.value
  }

}

/** A Gmail id as the page sends it: the shape the API takes, and nothing path-shaped. */
function googleId(value: unknown): string {
  const id = optionalText(value)
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('Invalid mail id.')
  return id
}

/**
 * The rows `email-sort` was handed, reduced to what the classifier reads: an id and
 * the three fields a person sorts by. Anything else the body carried is dropped, and
 * a row without a usable id is skipped rather than trusted.
 */
function sortableMessages(value: unknown): MailSummary[] {
  if (!Array.isArray(value)) return []
  const rows: MailSummary[] = []
  for (const entry of value.slice(0, 50)) {
    if (!entry || typeof entry !== 'object') continue
    const row = entry as Record<string, unknown>
    const id = optionalText(row.id)
    if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) continue
    const from = optionalText(row.from)
    const subject = optionalText(row.subject)
    const snippet = optionalText(row.snippet)
    rows.push({
      id,
      threadId: optionalText(row.threadId) ?? '',
      ...(from ? { from } : {}),
      ...(subject ? { subject } : {}),
      ...(snippet ? { snippet } : {}),
    })
  }
  return rows
}

/** A quick filter as the page sends it — one of the filters the core declares. */
function inboxFilter(value: unknown): InboxFilter | undefined {
  const id = optionalText(value)
  if (!id) return undefined
  if (!INBOX_FILTERS.some((filter) => filter.id === id)) {
    throw new Error(`Unknown inbox filter "${id}" — one of ${INBOX_FILTERS.map((filter) => filter.id).join(', ')}.`)
  }
  return id as InboxFilter
}

/** A message body out of the page, with what Gmail needs to carry it. */
function draftInput(value: unknown): DraftInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('A message is required.')
  const draft = value as Record<string, unknown>
  const to = optionalText(draft.to)
  const body = typeof draft.body === 'string' ? draft.body : ''
  if (!to) throw new Error('A recipient is required.')
  if (!body.trim()) throw new Error('An empty message is not worth sending.')
  const threadId = optionalText(draft.threadId)
  return {
    to,
    subject: typeof draft.subject === 'string' ? draft.subject : '',
    body,
    ...(threadId ? { threadId } : {}),
  }
}
