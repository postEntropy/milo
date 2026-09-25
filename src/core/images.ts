import { createHash } from 'node:crypto'
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
} from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { errorMessage } from '../util/errors.js'
import { logDebug } from '../util/log.js'
import { imagesDir } from './config/paths.js'
import { ensurePrivateDir, PRIVATE_FILE_MODE } from '../util/fs.js'
import type { ImageMime, ImageRef } from './providers/types.js'

/**
 * What a picture costs the model, whatever its size: every provider prices an
 * image by its pixels and downsamples to a fixed tile budget, so counting the
 * base64 characters would be wrong by two orders of magnitude — and a wrong
 * count is what makes a request that "fits" get rejected.
 */
export const IMAGE_TOKENS = 1500

/** How many pictures stay on disk. Older ones go; the transcript says so. */
export const KEEP_IMAGES = 20

const EXTENSION: Record<ImageMime, string> = { 'image/png': 'png', 'image/jpeg': 'jpg' }

/**
 * Puts a picture on disk and hands back a reference to it. The name is the
 * content's hash, so the same screenshot captured twice is one file — and the
 * modification time is refreshed on every save, so "least recently used" is
 * what eviction actually means.
 *
 * Returns null when the bytes cannot be kept: a screenshot nobody can show is
 * worth no more than the text result it came with.
 */
export async function saveImage(image: { mimeType: ImageMime; data: string }): Promise<ImageRef | null> {
  if (!image.data) return null
  let bytes: Buffer
  try {
    bytes = Buffer.from(image.data, 'base64')
  } catch (error) {
    logDebug(`could not read a screenshot: ${errorMessage(error)}`)
    return null
  }
  if (bytes.length === 0) return null

  const dir = imagesDir()
  const file = path.join(dir, `${createHash('sha1').update(bytes).digest('hex')}.${EXTENSION[image.mimeType]}`)
  try {
    ensurePrivateDir(dir)
    if (existsSync(file)) {
      const now = new Date()
      utimesSync(file, now, now)
    } else {
      // Through a temporary neighbour: a screenshot half written would show the
      // model a corrupted screen, which reads as a wrong answer about the app.
      const temp = `${file}.${process.pid}.tmp`
      await writeFile(temp, bytes, { mode: PRIVATE_FILE_MODE })
      await rename(temp, file)
    }
    pruneImages()
    return { mimeType: image.mimeType, path: file }
  } catch (error) {
    logDebug(`could not keep a screenshot: ${errorMessage(error)}`)
    return null
  }
}

/** The picture's bytes, base64, or null when it has been evicted meanwhile. */
export function readImageBase64(ref: ImageRef): string | null {
  try {
    return readFileSync(ref.path).toString('base64')
  } catch {
    return null
  }
}

/** A picture that could still be read, ready to inline into a request. */
export interface InlineImage {
  mimeType: ImageMime
  data: string
}

/**
 * What a wire should send for one tool result: the text, and the pictures that
 * are still readable. Shared rather than written twice per provider, so a
 * missing picture is noted the same way on both — a result that says it has a
 * screenshot and then sends none is how a model starts describing a screen it
 * cannot see.
 */
export function toolImages(part: { content: string; images?: ImageRef[] }): {
  text: string
  images: InlineImage[]
} {
  const refs = part.images ?? []
  if (refs.length === 0) return { text: part.content, images: [] }

  const images: InlineImage[] = []
  for (const ref of refs) {
    const data = readImageBase64(ref)
    if (data) images.push({ mimeType: ref.mimeType, data })
  }
  if (images.length === refs.length) return { text: part.content, images }

  const missing = refs.length - images.length
  return {
    text: `${part.content}\n[${missing} screenshot(s) no longer available]`,
    images,
  }
}

/** Drops the least recently saved pictures beyond `keep`. Best effort. */
export function pruneImages(keep = KEEP_IMAGES): void {
  const dir = imagesDir()
  if (!existsSync(dir)) return

  const files: { file: string; used: number }[] = []
  for (const entry of readdirSync(dir)) {
    const file = path.join(dir, entry)
    if (entry.endsWith('.tmp')) {
      rmSync(file, { force: true })
      continue
    }
    try {
      files.push({ file, used: statSync(file).mtimeMs })
    } catch {
      // Gone between the listing and the stat: nothing to keep or drop.
    }
  }

  for (const stale of files.sort((a, b) => b.used - a.used).slice(keep)) {
    rmSync(stale.file, { force: true })
  }
}
