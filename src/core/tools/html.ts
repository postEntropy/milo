/**
 * Elements that end a line of text when they open or close, so the paragraph
 * structure of a page survives the tags being taken off.
 */
const BLOCK =
  'address|article|aside|blockquote|br|dd|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul'

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  hellip: '…',
  lt: '<',
  mdash: '—',
  nbsp: ' ',
  ndash: '–',
  quot: '"',
}

/** A page as text: no tags, no scripts, no stylesheets, paragraph breaks kept. */
export function htmlToText(html: string): string {
  const body = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')

  const spaced = body
    // The line breaks a page was written with are formatting, not content:
    // flatten them first, then let the block elements put the content breaks in.
    .replace(/\s+/g, ' ')
    .replace(new RegExp(`</(?:${BLOCK})\\s*>`, 'gi'), '\n')
    .replace(new RegExp(`<(?:${BLOCK})\\b[^>]*>`, 'gi'), '\n')

  return tidy(decodeEntities(spaced.replace(/<[^>]*>/g, '')))
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X'
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10)
      const valid = Number.isFinite(code) && code > 0 && code <= 0x10ffff
      return valid ? String.fromCodePoint(code) : match
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match
  })
}

/** Collapses the indentation and blank lines the source was formatted with. */
function tidy(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n')
}
