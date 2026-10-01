import { z } from 'zod'
import type { GoogleAccount } from '../config/schema.js'
import { tokenSource } from '../google/access.js'
import { read as readFile, search as searchFiles, type DriveFile } from '../google/drive.js'
import type { Tool } from './types.js'

/**
 * Drive, as two read-only tools — the same shape as the Gmail pair, on purpose:
 * the prefix says which service, the verb says what it does, and nothing here
 * writes. Reading a Google Doc or Sheet comes back as exported text; a file Milo
 * cannot read as text says so by type instead of pretending.
 */
const searchSchema = z.object({
  query: z
    .string()
    .describe(
      "Drive's own search syntax — `name contains 'nota'`, `mimeType = 'application/pdf'`, " +
        "`fullText contains 'orçamento'`, `'<folderId>' in parents`. Trashed files are excluded automatically.",
    ),
  limit: z.number().int().min(1).max(25).optional().describe('How many files to list. Defaults to 10.'),
})

const readSchema = z.object({
  id: z.string().describe('A file id, from drive_search.'),
})

function formatFile(file: DriveFile): string {
  const when = file.modifiedTime ? ` · ${file.modifiedTime.slice(0, 10)}` : ''
  const size = file.size ? ` · ${Math.round(Number(file.size) / 1024)} KB` : ''
  return `${file.id} · ${file.name}\n    ${file.mimeType}${when}${size}`
}

export function createDriveTools(account: GoogleAccount | null): Tool<unknown>[] {
  const token = tokenSource(account)

  const search: Tool<z.infer<typeof searchSchema>> = {
    name: 'drive_search',
    description:
      'Search the connected Google Drive and list what matched. Read-only: Milo does not create, move, share or delete anything.',
    schema: searchSchema,
    readOnly: true,
    async execute(args) {
      const got = await token()
      if (!got.ok) return { content: got.error, isError: true }

      const listed = await searchFiles(got.value, args.query, args.limit ?? 10)
      if (!listed.ok) return { content: listed.error, isError: true }
      if (listed.value.files.length === 0) return { content: `Nothing in Drive matched: ${args.query}` }

      return {
        content: [
          `${listed.value.files.length} file${listed.value.files.length === 1 ? '' : 's'} for "${args.query}":`,
          '',
          ...listed.value.files.map(formatFile),
          ...(listed.value.incomplete
            ? ['', '[Drive says it could not search everything it was asked to — this list may be partial]']
            : []),
          '',
          'Read one with drive_read, by its id.',
        ].join('\n'),
      }
    },
  }

  const read: Tool<z.infer<typeof readSchema>> = {
    name: 'drive_read',
    description:
      'Read one Drive file as text, by the id drive_search returned. Google Docs and Sheets come back exported; a folder says what it is. Read-only.',
    schema: readSchema,
    readOnly: true,
    async execute(args) {
      const got = await token()
      if (!got.ok) return { content: got.error, isError: true }

      const file = await readFile(got.value, args.id)
      if (!file.ok) return { content: file.error, isError: true }

      const notes = [
        ...(file.value.truncated ? ['[the file was cut — ask again if you need more]'] : []),
        ...(file.value.exported ? [`[exported from ${file.value.mimeType} as text]`] : []),
      ]
      return {
        content: [formatFile(file.value), '', file.value.text.trim() || '(this file is empty)', ...notes].join('\n'),
      }
    },
  }

  return [search, read]
}
