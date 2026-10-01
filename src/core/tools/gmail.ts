import { z } from 'zod'
import type { GoogleAccount } from '../config/schema.js'
import { tokenSource } from '../google/access.js'
import { read as readMessage, search as searchMessages, type MailSummary } from '../google/gmail.js'
import type { Tool } from './types.js'

/**
 * Gmail, as two read-only tools.
 *
 * Read-only is not a note in the description, it is the shape of them: there is no
 * tool here that writes, and the grant was asked for at `gmail.readonly`, which
 * cannot write even if something tried. The permission policy therefore has
 * nothing to gate — and nothing that acts on someone's mail arrives unannounced.
 */
const searchSchema = z.object({
  query: z
    .string()
    .describe(
      "Gmail's own search syntax, the same the web search box takes — `from:ana is:unread newer_than:7d`, `subject:nota`, `has:attachment`.",
    ),
  limit: z.number().int().min(1).max(25).optional().describe('How many messages to list. Defaults to 10.'),
})

const readSchema = z.object({ id: z.string().describe('A message id, from gmail_search.') })

/** One hit, in the shape a person chooses by — and the id the next call needs. */
function formatHit(message: MailSummary): string {
  const when = [message.date ?? '(no date)', message.from ?? '(no sender)'].join(' · ')
  const lines = [`${message.id} · ${when}`, `    ${message.subject ?? '(no subject)'}`]
  if (message.snippet) lines.push(`    ${message.snippet}`)
  return lines.join('\n')
}

export function createGmailTools(account: GoogleAccount | null): Tool<unknown>[] {
  const token = tokenSource(account)

  const search: Tool<z.infer<typeof searchSchema>> = {
    name: 'gmail_search',
    description:
      'Search the connected Gmail account and list what matched. Read-only: Milo does not send, archive, label or delete mail.',
    schema: searchSchema,
    readOnly: true,
    async execute(args) {
      const got = await token()
      if (!got.ok) return { content: got.error, isError: true }

      const found = await searchMessages(got.value, args.query, args.limit ?? 10)
      if (!found.ok) return { content: found.error, isError: true }
      if (found.value.length === 0) return { content: `Nothing in the mailbox matched: ${args.query}` }

      return {
        content: [
          `${found.value.length} message${found.value.length === 1 ? '' : 's'} for "${args.query}":`,
          '',
          ...found.value.map(formatHit),
          '',
          'Read one with gmail_read, by its id.',
        ].join('\n'),
      }
    },
  }

  const read: Tool<z.infer<typeof readSchema>> = {
    name: 'gmail_read',
    description: 'Read one message in full, by the id gmail_search returned. Read-only.',
    schema: readSchema,
    readOnly: true,
    async execute(args) {
      const got = await token()
      if (!got.ok) return { content: got.error, isError: true }

      const message = await readMessage(got.value, args.id)
      if (!message.ok) return { content: message.error, isError: true }

      const header = formatHit(message.value)
      const body = message.value.text.trim() || '(this message has no readable body)'
      // Said out loud, because a body that stops mid-sentence reads as the whole
      // message and the missing half is never asked for.
      const notes = [
        ...(message.value.truncated ? ['[the body was cut — ask again if you need the rest]'] : []),
        ...(message.value.html ? ['[this message has no plain-text part; the body below is HTML]'] : []),
      ]
      return { content: [header, '', body, ...notes].join('\n') }
    },
  }

  return [search, read]
}
