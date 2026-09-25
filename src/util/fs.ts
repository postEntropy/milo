import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { chmod, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * What Milo's own files are written as.
 *
 * They hold what the person typed — the transcript, the memory, the history log
 * — and on a default umask a file left to itself is 0644, readable by every
 * account on the machine. The history log and `auth.json` have always been
 * written 0600; the transcript and the memory were not, which is the same
 * content protected in one place and exposed in another.
 */
export const PRIVATE_FILE_MODE = 0o600
export const PRIVATE_DIR_MODE = 0o700

/**
 * Writes a file through a temporary neighbour and a rename, so a crash, a kill
 * or a full disk leaves the previous contents in place instead of a half-written
 * file. For something whose whole job is editing source, "the edit failed" beats
 * "the file is now truncated in the middle of a function".
 *
 * The rename replaces the inode, so the target's mode is copied onto the
 * temporary file first — otherwise an edit would quietly drop an executable bit.
 * (`writeFile`'s own `mode` goes through the umask, hence the explicit chmod.)
 * A file that does not exist yet is created with `fallbackMode`.
 */
export async function writeFileAtomic(
  file: string,
  content: string | Buffer,
  fallbackMode = 0o644,
): Promise<void> {
  const mode = await stat(file)
    .then((info) => info.mode & 0o7777)
    .catch(() => null)
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,
  )

  try {
    await writeFile(temp, content, { mode: mode ?? fallbackMode })
    if (mode !== null) await chmod(temp, mode)
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * The same, for a file of Milo's own: created 0600, and tightened if it already
 * exists with something looser — which is just what a file written by an earlier
 * Milo looks like, since `writeFileAtomic` keeps an existing mode on purpose.
 */
export async function writePrivateFile(file: string, content: string): Promise<void> {
  await writeFileAtomic(file, content, PRIVATE_FILE_MODE)
  await chmod(file, PRIVATE_FILE_MODE)
}

/** A directory Milo makes for its own files: 0700, so its names are not a listing. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE })
}
