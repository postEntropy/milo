import { existsSync, readFileSync } from 'node:fs'
import { MILO_HOME, inputHistoryFile } from '../../core/config/paths.js'
import { errorMessage } from '../../util/errors.js'
import { ensurePrivateDir, writePrivateFile } from '../../util/fs.js'
import { logWarn } from '../../util/log.js'

/**
 * The lines sent from the CLI chat, oldest first — what the arrow keys walk
 * back through. It lives on disk because reaching for yesterday's command
 * should not depend on the terminal still being open, and it is the *input*
 * line, not the turn log the model can search: what was typed, to be edited and
 * sent again, rather than what was answered.
 *
 * A file that cannot be read is dropped rather than raised: a broken history is
 * no reason to lose the chat in front of it.
 */
export function readInputHistory(): string[] {
  const file = inputHistoryFile()
  if (!existsSync(file)) return []
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (entry): entry is string => typeof entry === 'string' && entry.trim() !== '',
    )
  } catch (error) {
    logWarn(`dropping unreadable input history ${file}: ${errorMessage(error)}`)
    return []
  }
}

/**
 * Writes the whole list down. Never rejects: a line that was sent is sent, and
 * a history that could not be written is logged and left for the next one.
 */
export async function saveInputHistory(entries: string[]): Promise<void> {
  try {
    ensurePrivateDir(MILO_HOME)
    await writePrivateFile(inputHistoryFile(), `${JSON.stringify(entries, null, 2)}\n`)
  } catch (error) {
    logWarn(`could not write ${inputHistoryFile()}: ${errorMessage(error)}`)
  }
}
