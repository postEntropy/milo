import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs'
import path from 'node:path'
import { errorMessage } from '../util/errors.js'
import { ensurePrivateDir, writePrivateFile } from '../util/fs.js'
import { logDebug } from '../util/log.js'
import { fetchedDir } from './config/paths.js'

/**
 * A page larger than this is not kept at all — not on disk, and not in the
 * fetch tool's memory cache. One number, shared, so the two bounds cannot drift.
 */
export const MAX_PAGE_CHARS = 1_000_000

/** How many fetched pages stay on disk. Older ones go; asking again re-fetches. */
const KEEP_PAGES = 50

/**
 * Where a page's text is kept: one file per URL, named by the URL's hash, under
 * `~/.milo/fetched`. The name is derived from the URL alone, so a caller that
 * has only the URL — the fetch tool writing it, or the transcript dropping an
 * old result and naming the file — arrives at the same path.
 */
export function fetchedPagePath(url: string): string {
  return path.join(fetchedDir(), `${createHash('sha1').update(url).digest('hex')}.txt`)
}

/** Whether the page for `url` is on disk, and so can be read back later. */
export function hasFetchedPage(url: string): boolean {
  return existsSync(fetchedPagePath(url))
}

/**
 * Keeps a page's text on disk, best effort. A page too large to hold is not
 * written at all. A page that cannot be written is no worse than before: the
 * turn answers from the read it just did.
 */
export async function savePage(url: string, text: string): Promise<void> {
  if (text.length === 0 || text.length > MAX_PAGE_CHARS) return
  const file = fetchedPagePath(url)
  try {
    ensurePrivateDir(fetchedDir())
    if (existsSync(file)) {
      // Touched, so "least recently fetched" is what eviction means.
      const now = new Date()
      utimesSync(file, now, now)
    } else {
      await writePrivateFile(file, text)
    }
    prunePages()
  } catch (error) {
    logDebug(`could not keep the page at ${url}: ${errorMessage(error)}`)
  }
}

/** The page kept for `url`, or null when there is none. */
export function readPage(url: string): string | null {
  try {
    return readFileSync(fetchedPagePath(url), 'utf8')
  } catch {
    return null
  }
}

/** Drops the least recently fetched pages beyond `keep`. Best effort. */
export function prunePages(keep = KEEP_PAGES): void {
  const dir = fetchedDir()
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
