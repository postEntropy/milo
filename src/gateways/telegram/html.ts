/**
 * How a Markdown answer is written for Telegram.
 *
 * The runner writes one Markdown for every chat surface, and Telegram is the one
 * that has to be told what to do with it. It used to go out as a *rich message*
 * (Bot API 10.1+), which renders headings, lists and tables nicely — but a
 * fenced block sent that way is drawn differently from the same text typed by
 * hand or sent as an ordinary message: the language is not applied, so a shell
 * command does not come out as the code block it is meant to be, on the one
 * surface where a command is meant to be copied out of the chat. Measuring it
 * settled the trade: an ordinary message with `parse_mode: HTML` draws the block
 * the way the client draws its own, and the tags below are what that mode knows.
 *
 * Only tags Telegram's HTML mode has are emitted — `<b>`, `<i>`, `<code>`,
 * `<pre>`, `<blockquote>` and links — and every literal `&`, `<` and `>` is
 * escaped, because an unescaped one is a parse error that costs the whole
 * message its formatting. What HTML mode has no tag for (a heading, a list, a
 * table) comes out as its own text, which is why the surfaces' prompt says only
 * what is actually drawn.
 */

interface Tags {
  /** Ordinary text: escaped, or as it stands when the markup is being dropped. */
  text(text: string): string
  /** Every tag below takes its text already through `text`. */
  bold(text: string): string
  italic(text: string): string
  code(text: string): string
  link(text: string, url: string): string
  quote(text: string): string
  block(code: string, language: string): string
}

const HTML: Tags = {
  text: escapeHtml,
  bold: (text) => `<b>${text}</b>`,
  italic: (text) => `<i>${text}</i>`,
  code: (text) => `<code>${text}</code>`,
  link: (text, url) => `<a href="${url.replace(/"/g, '&quot;')}">${text}</a>`,
  quote: (text) => `<blockquote>${text}</blockquote>`,
  block: (code, language) =>
    language ? `<pre><code class="language-${language}">${code}</code></pre>` : `<pre>${code}</pre>`,
}

/** The same walk with the markup dropped: what a message falls back to. */
const PLAIN: Tags = {
  text: (text) => text,
  bold: (text) => text,
  italic: (text) => text,
  code: (text) => text,
  link: (text) => text,
  quote: (text) => text,
  block: (code) => code,
}

/** The runner's Markdown as Telegram HTML. */
export function toHtml(markdown: string): string {
  return render(markdown, HTML)
}

/**
 * The same message as plain text, with no markup left in it.
 *
 * The fallback for a message Telegram refused: what the person gets is the words
 * without the fences and asterisks, rather than the raw Markdown the app would
 * otherwise show them.
 */
export function toPlain(markdown: string): string {
  return render(markdown, PLAIN)
}

function render(markdown: string, tags: Tags): string {
  const lines = markdown.split('\n')
  const out: string[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]!

    if (isFence(line)) {
      const language = line.slice(3).trim()
      const code: string[] = []
      index += 1
      // A clamp can cut the closing fence off with the tail of a long message.
      // The block is closed regardless, so a message that lost its end still
      // parses instead of costing the whole message its formatting.
      while (index < lines.length && !isFence(lines[index]!)) {
        code.push(lines[index]!)
        index += 1
      }
      index += 1
      out.push(tags.block(tags.text(code.join('\n')), tags.text(language)))
      continue
    }

    if (line.startsWith('>')) {
      const quoted: string[] = []
      while (index < lines.length && lines[index]!.startsWith('>')) {
        // The `> ` marker goes; the two trailing spaces that separate the lines
        // of one quote run are a Markdown hard break HTML does not need.
        quoted.push(lines[index]!.replace(/^> ?/, '').replace(/ +$/, ''))
        index += 1
      }
      out.push(tags.quote(quoted.map((one) => inline(one, tags)).join('\n')))
      continue
    }

    const heading = /^#{1,6} +(.+)$/.exec(line)
    out.push(heading ? tags.bold(inline(heading[1]!, tags)) : inline(line, tags))
    index += 1
  }

  return out.join('\n')
}

/**
 * The inline Markdown of one line, in the surface's own tags.
 *
 * The text is escaped first, so a `<` the model wrote cannot become a tag, and
 * the tags are inserted after: escaping touches none of `*`, a backtick or a
 * bracket, so the two passes cannot collide.
 */
function inline(text: string, tags: Tags): string {
  return tags
    .text(text)
    .replace(/\*\*([^*\n]+)\*\*/g, (_match, bold: string) => tags.bold(bold))
    .replace(/\*([^*\n]+)\*/g, (_match, italic: string) => tags.italic(italic))
    .replace(/`([^`\n]+)`/g, (_match, code: string) => tags.code(code))
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_match, label: string, url: string) =>
      tags.link(label, url),
    )
}

function isFence(line: string): boolean {
  return line.startsWith('```')
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
