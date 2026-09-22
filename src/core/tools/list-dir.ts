import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { errorMessage } from '../../util/errors.js'
import type { Tool } from './types.js'
import { DEFAULT_IGNORES, resolveToolPath } from './walk.js'

const schema = z.object({
  path: z
    .string()
    .optional()
    .describe('Directory to list, relative to the working directory (default: the working directory).'),
})

export type ListDirArgs = z.infer<typeof schema>

const MAX_ENTRIES = 500

interface Row {
  name: string
  dir: boolean
  size: number
}

export const listDirTool: Tool<ListDirArgs> = {
  name: 'list_dir',
  description:
    'List one directory (not recursive): directories with a trailing slash, files with their size. Build and dependency directories are summarized as a count instead of being expanded. Use glob to find files by pattern across a tree.',
  schema,
  readOnly: true,
  async execute(args, ctx) {
    const target = resolveToolPath(ctx.cwd, args.path)
    const label = args.path?.trim() || target

    let dirents
    try {
      dirents = await readdir(target, { withFileTypes: true })
    } catch (error) {
      return { content: `Failed to list ${label}: ${errorMessage(error)}`, isError: true }
    }

    const rows: Row[] = []
    const collapsed: string[] = []

    for (const dirent of dirents) {
      if (DEFAULT_IGNORES.has(dirent.name)) {
        collapsed.push(dirent.name)
        continue
      }
      if (dirent.isDirectory()) {
        rows.push({ name: `${dirent.name}/`, dir: true, size: 0 })
        continue
      }
      if (!dirent.isFile()) continue
      const info = await stat(path.join(target, dirent.name)).catch(() => null)
      rows.push({ name: dirent.name, dir: false, size: info?.size ?? 0 })
    }

    rows.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))

    if (rows.length === 0) {
      const notes = collapsed.length > 0 ? `\n${collapseNote(collapsed)}` : ''
      return { content: `(no entries in ${label})${notes}` }
    }

    const shown = rows.slice(0, MAX_ENTRIES)
    const width = Math.max(...shown.map((row) => row.name.length))
    const lines = shown.map((row) =>
      row.dir ? row.name : `${row.name.padEnd(width)}  ${humanSize(row.size)}`,
    )

    if (rows.length > shown.length) lines.push(`… ${rows.length - shown.length} more entries`)
    if (collapsed.length > 0) lines.push(collapseNote(collapsed))

    return { content: lines.join('\n') }
  },
}

function collapseNote(names: string[]): string {
  return `(${names.length} not expanded: ${names.sort().join(', ')})`
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
