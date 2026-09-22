import { readFile, stat, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import { errorMessage } from '../../util/errors.js'
import type { Tool } from './types.js'
import { displayPath, resolveToolPath } from './walk.js'

const schema = z.object({
  path: z.string().describe('File to edit, relative to the working directory (or absolute).'),
  old_string: z
    .string()
    .describe('Exact text to replace. It must appear exactly once, unless replace_all is set.'),
  new_string: z.string().describe('The text to put in its place.'),
  replace_all: z
    .boolean()
    .optional()
    .describe('Replace every occurrence instead of failing when there is more than one.'),
})

export type EditFileArgs = z.infer<typeof schema>

export const editFileTool: Tool<EditFileArgs> = {
  name: 'edit_file',
  description:
    'Replace an exact string in an existing file, leaving the rest untouched. Fails rather than guess when the string is absent or ambiguous, so read_file first and include enough context to make it unique.',
  schema,
  readOnly: false,
  async execute(args, ctx) {
    const target = resolveToolPath(ctx.cwd, args.path)
    const shown = displayPath(ctx.cwd, target)

    if (args.old_string === '') {
      return { content: 'old_string must not be empty.', isError: true }
    }

    const existing = await stat(target).catch(() => null)
    if (!existing) {
      return { content: `${shown} does not exist — use write_file to create it.`, isError: true }
    }
    if (existing.isDirectory()) {
      return { content: `${shown} is a directory, not a file.`, isError: true }
    }

    let content: string
    try {
      content = await readFile(target, 'utf8')
    } catch (error) {
      return { content: `Failed to read ${shown}: ${errorMessage(error)}`, isError: true }
    }

    const occurrences = content.split(args.old_string).length - 1
    if (occurrences === 0) {
      return {
        content: `old_string was not found in ${shown}. Read the file and match its text exactly.`,
        isError: true,
      }
    }
    if (occurrences > 1 && !args.replace_all) {
      return {
        content: `old_string appears ${occurrences} times in ${shown} — include more context to make it unique, or set replace_all.`,
        isError: true,
      }
    }

    // The replacement is applied through a function: a string replacement would
    // read `$&` and friends in `new_string` as patterns and corrupt the file.
    const updated = args.replace_all
      ? content.split(args.old_string).join(args.new_string)
      : content.replace(args.old_string, () => args.new_string)

    try {
      await writeFile(target, updated, 'utf8')
    } catch (error) {
      return { content: `Failed to write ${shown}: ${errorMessage(error)}`, isError: true }
    }

    if (args.replace_all) {
      return { content: `Edited ${shown} — replaced ${occurrences} occurrence(s).` }
    }
    const line = content.slice(0, content.indexOf(args.old_string)).split('\n').length
    return { content: `Edited ${shown} — replaced 1 occurrence at line ${line}.` }
  },
}
