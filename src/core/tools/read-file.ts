import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { errorMessage } from '../../util/errors.js'
import type { Tool } from './types.js'
import { displayPath, resolveScopedPath } from './walk.js'

const schema = z.object({
  path: z.string().describe('File path, relative to the working directory (or absolute).'),
  offset: z.number().int().nonnegative().optional().describe('1-based line to start reading from.'),
  limit: z.number().int().positive().optional().describe('Maximum number of lines to return.'),
})

export type ReadFileArgs = z.infer<typeof schema>

/**
 * How much of a file one page of it holds. Exported because reading a file is one
 * behaviour with one cut: the model's reader and a screen's reader page the same way,
 * so what a person sees while the agent works is the same page the agent was handed.
 */
export const FILE_PAGE_LINES = 400
export const FILE_PAGE_CHARS = 40_000

/** One page of a text file: whole numbered lines, where it started, and what is left. */
export interface TextPage {
  ok: true
  /** The lines of this page, each numbered `n\tline`. Never cut inside a line. */
  lines: string[]
  /** The 1-based line this page starts at. */
  from: number
  /** How many lines the whole file has. */
  total: number
  /** The 1-based line the next page starts at; absent when this page is the last. */
  next?: number
}

/** A page asked for past the end of the file: not an empty file, and not an error either. */
export interface TextBeyond {
  ok: false
  /** The line that was asked for. */
  beyond: number
  total: number
}

/**
 * Cuts one page out of a file's text, between lines and never inside one — the caller
 * continues with `offset`, so a cut it cannot name would leave it guessing what it had
 * read. The character budget exists for a minified bundle: a single line longer than the
 * whole page is clipped rather than returned whole.
 *
 * An empty file is a page with no lines rather than a line past its end.
 */
export function pageText(
  raw: string,
  options: { offset?: number; limit?: number } = {},
): TextPage | TextBeyond {
  const lines = raw === '' ? [] : raw.split('\n')
  // A trailing newline terminates the last line, it does not start another.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()

  const offset = Math.max(0, (options.offset ?? 1) - 1)
  if (offset > 0 && offset >= lines.length) return { ok: false, beyond: offset + 1, total: lines.length }

  const limit = Math.min(options.limit ?? FILE_PAGE_LINES, FILE_PAGE_LINES)
  const page: string[] = []
  let chars = 0
  for (const [index, line] of lines.slice(offset, offset + limit).entries()) {
    const entry = clip(`${offset + index + 1}\t${line}`)
    // Stop between lines, never inside one.
    if (chars > 0 && chars + entry.length + 1 > FILE_PAGE_CHARS) break
    page.push(entry)
    chars += entry.length + 1
  }

  const next = offset + page.length
  return {
    ok: true,
    lines: page,
    from: offset + 1,
    total: lines.length,
    ...(next < lines.length ? { next: next + 1 } : {}),
  }
}

export const readFileTool: Tool<ReadFileArgs> = {
  name: 'read_file',
  description:
    'Read a UTF-8 text file from disk and return its line-numbered contents. Use when the user points you at a file. A long file comes back in pages: the reply says where it stopped, and the offset that continues from there.',
  schema,
  readOnly: true,
  concurrent: true,
  async execute(args, ctx) {
    const scoped = resolveScopedPath(ctx.cwd, args.path, ctx.confineTo)
    if (!scoped.ok) return { content: scoped.error, isError: true }
    const target = scoped.path
    const shown = displayPath(ctx.cwd, target)

    try {
      const raw = await readFile(target, 'utf8')
      if (raw === '') return { content: '(empty file)' }

      const page = pageText(raw, args)
      if (!page.ok) {
        return {
          content: `Line ${page.beyond} is past the end of ${shown} — it has ${page.total} line(s).`,
          isError: true,
        }
      }

      const body = page.lines.join('\n')
      if (page.next !== undefined) {
        return {
          content: `${body}\n… ${page.total - (page.next - 1)} more line(s); continue with offset=${page.next}`,
        }
      }
      return { content: body }
    } catch (error) {
      return { content: `Failed to read ${shown}: ${errorMessage(error)}`, isError: true }
    }
  },
}

/** One line longer than the whole budget — a minified bundle — is clipped. */
function clip(text: string): string {
  return text.length > FILE_PAGE_CHARS ? `${text.slice(0, FILE_PAGE_CHARS)} …` : text
}
