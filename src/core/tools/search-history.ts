import { z } from 'zod'
import { searchHistory, type HistoryEntry } from '../history.js'
import type { Tool } from './types.js'

const schema = z.object({
  query: z.string().describe('Words to look for; every one of them has to appear.'),
  days: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('How many days back to read (default 30).'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe('Most entries to return (default 20).'),
})

export type SearchHistoryArgs = z.infer<typeof schema>

const MAX_CHARS = 8_000
const PER_ENTRY = 400
const DEFAULT_LIMIT = 20

export const searchHistoryTool: Tool<SearchHistoryArgs> = {
  name: 'search_history',
  description:
    'Search your own past conversations: what was asked, what you answered, and which tools ran, across sessions and days. Use it when the user refers to something from an earlier conversation, or when you need to know what you already tried. It reads the log on this machine — the raw files are `~/.milo/history/*.jsonl` — in plain text; it does not search the web.',
  schema,
  readOnly: true,
  async execute(args) {
    const limit = args.limit ?? DEFAULT_LIMIT
    // One extra, so we can say whether there is more than we are showing.
    const found = searchHistory(args.query, { days: args.days, limit: limit + 1 })
    const hits = found.slice(0, limit)
    if (hits.length === 0) {
      return { content: `Nothing in the history matches "${args.query}".` }
    }

    const lines: string[] = []
    let chars = 0
    let shown = 0
    for (const entry of hits) {
      const line = formatEntry(entry)
      if (chars + line.length + 1 > MAX_CHARS) break
      lines.push(line)
      chars += line.length + 1
      shown += 1
    }

    if (shown < hits.length || found.length > limit) {
      lines.push('… more match(es) than shown; narrow the query, or lower days or limit.')
    }

    return { content: lines.join('\n') }
  },
}

/** One hit: when, where, and what was said — flattened and trimmed to a line. */
function formatEntry(entry: HistoryEntry): string {
  const when = `${entry.at.slice(0, 10)} ${entry.at.slice(11, 16)}`
  const where = `${entry.scope} · ${entry.session}`

  if (entry.kind === 'tool') {
    const state = entry.tool?.isError ? 'failed' : 'ok'
    const name = entry.tool?.name ?? 'tool'
    return `${when} · ${where} · ${name} (${state}) ${clip(safeJson(entry.tool?.args))}\n  → ${clip(entry.tool?.result ?? '')}`
  }

  const who = entry.kind === 'user' ? 'user' : 'assistant'
  const thought = entry.reasoning ? `\n  · thought: ${clip(entry.reasoning, PER_ENTRY / 2)}` : ''
  return `${when} · ${where} · ${who}: ${clip(entry.text ?? '')}${thought}`
}

function clip(text: string, limit = PER_ENTRY): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

function safeJson(value: unknown): string {
  if (value === undefined) return ''
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return String(value)
  }
}
