/**
 * How a tool call is written into a message.
 *
 * Shell commands get a code block: monospace, with a copy button on mobile, and
 * separate from the quote box the other tools share with the search and read
 * activity.
 */
export type ToolLineStyle = 'quote' | 'code'

export interface ToolLine {
  text: string
  style: ToolLineStyle
}

/**
 * Every line starts with a real emoji, never a typographic glyph: these lines
 * are read in chat clients, where `▸` renders as a stray character next to the
 * emoji around it. The fallback is an emoji too, so an unknown tool cannot
 * reintroduce one.
 */
const TOOLS: Record<string, { icon: string; style: ToolLineStyle }> = {
  read_file: { icon: '📄', style: 'quote' },
  list_dir: { icon: '📁', style: 'quote' },
  glob: { icon: '🔎', style: 'quote' },
  grep: { icon: '🔍', style: 'quote' },
  fetch_url: { icon: '🔗', style: 'quote' },
  write_file: { icon: '📝', style: 'code' },
  edit_file: { icon: '✏️', style: 'code' },
  remember: { icon: '🧠', style: 'quote' },
  recall: { icon: '🗂', style: 'quote' },
  search_history: { icon: '🕘', style: 'quote' },
  web_search: { icon: '🌐', style: 'quote' },
  skill: { icon: '📘', style: 'quote' },
  task: { icon: '🤖', style: 'quote' },
  shell_command: { icon: '⚡', style: 'code' },
}

const FALLBACK: { icon: string; style: ToolLineStyle } = { icon: '🔧', style: 'quote' }

/** The icon alone, for surfaces that draw their own line (the CLI). */
export function toolIcon(name: string): string {
  return (TOOLS[name] ?? FALLBACK).icon
}

export function toolStyle(name: string): ToolLineStyle {
  return (TOOLS[name] ?? FALLBACK).style
}

export function toolLine(
  name: string,
  args?: unknown,
  options: { markdown?: boolean } = {},
): ToolLine {
  const { icon, style } = TOOLS[name] ?? FALLBACK
  const summary = toolDetail(args)
  const label = toolLabel(name, style, options.markdown ?? false)
  return { text: summary ? `${icon} ${label} ${summary}` : `${icon} ${label}`, style }
}

/**
 * The tool name, emphasised so it reads as a name and not as the first word of
 * the arguments — but only on a line the surface renders as Markdown. Inside a
 * code fence Markdown is literal, so the asterisks would simply show up.
 */
export function toolLabel(name: string, style: ToolLineStyle, markdown: boolean): string {
  return markdown && style === 'quote' ? `**${name}**` : name
}

const GIST_LIMIT = 120

/**
 * The one interesting value of a call, for the line next to the tool name.
 *
 * Deliberately not `summarizeToolCall`: a permission prompt wants *something*
 * even when it has to dump JSON, while a tool line wants nothing rather than
 * `{}` beside the name.
 *
 * Exported because the CLI draws its own line and must not drift from the
 * chat surfaces: both put this same string after the tool name, so a skill reads
 * as `skill deploy` in the terminal and in Telegram alike, not as the argument
 * dump on one and the useful value on the other.
 */
export function toolDetail(args: unknown): string {
  if (!args || typeof args !== 'object') return ''
  const record = args as Record<string, unknown>
  // `description` is the `task` tool's label for a subtask (its `prompt` is the
  // whole instruction, and has no place on a one-line activity log); `url` and
  // `name` are the one interesting value of `fetch_url` and `skill`.
  for (const key of ['command', 'query', 'pattern', 'path', 'url', 'description', 'name']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) {
      const flat = value.trim().replace(/\s+/g, ' ')
      return flat.length > GIST_LIMIT ? `${flat.slice(0, GIST_LIMIT - 1)}…` : flat
    }
  }
  return ''
}
