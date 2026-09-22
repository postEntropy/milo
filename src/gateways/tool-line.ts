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

const TOOLS: Record<string, { icon: string; style: ToolLineStyle }> = {
  web_search: { icon: '🌐', style: 'quote' },
  shell_command: { icon: '▸', style: 'code' },
}

const FALLBACK: { icon: string; style: ToolLineStyle } = { icon: '▸', style: 'quote' }

/** The icon alone, for surfaces that draw their own line (the CLI). */
export function toolIcon(name: string): string {
  return (TOOLS[name] ?? FALLBACK).icon
}

export function toolStyle(name: string): ToolLineStyle {
  return (TOOLS[name] ?? FALLBACK).style
}

export function toolLine(name: string, args?: unknown): ToolLine {
  const { icon, style } = TOOLS[name] ?? FALLBACK
  const summary = gist(args)
  return { text: summary ? `${icon} ${name} ${summary}` : `${icon} ${name}`, style }
}

const GIST_LIMIT = 120

/**
 * The one interesting value of a call, for the line next to the tool name.
 *
 * Deliberately not `summarizeToolCall`: a permission prompt wants *something*
 * even when it has to dump JSON, while a tool line wants nothing rather than
 * `{}` beside the name.
 */
function gist(args: unknown): string {
  if (!args || typeof args !== 'object') return ''
  const record = args as Record<string, unknown>
  for (const key of ['command', 'query', 'path']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) {
      const flat = value.trim().replace(/\s+/g, ' ')
      return flat.length > GIST_LIMIT ? `${flat.slice(0, GIST_LIMIT - 1)}…` : flat
    }
  }
  return ''
}
