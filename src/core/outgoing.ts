import { statSync } from 'node:fs'
import { basename, extname } from 'node:path'

/**
 * A file on its way to a chat. It is a path rather than bytes: the transcript and
 * the tool result carry the reference, and the surface reads the file when it
 * sends it — inlining megabytes of base64 would make every delivery cost more
 * than the model call that produced it.
 */
export interface OutgoingFile {
  path: string
  /** The filename a chat shows. The basename, so a directory tree is not leaked as a name. */
  name: string
  /** Decided by extension; decides photo versus document on the surfaces that care. */
  mimeType: string
  /** An optional line to ride with this file. */
  caption?: string
}

/**
 * One thing a routine — or any turn with a chat behind it — hands to a surface
 * with no turn of its own. Text and files travel together so a caption and the
 * picture it describes arrive as one message.
 */
export interface OutgoingMessage {
  text?: string
  files?: OutgoingFile[]
}

/**
 * The most a delivery may carry. Telegram's bot upload caps at 50 MB, the
 * smallest ceiling among the surfaces; a surface with a lower one of its own
 * reports it when the API refuses the file.
 */
export const MAX_OUTGOING_BYTES = 50 * 1024 * 1024

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.zip': 'application/zip',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
}

/** What every surface here can show as a picture inline. */
const IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export function mimeFor(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

export function isImage(mimeType: string): boolean {
  return IMAGES.has(mimeType)
}

/**
 * Telegram takes only PNG and JPEG as a photo; a GIF or a PDF sent as a picture
 * is refused, so anything else goes as a document — which is a download rather
 * than a preview, but it arrives.
 */
export function isTelegramPhoto(mimeType: string): boolean {
  return mimeType === 'image/png' || mimeType === 'image/jpeg'
}

/**
 * Turns a path the model named into a file a surface can send, or throws with the
 * reason said plainly — the model reads it and can try again with another path.
 */
export function describeOutgoing(path: string, caption?: string): OutgoingFile {
  const stats = statSync(path, { throwIfNoEntry: false })
  if (!stats) throw new Error(`no such file: ${path}`)
  if (!stats.isFile()) throw new Error(`not a file: ${path}`)
  if (stats.size > MAX_OUTGOING_BYTES) {
    throw new Error(
      `${basename(path)} is ${megabytes(stats.size)} — the most that can be sent is ${megabytes(MAX_OUTGOING_BYTES)}`,
    )
  }
  const trimmed = caption?.trim()
  return {
    path,
    name: basename(path),
    mimeType: mimeFor(path),
    ...(trimmed ? { caption: trimmed } : {}),
  }
}

function megabytes(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`
}
