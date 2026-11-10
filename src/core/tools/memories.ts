import { z } from 'zod'
import { formatWhen } from '../time.js'
import { DEFAULT_LIST_LIMIT, shortId } from '../memory/index.js'
import type { MemoryAdmin, Tool, ToolResult } from './types.js'

const schema = z.object({
  action: z
    .enum(['list', 'forget', 'edit'])
    .optional()
    .describe(
      '"list" reads notes; "edit" corrects one by id and text; "forget" drops one by id. Absent: "list".',
    ),
  query: z.string().optional().describe('Search notes by words.'),
  text: z.string().optional().describe('Replacement text for edit.'),
  ids: z
    .array(z.string().min(1))
    .max(20)
    .optional()
    .describe('For "forget" or "edit": the notes identified by "list". The first 8 characters are enough.'),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(`For "list": how many notes to read at once. Absent: ${DEFAULT_LIST_LIMIT}.`),
  offset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      'For "list": how many notes to skip, to read the next page — the offset the last page pointed at.',
    ),
})

export type MemoriesArgs = z.infer<typeof schema>

export const memoriesTool: Tool<MemoriesArgs> = {
  name: 'memories',
  description:
    'The notes Milo keeps about the person across sessions — the same store `/memory` shows them. Reach for it to answer "what do you remember about me", to check what is already known before asking, and to correct or drop a note the person no longer wants: list them, then forget the ones worth dropping (wrong, out of date, or the person asked). The list is paged — when the page points at a next offset, read on with it to reach the older notes. Editing and forgetting ask before they happen and cannot be undone. Past messages remain in history and may still be recalled after a note is edited or forgotten. A note is something the person said about themselves; `recall` looks up a past session by what it was about, which is a different thing.',
  schema,
  readOnly: false,
  // Listing is a read the person would not want to approve; forgetting is not. The
  // args say which this call is, the way the `sessions` tool tells a read of the
  // list from a removal.
  asksWhen: (args) => args.action === 'forget' || args.action === 'edit',
  async execute(args, ctx) {
    const memory = ctx.memories
    if (!memory) {
      return { content: 'Memory is not available in this session.', isError: true }
    }
    if (args.action === 'forget') return forget(args.ids, memory)
    if (args.action === 'edit') {
      if (args.ids?.length !== 1 || !args.text?.trim()) return { content: 'Give one note id and replacement text.', isError: true }
      const result = await memory.update(args.ids[0]!, args.text)
      return result.ok ? { content: 'Note updated.' } : { content: result.error, isError: true }
    }
    return listAll(memory, args)
  },
}

/**
 * One page of notes, as the model reads it: each note's id, when it was last
 * said, and the text — then which offset the page ended on, so a store bigger
 * than one reply can still be walked to the end.
 */
async function listAll(memory: MemoryAdmin, args: MemoriesArgs): Promise<ToolResult> {
  const limit = args.limit ?? DEFAULT_LIST_LIMIT
  const offset = args.offset ?? 0
  const notes = await memory.list({ limit, offset, query: args.query })

  if (notes.length === 0) {
    return {
      content:
        offset > 0 ? `No notes at offset ${offset} — that is the end.` : args.query?.trim() ? 'No notes match that search.' : 'Nothing is remembered yet.',
    }
  }

  const end = offset + notes.length
  // A full page may have more behind it; a short one is the end of the store.
  const reach =
    notes.length < limit
      ? `That is the end of the list (${end} note(s)).`
      : `More may follow — read the next page with offset ${end}.`

  return {
    content: [
      `Notes I keep (${notes.length} shown, offset ${offset}, most recent first):`,
      ...notes.map((note) => `- ${shortId(note.id)}  ${formatWhen(note.createdAt)}  ${note.text}${note.source ? ` (source: “${note.source.quote}”, session ${note.source.session})` : ' (source unavailable)'}`),
      `${reach} Edit or forget one with its id.`,
    ].join('\n'),
  }
}

async function forget(ids: string[] | undefined, memory: MemoryAdmin): Promise<ToolResult> {
  const wanted = (ids ?? []).map((id) => id.trim()).filter((id) => id.length > 0)
  if (wanted.length === 0) {
    return {
      content:
        'Which one? Give the id from action "list": memories { "action": "forget", "ids": ["<id>"] }.',
      isError: true,
    }
  }

  const { forgotten, unknown } = await memory.forget(wanted)
  if (forgotten.length === 0) {
    return { content: `No note matched those ids: ${unknown.join(', ')}.`, isError: true }
  }
  const tail = unknown.length > 0 ? ` Nothing matched ${unknown.join(', ')}.` : ''
  return { content: `Forgot ${forgotten.length} note(s).${tail} Past messages remain in history and may still be recalled.` }
}
