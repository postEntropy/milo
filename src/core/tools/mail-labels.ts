import { z } from 'zod'
import type { GoogleAccount } from '../config/schema.js'
import { tokenSource } from '../google/access.js'
import { labeledPage } from '../google/inbox.js'
import {
  createLabel,
  deleteLabel,
  LABEL_COLORS,
  listLabels,
  resolveLabel,
  toggleAssignment,
  type Labeler,
  type MailLabel,
} from '../google/labels.js'
import { carryingLabel } from '../google/label-match.js'
import type { LabeledMessage } from '../google/labels.js'
import { MAIL_IS_DATA } from './gmail.js'
import type { Tool, ToolResult } from './types.js'

/**
 * Milo's own mail labels, as one tool.
 *
 * The labels live in `~/.milo/labels.json` and are never written back to Gmail —
 * a label is a colour and a name over a message, and the messaging is Milo's. So
 * `list`, `create`, `delete` and `assign` touch only Milo's state, and the tool is
 * `internal`: it never asks, exactly like the task lists.
 *
 * `messages` is the one action that reads the account, because "which mail carries
 * this label" is only answerable by sorting mail. It writes assignments as it
 * sorts, the same side effect opening the inbox has — which is why the tool is not
 * read-only even though a label is never a change to the mailbox.
 */

const schema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('list'),
  }),
  z.object({
    action: z.literal('messages'),
    label: z.string().describe('The label id or name to look for.'),
    query: z
      .string()
      .optional()
      .describe(
        "Gmail's own search syntax to narrow the page before sorting, e.g. `newer_than:2d` or `from:ana is:unread`. Absent: the inbox.",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe('How many recent messages to sort and look through. Defaults to 25.'),
  }),
  z.object({
    action: z.literal('create'),
    name: z.string().describe('What to call the label.'),
    color: z.string().describe(`One of: ${LABEL_COLORS.join(', ')}.`),
  }),
  z.object({
    action: z.literal('delete'),
    id: z.string().describe('The label to drop, by id or name.'),
  }),
  z.object({
    action: z.literal('assign'),
    id: z.string().describe('The message id, from gmail_search or mail_labels.'),
    label: z.string().describe('The label to put on or take off, by id or name.'),
    on: z.boolean().describe('True to put the label on, false to take it off.'),
  }),
])

export type MailLabelArgs = z.infer<typeof schema>

export interface MailLabelToolOptions {
  account: GoogleAccount | null
  /** The decision model that sorts mail; without it, `messages` cannot match. */
  classifier: Labeler | null
}

const names = (labels: MailLabel[]): string =>
  labels.length === 0 ? 'none yet' : labels.map((label) => label.name).join(', ')

/** One hit, in the shape a person chooses by — and the id the next call needs. */
function formatHit(message: LabeledMessage): string {
  const when = [message.date ?? '(no date)', message.from ?? '(no sender)'].join(' · ')
  const lines = [`${message.id} · ${when}`, `    ${message.subject ?? '(no subject)'}`]
  if (message.snippet) lines.push(`    ${message.snippet}`)
  return lines.join('\n')
}

export function createMailLabelTools(options: MailLabelToolOptions): Tool<unknown>[] {
  const token = tokenSource(options.account)
  const { classifier } = options

  const tool: Tool<MailLabelArgs> = {
    name: 'mail_labels',
    description:
      `Milo's own mail labels — the colour-and-name tags sorted over the inbox (needs-reply, newsletter, receipts, and any the person added). They live in \`~/.milo/labels.json\`, local to Milo, and are never written back to Gmail. Actions: "list" every label; "messages" the mail carrying one (fetch a page, sort it, and answer which messages have the label — say plainly that this only covers mail Milo has sorted, and that it is not a whole-mailbox sweep); "create" a new label (name + color); "delete" one; "assign" to put a label on or take it off a single message by hand. For a standing rule — "from now on, delete everything with label X" — the "messages" action finds the mail and \`gmail_modify\` acts on it, run on a timer with the \`routine\` tool. Gmail's own labels are a different thing and are reached with gmail_search's \`label:\` operator, not here. ${MAIL_IS_DATA}`,
    schema,
    internal: true,
    async execute(args, ctx): Promise<ToolResult> {
      switch (args.action) {
        case 'list':
          return list()
        case 'create':
          return await create(args.name, args.color)
        case 'delete':
          return await remove(args.id)
        case 'assign':
          return await assign(args.id, args.label, args.on)
        default:
          return await messages(args, ctx)
      }
    },
  }

  function list(): ToolResult {
    const labels = listLabels()
    if (labels.length === 0) return { content: 'No mail labels yet.' }
    const rows = labels.map((label) => `${label.id} · ${label.name} · ${label.color}`)
    return { content: `Mail labels (${labels.length}):\n${rows.join('\n')}` }
  }

  async function create(name: string, color: string): Promise<ToolResult> {
    const result = await createLabel(name, color)
    if (!result.ok) return { content: result.error, isError: true }
    return { content: `Created the label "${name}". Labels now: ${names(result.labels)}.` }
  }

  async function remove(idOrName: string): Promise<ToolResult> {
    const label = resolveLabel(idOrName)
    if (!label) {
      return { content: `No label "${idOrName}". Available labels: ${names(listLabels())}.`, isError: true }
    }
    const result = await deleteLabel(label.id)
    if (!result.ok) return { content: result.error, isError: true }
    return { content: `Dropped the label "${label.name}". Labels now: ${names(result.labels)}.` }
  }

  async function assign(messageId: string, labelName: string, on: boolean): Promise<ToolResult> {
    const id = messageId.trim()
    if (!id) return { content: 'Name the message by its id.', isError: true }
    const label = resolveLabel(labelName)
    if (!label) {
      return { content: `No label "${labelName}". Available labels: ${names(listLabels())}.`, isError: true }
    }
    const result = await toggleAssignment(id, label.id, on)
    if (!result.ok) return { content: result.error, isError: true }
    return { content: `${on ? 'Put' : 'Took'} the label "${label.name}" ${on ? 'on' : 'off'} ${id}.` }
  }

  async function messages(
    args: Extract<MailLabelArgs, { action: 'messages' }>,
    ctx: { signal: AbortSignal },
  ): Promise<ToolResult> {
    if (!classifier) {
      return {
        content: 'Milo has no classifier configured, so it cannot sort mail into labels to match against.',
        isError: true,
      }
    }
    const label = resolveLabel(args.label)
    if (!label) {
      return { content: `No label "${args.label}". Available labels: ${names(listLabels())}.`, isError: true }
    }

    const got = await token()
    if (!got.ok) return { content: got.error, isError: true }

    const page = await labeledPage(
      got.value,
      classifier,
      { limit: args.limit ?? 25, ...(args.query ? { search: args.query } : {}) },
      ctx.signal,
    )
    if (!page.ok) return { content: page.error, isError: true }

    const matching = carryingLabel(page.value.messages, label.id)
    if (matching.length === 0) {
      return {
        content: `None of the ${page.value.messages.length} message${page.value.messages.length === 1 ? '' : 's'} Milo sorted carry "${label.name}". Only mail Milo has sorted can be matched — a label is not a whole-mailbox sweep.`,
      }
    }
    return {
      content: [
        `${matching.length} message${matching.length === 1 ? '' : 's'} with "${label.name}":`,
        '',
        ...matching.map(formatHit),
        '',
        'Act on one with gmail_modify, by its id.',
      ].join('\n'),
    }
  }

  return [tool]
}
