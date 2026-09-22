import { randomBytes } from 'node:crypto'
import { chmod, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * Writes a file through a temporary neighbour and a rename, so a crash, a kill
 * or a full disk leaves the previous contents in place instead of a half-written
 * file. For something whose whole job is editing source, "the edit failed" beats
 * "the file is now truncated in the middle of a function".
 *
 * The rename replaces the inode, so the target's mode is copied onto the
 * temporary file first — otherwise an edit would quietly drop an executable bit.
 * (`writeFile`'s own `mode` goes through the umask, hence the explicit chmod.)
 */
export async function writeFileAtomic(file: string, content: string): Promise<void> {
  const mode = await stat(file)
    .then((info) => info.mode & 0o7777)
    .catch(() => null)
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,
  )

  try {
    await writeFile(temp, content, { mode: mode ?? 0o644 })
    if (mode !== null) await chmod(temp, mode)
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}
