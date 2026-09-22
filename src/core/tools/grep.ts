import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { errorMessage } from '../../util/errors.js'
import type { Tool } from './types.js'
import { compileFilePattern, resolveToolPath, toPosix, walk } from './walk.js'

const schema = z.object({
  pattern: z.string().describe('JavaScript regular expression, matched within a single line.'),
  path: z.string().optional().describe('File or directory to search (default: the working directory).'),
  glob: z.string().optional().describe('Only search files matching this glob, e.g. `*.ts`.'),
  ignoreCase: z.boolean().optional().describe('Case-insensitive match.'),
  context: z
    .number()
    .int()
    .min(0)
    .max(10)
    .optional()
    .describe('Lines of context around each match (default 0).'),
  limit: z.number().int().positive().optional().describe('Maximum matches (default 50, max 200).'),
})

export type GrepArgs = z.infer<typeof schema>

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
/** A bigger file is skipped rather than read: the alternative is loading a minified bundle. */
const MAX_FILE_BYTES = 1024 * 1024

interface Group {
  file: string
  start: number
  end: number
  /** Line indexes (0-based) that matched; the rest of the range is context. */
  matches: Set<number>
  lines: string[]
}

export const grepTool: Tool<GrepArgs> = {
  name: 'grep',
  description:
    'Search file contents with a regular expression, returning `path:line: text`. Prefer it over shelling out to grep or rg: it skips build and dependency directories and reports its own truncation.',
  schema,
  readOnly: true,
  async execute(args, ctx) {
    const label = args.path?.trim() || ctx.cwd

    let matcher: RegExp
    try {
      matcher = new RegExp(args.pattern, args.ignoreCase ? 'i' : '')
    } catch (error) {
      return { content: `Invalid pattern "${args.pattern}": ${errorMessage(error)}`, isError: true }
    }

    let fileFilter: RegExp | null = null
    if (args.glob?.trim()) {
      try {
        fileFilter = compileFilePattern(args.glob)
      } catch (error) {
        return { content: `Invalid glob "${args.glob}": ${errorMessage(error)}`, isError: true }
      }
    }

    const target = resolveToolPath(ctx.cwd, args.path)
    const info = await stat(target).catch(() => null)
    if (!info) return { content: `No such file or directory: ${label}`, isError: true }

    const files: { path: string; rel: string }[] = []
    let truncated = false

    if (info.isDirectory()) {
      const result = await walk({ root: target, signal: ctx.signal })
      truncated = result.truncated
      for (const entry of result.entries) {
        if (fileFilter && !fileFilter.test(entry.rel)) continue
        files.push({ path: entry.path, rel: entry.rel })
      }
      // Read directory order varies by filesystem, so sort it: the output (and
      // which matches a `limit` cuts) should not depend on where the run happens.
      files.sort((a, b) => a.rel.localeCompare(b.rel))
    } else {
      const rel = toPosix(path.relative(ctx.cwd, target)) || path.basename(target)
      if (!fileFilter || fileFilter.test(rel)) files.push({ path: target, rel })
    }

    const limit = Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT)
    const context = args.context ?? 0
    const groups: Group[] = []
    let matchCount = 0
    let skipped = 0
    let stopped = false

    for (const file of files) {
      if (ctx.signal?.aborted || stopped) break

      const fileInfo = await stat(file.path).catch(() => null)
      if (!fileInfo || fileInfo.size > MAX_FILE_BYTES) {
        skipped += 1
        continue
      }

      const buffer = await readFile(file.path).catch(() => null)
      // A NUL byte in the first bytes is the usual "this is not text" tell.
      if (!buffer || buffer.includes(0)) {
        skipped += 1
        continue
      }

      const lines = buffer
        .toString('utf8')
        .split('\n')
        .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))

      const hits: number[] = []
      for (let index = 0; index < lines.length; index += 1) {
        if (matcher.test(lines[index]!)) hits.push(index)
      }
      if (hits.length === 0) continue

      for (const hit of hits) {
        if (matchCount >= limit) {
          stopped = true
          break
        }
        matchCount += 1

        const start = Math.max(0, hit - context)
        const end = Math.min(lines.length - 1, hit + context)
        const previous = groups[groups.length - 1]
        if (previous && previous.file === file.rel && start <= previous.end + 1) {
          previous.end = Math.max(previous.end, end)
          previous.matches.add(hit)
          continue
        }
        groups.push({ file: file.rel, start, end, matches: new Set([hit]), lines })
      }
    }

    const notes: string[] = []
    if (stopped) notes.push(`stopped at ${limit} matches`)
    if (truncated) notes.push('the tree was only partly walked')
    if (skipped > 0) notes.push(`${skipped} binary or large file(s) skipped`)
    const trailer = notes.length > 0 ? `… (${notes.join('; ')})` : null

    if (groups.length === 0) {
      return {
        content: [`No matches for /${args.pattern}/ in ${label}.`, trailer]
          .filter(Boolean)
          .join('\n'),
      }
    }

    const output: string[] = []
    for (const group of groups) {
      if (output.length > 0) output.push('--')
      for (let line = group.start; line <= group.end; line += 1) {
        const text = group.lines[line] ?? ''
        output.push(
          group.matches.has(line)
            ? `${group.file}:${line + 1}: ${text}`
            : `${group.file}-${line + 1}- ${text}`,
        )
      }
    }
    if (trailer) output.push(trailer)

    return { content: output.join('\n') }
  },
}
