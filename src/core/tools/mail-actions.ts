import { z } from 'zod'
import type { GoogleAccount } from '../config/schema.js'
import { tokenSource } from '../google/access.js'
import { archive, setRead, trashMessage } from '../google/gmail.js'
import { accessOf } from '../google/tiers.js'
import type { Tool } from './types.js'

/**
 * Acting on one Gmail message, at the level the grant allows.
 *
 * The three moves that stay inside the account: archive, read/unread, and the bin
 * (Gmail's `trash` — recoverable, never the permanent `delete`, which the grant
 * never asks the scope for). Every move needs the `modify` level; below it the
 * core answers with the sentence that says how to reconnect, so a missing scope is
 * never a bare 403.
 *
 * Unlike the read-only pair next door, this writes to the account, so it asks
 * before acting — and a routine that wants it has to name `gmail_modify` in
 * `allow`.
 */
const schema = z.object({
  id: z.string().describe('The message id, from gmail_search or mail_labels.'),
  op: z
    .enum(['archive', 'read', 'unread', 'trash'])
    .describe(
      '"archive": out of the inbox, kept. "read"/"unread": the read state. "trash": to the bin — gone from the inbox, recoverable for thirty days, not deleted for good.',
    ),
})

export type GmailModifyArgs = z.infer<typeof schema>

const DONE: Record<GmailModifyArgs['op'], (id: string) => string> = {
  archive: (id) => `Archived ${id}.`,
  read: (id) => `Marked ${id} as read.`,
  unread: (id) => `Marked ${id} as unread.`,
  trash: (id) => `Moved ${id} to the bin.`,
}

export function createGmailWriteTools(account: GoogleAccount | null): Tool<unknown>[] {
  const token = tokenSource(account)
  const access = accessOf(account)

  const modify: Tool<GmailModifyArgs> = {
    name: 'gmail_modify',
    description:
      "Act on one message in the connected Gmail account, by the id gmail_search or mail_labels returned: archive it, mark it read or unread, or move it to the bin. This changes the account and needs the `modify` grant — below it the call answers how to reconnect. It asks before acting; a routine that needs it unattended must name `gmail_modify` in `allow`. For a rule like \"delete everything with label X\", use mail_labels to find the messages, then this to act.",
    schema,
    async execute(args) {
      const got = await token()
      if (!got.ok) return { content: got.error, isError: true }

      const id = args.id.trim()
      if (!id) return { content: 'Name the message by its id.', isError: true }

      const work = {
        archive: () => archive(got.value, access, id),
        read: () => setRead(got.value, access, id, true),
        unread: () => setRead(got.value, access, id, false),
        trash: () => trashMessage(got.value, access, id),
      }[args.op]

      const done = await work()
      // The core's refusal already names the level to reconnect at; passed through.
      if (!done.ok) return { content: done.error, isError: true }
      return { content: DONE[args.op](id) }
    },
  }

  return [modify]
}
