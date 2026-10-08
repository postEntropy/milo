/**
 * A page of the inbox with Milo's labels on it: the mail, and what each message
 * carries.
 *
 * The web Email screen and the agent's own tools read the inbox through here, so
 * "the messages with this label" is answered in one place and the two surfaces
 * cannot drift. It lives apart from `labels.ts` because that file only imports the
 * *type* of a mail summary — a page has to fetch the mail, not just label it.
 *
 * Sorting is `labelMessages`' and writes assignments as a side effect, exactly as
 * opening the inbox does, so this is not a pure read.
 */
import { listInbox, type InboxQuery, type MailSummary } from './gmail.js'
import { labelMessages, type LabeledMessage, type Labeler, type MailLabel } from './labels.js'
import type { GoogleOutcome, GoogleTokens } from './oauth.js'

export interface LabeledPage {
  messages: LabeledMessage[]
  /** Gmail's cursor for the next page; absent when this was the last one. */
  nextPageToken?: string
  /** Every label the install knows, for a surface's own bar. */
  labels: MailLabel[]
}

export async function labeledPage(
  tokens: GoogleTokens,
  classifier: Labeler | null,
  options: InboxQuery = {},
  signal?: AbortSignal,
): Promise<GoogleOutcome<LabeledPage>> {
  const page = await listInbox(tokens, options)
  if (!page.ok) return page

  const { byMessage, labels } = await labelMessages(classifier, page.value.messages, signal ? { signal } : {})
  const messages: LabeledMessage[] = page.value.messages.map((message: MailSummary) => ({
    ...message,
    labels: byMessage.get(message.id) ?? [],
  }))
  return {
    ok: true,
    value: {
      messages,
      ...(page.value.nextPageToken ? { nextPageToken: page.value.nextPageToken } : {}),
      labels,
    },
  }
}
