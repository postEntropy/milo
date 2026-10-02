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
 * The service a tool belongs to, when it has a mark of its own. Only the surface
 * that draws icons can use it — a chat client renders text, so the emoji is what
 * a Gmail call looks like there and the mark is what it looks like in the browser.
 */
export type ToolBrand = 'gmail' | 'drive'

/**
 * Every line starts with a real emoji, never a typographic glyph: these lines are
 * read in chat clients, where `▸` renders as a stray character next to the emoji
 * around it. The fallback is an emoji too, so an unknown tool cannot reintroduce
 * one.
 *
 * The emoji and the brand sit in one table because they answer one question —
 * what does this tool look like — and a tool with two tables would be a tool with
 * two answers.
 */
const TOOLS: Record<string, { icon: string; brand?: ToolBrand }> = {
  read_file: { icon: '📄' },
  list_dir: { icon: '📁' },
  glob: { icon: '🔎' },
  grep: { icon: '🔍' },
  fetch_url: { icon: '🔗' },
  git: { icon: '🌿' },
  git_commit: { icon: '📌' },
  write_file: { icon: '📝' },
  edit_file: { icon: '✏️' },
  remember: { icon: '🧠' },
  recall: { icon: '🗂' },
  search_history: { icon: '🕘' },
  web_search: { icon: '🌐' },
  read_skill: { icon: '📘' },
  task: { icon: '🤖' },
  todo: { icon: '🗒' },
  shell_command: { icon: '⚡' },
  browser_open: { icon: '🧭' },
  browser_snapshot: { icon: '👁️' },
  browser_screenshot: { icon: '📸' },
  browser_act: { icon: '🖱️' },
  // A mail envelope and a folder rather than the services' logotypes: the text
  // surfaces can only draw a character, and there is no Gmail or Drive emoji.
  gmail_search: { icon: '📧', brand: 'gmail' },
  gmail_read: { icon: '📧', brand: 'gmail' },
  drive_search: { icon: '📂', brand: 'drive' },
  drive_read: { icon: '📂', brand: 'drive' },
}

const FALLBACK = '🔧'

/**
 * Tools whose own activity is not drawn. Reaching for one should read as the
 * answer itself, not as a call: `send_file` is the case — the file lands in the
 * chat, and a line announcing it is a line between the person and the picture —
 * and `todo`, whose whole point is the checklist drawn in its place. A failure
 * is still reported, so nothing goes wrong in silence.
 */
const HIDDEN = new Set(['send_file', 'todo'])

/** Whether a tool's own call is drawn as a line on the surfaces. */
export function showsToolCall(name: string): boolean {
  return !HIDDEN.has(name)
}

/** The icon alone, for surfaces that draw their own line (the CLI). */
export function toolIcon(name: string): string {
  return TOOLS[name]?.icon ?? FALLBACK
}

/**
 * The mark a tool's service owns, for the surface that can draw one. Null for
 * every tool that has none, which is every tool whose emoji is already the whole
 * answer.
 */
export function toolBrand(name: string): ToolBrand | null {
  return TOOLS[name]?.brand ?? null
}

/**
 * The words of a line — the tool's name and the one value worth showing — with no
 * icon in front. The browser asks for this and draws the icon itself, because an
 * icon there is a drawing and not a character.
 */
export function toolText(
  name: string,
  args?: unknown,
  options: { markdown?: boolean } = {},
): string {
  const summary = toolDetail(args)
  const label = toolLabel(name, options.markdown ?? false)
  return summary ? `${label} ${summary}` : label
}

export function toolLine(
  name: string,
  args?: unknown,
  options: { markdown?: boolean } = {},
): string {
  return `${toolIcon(name)} ${toolText(name, args, options)}`
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
  // A verb-plus-target tool — the git reads, a browser action — is named by its
  // verb, with the path it acted on beside it. Read before the flat list below,
  // where `path` alone would otherwise answer for it and lose the verb.
  if (typeof record.action === 'string' && record.action.trim()) {
    const action = record.action.trim()
    const path = typeof record.path === 'string' ? record.path.trim() : ''
    return `${action}${path ? ` ${path}` : ''}`
  }
  // `description` is the `task` tool's label for a subtask (its `prompt` is the
  // whole instruction, and has no place on a one-line activity log); `url` and
  // `name` are the one interesting value of `fetch_url` and `read_skill`.
  for (const key of ['command', 'query', 'pattern', 'path', 'url', 'description', 'name', 'app']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) {
      const flat = value.trim().replace(/\s+/g, ' ')
      return flat.length > GIST_LIMIT ? `${flat.slice(0, GIST_LIMIT - 1)}…` : flat
    }
  }
  return ''
}
