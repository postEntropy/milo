import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { errorMessage } from '../../util/errors.js'
import type { Tool } from './types.js'

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
    'Read a UTF-8 text file from disk and return its line-numbered contents. Use when the user points you at a file.',
  schema,
  readOnly: true,
  async execute(args, ctx) {
    const target = path.isAbsolute(args.path) ? args.path : path.resolve(ctx.cwd, args.path)
    try {
      const raw = await readFile(target, 'utf8')
      const lines = raw.split('\n')
      const offset = Math.max(0, (args.offset ?? 1) - 1)
      const limit = Math.min(args.limit ?? MAX_LINES, MAX_LINES)
      const slice = lines.slice(offset, offset + limit)
      const body = slice.map((line, index) => `${offset + index + 1}\t${line}`).join('\n')
      if (!body) return { content: '(empty file)' }
      const content = body.length > MAX_CHARS ? `${body.slice(0, MAX_CHARS)}\n… (truncated)` : body
      return { content }
    } catch (error) {
      return { content: `Failed to read ${args.path}: ${errorMessage(error)}`, isError: true }
    }
  },
}
