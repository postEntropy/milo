import { mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { errorMessage } from '../../util/errors.js'
import { writeFileAtomic } from '../../util/fs.js'
import type { Tool } from './types.js'
import { displayPath, resolveToolPath } from './walk.js'

const schema = z.object({
  path: z.string().describe('File to write, relative to the working directory (or absolute).'),
  content: z.string().describe('The complete new contents of the file.'),
})

export type WriteFileArgs = z.infer<typeof schema>

export const writeFileTool: Tool<WriteFileArgs> = {
  name: 'write_file',
  description:
    'Create a file, or replace one entirely, with the given contents. Parent directories are created. To change part of an existing file, use edit_file instead — it keeps the rest of the file intact.',
  schema,
  readOnly: false,
  async execute(args, ctx) {
    const target = resolveToolPath(ctx.cwd, args.path)

    try {
      const existing = await stat(target).catch(() => null)
      if (existing?.isDirectory()) {
        return { content: `${args.path} is a directory, not a file.`, isError: true }
      }

      await mkdir(path.dirname(target), { recursive: true })
      await writeFileAtomic(target, args.content)

      const verb = existing ? 'Replaced' : 'Created'
      const size = Buffer.byteLength(args.content, 'utf8')
      return {
        content: `${verb} ${displayPath(ctx.cwd, target)} — ${countLines(args.content)} line(s), ${size} bytes.`,
      }
    } catch (error) {
      return { content: `Failed to write ${args.path}: ${errorMessage(error)}`, isError: true }
    }
  },
}

function countLines(content: string): number {
  if (content === '') return 0
  return content.replace(/\n$/, '').split('\n').length
}
