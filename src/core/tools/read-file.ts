import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { errorMessage } from '../../util/errors.js'
import type { Tool } from './types.js'
import { displayPath, resolveToolPath } from './walk.js'

const schema = z.object({
  path: z.string().describe('File path, relative to the working directory (or absolute).'),
  offset: z.number().int().nonnegative().optional().describe('1-based line to start reading from.'),
  limit: z.number().int().positive().optional().describe('Maximum number of lines to return.'),
})

export type ReadFileArgs = z.infer<typeof schema>

const MAX_LINES = 400
const MAX_CHARS = 40_000

export const readFileTool: Tool<ReadFileArgs> = {
  name: 'read_file',
  description:
    'Read a UTF-8 text file from disk and return its line-numbered contents. Use when the user points you at a file. A long file comes back in pages: the reply says where it stopped, and the offset that continues from there.',
  schema,
  readOnly: true,
  concurrent: true,
  async execute(args, ctx) {
    const target = resolveToolPath(ctx.cwd, args.path)
    const shown = displayPath(ctx.cwd, target)

    try {
      const raw = await readFile(target, 'utf8')
      if (raw === '') return { content: '(empty file)' }

      const lines = raw.split('\n')
      // A trailing newline terminates the last line, it does not start another.
      if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()

      const offset = Math.max(0, (args.offset ?? 1) - 1)
      if (offset >= lines.length) {
        return {
          content: `Line ${offset + 1} is past the end of ${shown} — it has ${lines.length} line(s).`,
          isError: true,
        }
      }

      const limit = Math.min(args.limit ?? MAX_LINES, MAX_LINES)
      const numbered: string[] = []
      let chars = 0
      for (const [index, line] of lines.slice(offset, offset + limit).entries()) {
        const entry = clip(`${offset + index + 1}\t${line}`)
        // Stop between lines, never inside one: the caller pages with `offset`,
        // so a cut it cannot name would leave it guessing what it had read.
        if (chars > 0 && chars + entry.length + 1 > MAX_CHARS) break
        numbered.push(entry)
        chars += entry.length + 1
      }

      const body = numbered.join('\n')
      const next = offset + numbered.length
      if (next < lines.length) {
        return {
          content: `${body}\n… ${lines.length - next} more line(s); continue with offset=${next + 1}`,
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
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)} …` : text
}
