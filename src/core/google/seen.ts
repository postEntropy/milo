/**
 * When the inbox was last looked at — the watermark the sidebar's badge counts
 * "new" mail from.
 *
 * Milo's own state, kept in `mail-seen.json` beside the labels: a view over the
 * mail, never written back to Gmail. Opening the inbox records the moment here,
 * so the badge counts only the unread that arrived after the person last looked,
 * and clears on a visit without any message being marked read on the account.
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { mailSeenFile } from '../config/paths.js'
import { writePrivateFile } from '../../util/fs.js'

interface SeenStore {
  seenAt: number
}

/**
 * The moment the inbox was last opened, or zero when it never was — which reads
 * as "everything unread is new", the honest answer on a first run. A file that
 * cannot be parsed or read is not swallowed: it is a defect worth surfacing.
 */
export function seenAt(): number {
  try {
    const value: unknown = JSON.parse(readFileSync(mailSeenFile(), 'utf8'))
    const at = value && typeof value === 'object' ? (value as { seenAt?: unknown }).seenAt : undefined
    return typeof at === 'number' && Number.isFinite(at) ? at : 0
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
}

/** Records that the inbox was looked at now, and answers with the moment kept. */
export async function markSeen(at = Date.now()): Promise<{ seenAt: number }> {
  const file = mailSeenFile()
  mkdirSync(dirname(file), { recursive: true })
  const store: SeenStore = { seenAt: at }
  await writePrivateFile(file, `${JSON.stringify(store, null, 2)}\n`)
  return store
}
