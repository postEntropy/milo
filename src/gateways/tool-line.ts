/**
 * How a tool call is written into a message.
 *
 * One line per call, in the same shape on every surface: an icon, the tool's
 * name, and the one value worth showing. `shell_command` is the one exception,
 * and it is drawn by the runner rather than here: a fenced block of its own, with
 * no line above it — the block's `shell` marker already says what it is, and a
 * name on a line of its own only repeats that. The command goes in whole
 * (`shellCommand`), never cut to this file's 120-character gist: a fenced block
 * whose contents are cut off is a block that lies about what it is for.
 */

/**
 * Every line starts with a real emoji, never a typographic glyph: these lines are
 * read in chat clients, where `▸` renders as a stray character next to the emoji
 * around it. The fallback is an emoji too, so an unknown tool cannot reintroduce
 * one.
 */
const TOOLS: Record<string, string> = {
  read_file: '📄',
  list_dir: '📁',
  glob: '🔎',
  grep: '🔍',
  fetch_url: '🔗',
  write_file: '📝',
  edit_file: '✏️',
  remember: '🧠',
  recall: '🗂',
  search_history: '🕘',
  web_search: '🌐',
  read_skill: '📘',
  task: '🤖',
  shell_command: '⚡',
  browser_open: '🧭',
  browser_snapshot: '👁️',
  browser_screenshot: '📸',
  browser_act: '🖱️',
}

const FALLBACK = '🔧'

/** The icon alone, for surfaces that draw their own line (the CLI). */
export function toolIcon(name: string): string {
  return TOOLS[name] ?? FALLBACK
}

export function toolLine(
  name: string,
  args?: unknown,
  options: { markdown?: boolean } = {},
): string {
  const summary = toolDetail(args)
  const label = toolLabel(name, options.markdown ?? false)
  return summary ? `${toolIcon(name)} ${label} ${summary}` : `${toolIcon(name)} ${label}`
}

/**
 * The tool name, emphasised so it reads as a name and not as the first word of
 * the arguments — where the surface renders Markdown. The terminal emphasises
 * with colour instead and asks for the plain name.
 */
export function toolLabel(name: string, markdown: boolean): string {
  return markdown ? `**${name}**` : name
}

/**
 * The raw command of a `shell_command` call, whole.
 *
 * `toolDetail` flattens and cuts at 120 characters, which is right for a gist
 * beside a tool's name and wrong for a fenced block: that block is there to be
 * read and copied, and a copy of something incomplete is worse than no block.
 */
export function shellCommand(args: unknown): string {
  if (!args || typeof args !== 'object') return ''
  const value = (args as Record<string, unknown>).command
  return typeof value === 'string' ? value.trim() : ''
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
 * as `read_skill deploy` in the terminal and in Telegram alike, not as the
 * argument dump on one and the useful value on the other.
 */
export function toolDetail(args: unknown): string {
  if (!args || typeof args !== 'object') return ''
  const record = args as Record<string, unknown>
  // `description` is the `task` tool's label for a subtask (its `prompt` is the
  // whole instruction, and has no place on a one-line activity log); `url` and
  // `name` are the one interesting value of `fetch_url` and `read_skill`.
  for (const key of ['command', 'query', 'pattern', 'path', 'url', 'description', 'name', 'action', 'app']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) {
      const flat = value.trim().replace(/\s+/g, ' ')
      return flat.length > GIST_LIMIT ? `${flat.slice(0, GIST_LIMIT - 1)}…` : flat
    }
  }
  return ''
}
