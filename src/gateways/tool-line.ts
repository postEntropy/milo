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
 * a Drive call looks like there and the mark is what it looks like in the browser.
 * The email tools have no brand: they share one mail mark, drawn from the emoji
 * table below and from the browser's own icon set, so there is nothing per-service
 * to name.
 */
export type ToolBrand = 'drive'

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
  sessions: { icon: '🗃' },
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
  // Every email tool wears the one envelope — the browser draws the same mail mark,
  // and a chat client, which can only draw a character, wears this one.
  gmail_search: { icon: '📧' },
  gmail_read: { icon: '📧' },
  gmail_modify: { icon: '📧' },
  mail_labels: { icon: '📧' },
  // A folder rather than Drive's logotype: the text surfaces can only draw a
  // character, and there is no Drive emoji — the browser draws the mark instead.
  drive_search: { icon: '📂', brand: 'drive' },
  drive_read: { icon: '📂', brand: 'drive' },
}

const FALLBACK = '🔧'

/**
 * An MCP tool's name is `mcp__<server>__<tool>` by construction, and what a
 * person reads is `<server>: <tool>`. The prefix is the origin, and that is worth
 * keeping — a call that leaves the machine should look like one — but not at the
 * price of the name being unreadable.
 *
 * The server half admits only single separators (`config.ts` enforces the same),
 * so the first `__` is the delimiter however many underscores the tool's own name
 * carries.
 */
const MCP_NAME = /^mcp__([a-z0-9]+(?:[_-][a-z0-9]+)*)__(.+)$/

/** The name a person reads for a tool, on any surface that names one. */
export function toolDisplayName(name: string): string {
  const mcp = MCP_NAME.exec(name)
  return mcp ? `${mcp[1]}: ${mcp[2]}` : name
}

/** The plug, for a tool that runs on someone else's server. */
export function isExternalTool(name: string): boolean {
  return MCP_NAME.test(name)
}

/**
 * Tools whose own activity is not drawn, because their result is drawn in its place.
 * Reaching for one should read as the answer itself, not as a call: `send_file` is
 * the case — the file lands in the chat, and a line announcing it is a line between
 * the person and the picture — and `todo`, whose whole point is the checklist drawn
 * in its place. `panel` is the same: its result is the panel itself, so a line
 * announcing it would stand between the person and what they are looking at. A
 * failure of any of these is still said: the picture that never arrived is news.
 */
const QUIET = new Set(['send_file', 'todo', 'panel'])

/**
 * Tools that are not tools any more, kept out of the transcript for the sake of a
 * history written while they existed. `render_ui` is the case: its call carried a
 * widget, the widget is what such a session draws, and its line would be a line
 * about a call nobody watching ever made. Neither the call nor a failure of it
 * belongs on a line — a failure beside that widget could only be the note that the
 * tool has since been removed, which is not news about the turn it was written in.
 */
const RETIRED = new Set(['render_ui'])

/** Whether a tool's own call is drawn as a line on the surfaces. */
export function showsToolCall(name: string): boolean {
  return !QUIET.has(name) && !RETIRED.has(name)
}

/** Whether a failure of this tool's call still needs saying. */
export function drawsToolFailure(name: string): boolean {
  return !RETIRED.has(name)
}

/**
 * How much of a call a surface draws: the value beside the name, the name alone,
 * or nothing at all. The same three the display setting offers, declared here
 * because this file is where the decision is made and it depends on nothing —
 * the config's own type is the schema's, which this cannot reach for without
 * dragging zod into the browser bundle.
 */
export type ToolLevel = 'full' | 'name' | 'off'

/** A call as a surface draws it. Structurally the web's `ToolMark`, spelled here
 *  so this module stays free of any protocol. */
export interface DrawnTool {
  name: string
  text: string
}

/**
 * The call as a line, or null where this level does not draw one.
 *
 * The one place that decides what a level means, so the live turn, a session read
 * back from disk and the settings preview cannot answer it three ways — which they
 * did: the live path applied the level, the read-back ignored it, and the preview
 * faked it by pre-formatting a shorter string. With the level at `name`, that made
 * a reopened session draw the full line the live turn never showed.
 *
 * A hidden tool is null at every level: its own activity is drawn in its place. A
 * caller that needs to report its *failure* asks `showsToolCall` instead — hiding
 * that something went wrong is worse than the noise.
 */
export function toolDraw(name: string, args: unknown, level: ToolLevel): DrawnTool | null {
  if (level === 'off' || !showsToolCall(name)) return null
  return { name, text: toolText(name, level === 'name' ? undefined : args) }
}

/** The icon alone, for surfaces that draw their own line (the CLI). */
export function toolIcon(name: string): string {
  return TOOLS[name]?.icon ?? (isExternalTool(name) ? '🔌' : FALLBACK)
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
  const label = toolDisplayName(name)
  return markdown ? `**${label}**` : label
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

/** How much of what a tool came back with a surface is handed: past this it is the
 *  turn's raw copy that holds the whole, and a line drawn from a wall of output helps
 *  nobody. */
const RESULT_LIMIT = 4000

/**
 * What a tool came back with, for the detail under its call.
 *
 * Trailing whitespace is dropped; a result longer than the limit is cut with a trailing
 * ellipsis, which is honest about what it is — the whole of it is in the turn's raw copy.
 * Empty where there is nothing worth a line, which a surface reads as "draw nothing".
 *
 * One function, so the live turn and a session read back from disk hand a surface the
 * same string, and the two drawable surfaces cannot cut it two ways.
 */
export function toolResult(content: string): string {
  const text = content.replace(/\s+$/, '')
  return text.length > RESULT_LIMIT ? `${text.slice(0, RESULT_LIMIT - 1)}…` : text
}

/** One value flattened onto the line and cut to the gist's length. */
function gist(value: string): string {
  const flat = value.trim().replace(/\s+/g, ' ')
  return flat.length > GIST_LIMIT ? `${flat.slice(0, GIST_LIMIT - 1)}…` : flat
}

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
  // A verb-plus-target tool — the git reads, a browser action, `sessions remove` —
  // is named by its verb, with the thing it acted on beside it: the path for a read,
  // the id for a session or a routine. Read before the flat list below, where `path`
  // alone would otherwise answer for it and lose the verb.
  if (typeof record.action === 'string' && record.action.trim()) {
    const action = record.action.trim()
    const target = [record.path, record.id].find(
      (value) => typeof value === 'string' && value.trim() !== '',
    )
    return `${action}${typeof target === 'string' ? ` ${target.trim()}` : ''}`
  }
  // `remember` keeps a list of facts, not one value: the line shows the first — the
  // fact kept is the news, and what it was is what a person wants to read here — and
  // counts the rest rather than dumping a list into a line meant for a gist.
  const facts = Array.isArray(record.facts)
    ? record.facts.filter((fact): fact is string => typeof fact === 'string' && fact.trim() !== '')
    : []
  if (facts.length > 0) {
    const first = gist(facts[0])
    return facts.length > 1 ? `${first} (+${facts.length - 1} more)` : first
  }
  // `description` is the `task` tool's label for a subtask (its `prompt` is the
  // whole instruction, and has no place on a one-line activity log); `url` and
  // `name` are the one interesting value of `fetch_url` and `read_skill`.
  for (const key of ['command', 'query', 'pattern', 'path', 'url', 'description', 'name', 'app']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return gist(value)
  }
  return ''
}
