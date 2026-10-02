import { stat } from 'node:fs/promises'
import { z } from 'zod'
import { errorMessage } from '../../util/errors.js'
import type { Tool } from './types.js'
import { compileFilePattern, resolveToolPath, walk } from './walk.js'

const schema = z.object({
  pattern: z
    .string()
    .describe(
      'Glob pattern, e.g. `**/*.ts` or `src/**/*.{test,spec}.ts`. Supports **, *, ?, […] and {a,b}. A pattern without a `/` matches at any depth.',
    ),
  path: z.string().optional().describe('Directory to search from (default: the working directory).'),
  limit: z.number().int().positive().optional().describe('Maximum results (default 100, max 500).'),
})

export type GlobArgs = z.infer<typeof schema>

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500

export const globTool: Tool<GlobArgs> = {
  name: 'glob',
  description:
    'Find files whose path matches a glob pattern. Returns paths relative to the search root, most recently modified first. Directories are not returned — use list_dir for those.',
  schema,
  readOnly: true,
  concurrent: true,
  async execute(args, ctx) {
    const root = resolveToolPath(ctx.cwd, args.path)
    const label = args.path?.trim() || root

    let matcher: RegExp
    try {
      matcher = compileFilePattern(args.pattern)
    } catch (error) {
      return { content: `Invalid pattern "${args.pattern}": ${errorMessage(error)}`, isError: true }
    }

    const info = await stat(root).catch(() => null)
    if (!info) return { content: `No such directory: ${label}`, isError: true }
    if (!info.isDirectory()) return { content: `${label} is not a directory.`, isError: true }

    const limit = Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT)
    const { entries, truncated, aborted } = await walk({ root, signal: ctx.signal })
    const partial = aborted ? '(the walk was cancelled)' : truncated ? '(the tree was only partly walked)' : null
    const matches = entries
      .filter((entry) => matcher.test(entry.rel))
      .sort((a, b) => b.mtimeMs - a.mtimeMs || a.rel.localeCompare(b.rel))

    if (matches.length === 0) {
      const note = partial ? ` ${partial}` : ''
      return { content: `No files match "${args.pattern}" in ${label}.${note}` }
    }

    const lines = matches.slice(0, limit).map((entry) => entry.rel)
    if (matches.length > lines.length) {
      lines.push(`… ${matches.length} matched, showing the ${lines.length} most recent`)
    }
    if (partial) lines.push(`… ${partial}`)

    return { content: lines.join('\n') }
  },
}
