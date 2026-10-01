/**
 * Drive, read-only: find files, then read one.
 *
 * Drive is messier than Gmail in one specific way: a file made *by* Google (a
 * Doc, a Sheet, a Slide) has no bytes to download at all — the API exports it —
 * while everything else is fetched with `alt=media`. And a folder has no content
 * in any sense, so saying "that is a folder, list what is in it" is the answer,
 * not an empty body.
 */
import { authorizedJson, authorizedText, type GoogleOutcome, type GoogleTokens } from './oauth.js'

const API = 'https://www.googleapis.com/drive/v3/files'

/** Files cut here: a 40 MB CSV is not a thing to hand a model. */
export const FILE_LIMIT = 4000

/** Google's own types, and what each one exports as. */
const NATIVE: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
}

const FOLDER = 'application/vnd.google-apps.folder'

export interface DriveFile {
  id: string
  name: string
  mimeType: string
  modifiedTime?: string
  size?: string
}

export interface DriveContent extends DriveFile {
  text: string
  truncated: boolean
  /** True when Google had to export the file rather than download it. */
  exported: boolean
}

export interface DriveListing {
  files: DriveFile[]
  /**
   * Drive says so itself when it could not search everything it was asked to.
   * Passed on rather than dropped: a short list that is really a partial one is
   * a wrong answer.
   */
  incomplete: boolean
}

const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

function fileOf(entry: unknown): DriveFile {
  const one = entry as Record<string, unknown>
  return {
    id: asString(one.id) ?? '',
    name: asString(one.name) ?? '(no name)',
    mimeType: asString(one.mimeType) ?? 'application/octet-stream',
    ...(asString(one.modifiedTime) ? { modifiedTime: asString(one.modifiedTime)! } : {}),
    ...(asString(one.size) ? { size: asString(one.size)! } : {}),
  }
}

/**
 * Search, in Drive's own syntax — `name contains 'nota'`, `mimeType = 'application/pdf'`,
 * `fullText contains 'orçamento'`, `'<folderId>' in parents`.
 *
 * `trashed = false` is added here because Drive's default is to include what is
 * in the bin, and nobody searching means to find that.
 */
export async function search(
  tokens: GoogleTokens,
  query: string,
  limit: number,
): Promise<GoogleOutcome<DriveListing>> {
  const url = new URL(API)
  url.searchParams.set('q', `(${query}) and trashed = false`)
  url.searchParams.set('fields', 'files(id,name,mimeType,modifiedTime,size),incompleteSearch')
  // Newest first: the last thing touched is usually the thing being looked for.
  url.searchParams.set('orderBy', 'modifiedTime desc')
  url.searchParams.set('pageSize', String(limit))

  const listed = await authorizedJson(tokens, url)
  if (!listed.ok) return listed

  const payload = listed.value as { files?: unknown; incompleteSearch?: unknown }
  const entries = Array.isArray(payload.files) ? payload.files : []
  return {
    ok: true,
    value: { files: entries.map(fileOf), incomplete: payload.incompleteSearch === true },
  }
}

/** Where the bytes of a file come from, by the type Drive reports for it. */
function sourceFor(file: DriveFile, id: string): { url: URL; exported: boolean; mimeType: string } {
  const native = file.mimeType.startsWith('application/vnd.google-apps.') && file.mimeType !== FOLDER
  const url = new URL(`${API}/${encodeURIComponent(id)}`)
  if (native) {
    const target = NATIVE[file.mimeType] ?? 'text/plain'
    url.pathname += '/export'
    url.searchParams.set('mimeType', target)
    return { url, exported: true, mimeType: target }
  }
  url.searchParams.set('alt', 'media')
  return { url, exported: false, mimeType: file.mimeType }
}

/** Whether a type is text Milo can hand over as it is. */
function readableAsText(mimeType: string): boolean {
  return mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType.endsWith('+xml')
}

/** One file's metadata, which is what `read` needs to decide how to fetch it. */
async function metadata(tokens: GoogleTokens, id: string): Promise<GoogleOutcome<DriveFile>> {
  const url = new URL(`${API}/${encodeURIComponent(id)}`)
  url.searchParams.set('fields', 'id,name,mimeType,modifiedTime,size')
  const got = await authorizedJson(tokens, url)
  if (!got.ok) return got
  return { ok: true, value: fileOf(got.value) }
}

/** One file's content, cut to `FILE_LIMIT`, or a sentence saying why not. */
export async function read(tokens: GoogleTokens, id: string): Promise<GoogleOutcome<DriveContent>> {
  const found = await metadata(tokens, id)
  if (!found.ok) return found
  const file = found.value

  if (file.mimeType === FOLDER) {
    // The honest answer, and the next move with it.
    return {
      ok: true,
      value: {
        ...file,
        text: `"${file.name}" is a folder. List what is inside it with drive_search and the query \`'${id}' in parents\`.`,
        truncated: false,
        exported: false,
      },
    }
  }

  const source = sourceFor(file, id)
  if (!source.exported && !readableAsText(source.mimeType)) {
    // Named, not guessed at: pretending to have read a PDF is worse than saying
    // it is one.
    return {
      ok: false,
      error: `"${file.name}" is ${file.mimeType}, which Milo cannot read as text yet.`,
    }
  }

  const body = await authorizedText(tokens, source.url)
  if (!body.ok) return body
  const cut = body.value.length > FILE_LIMIT
  return {
    ok: true,
    value: {
      ...file,
      text: cut ? `${body.value.slice(0, FILE_LIMIT)}\n… [cut here: ${body.value.length - FILE_LIMIT} more characters]` : body.value,
      truncated: cut,
      exported: source.exported,
    },
  }
}
