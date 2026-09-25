import { createHash } from 'node:crypto'
import { chmodSync, existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import process from 'node:process'
import { PRIVATE_FILE_MODE } from '../../util/fs.js'
import { tokenize } from './tokenize.js'

type SqliteModule = typeof import('node:sqlite')

let engine: SqliteModule | null = null

/**
 * Loads the engine, and takes over warning printing on the way in.
 *
 * `node:sqlite` is still experimental on Node 22 and 24 and prints an
 * `ExperimentalWarning` the first time it is touched — which lands on stderr,
 * above the terminal UI. Node's own printer is replaced by one that stays quiet
 * about this single line and re-prints everything else, so a real deprecation
 * still reaches the person.
 *
 * That has to happen *before* the engine is loaded, which is why the module is
 * required here rather than imported at the top. The driver sits behind this one
 * function on purpose: if the warning ever stops being acceptable,
 * `better-sqlite3` is this function and no caller changes.
 *
 * Shared by the two stores that use it — the facts in `sqlite.ts` and the turns
 * in `turns.ts` — because the warning is a property of the process, not of a
 * database, and a second copy of this would fire it twice.
 */
export function loadSqlite(): SqliteModule {
  if (engine) return engine

  process.removeAllListeners('warning')
  process.on('warning', (warning) => {
    if (warning.name === 'ExperimentalWarning' && /sqlite/i.test(warning.message)) return
    console.error(`${warning.name}: ${warning.message}`)
  })

  engine = createRequire(import.meta.url)('node:sqlite') as SqliteModule
  return engine
}

/**
 * A person's sentence is not an FTS5 query — but by this point it is: `tokenize`
 * splits on everything that is not a letter or a digit, so what arrives here is
 * plain words, and the `OR` between them means none of them is ever in the
 * infix position where `NEAR` or `NOT` would become an operator. Verified against
 * the engine rather than assumed: `alpha NEAR omega`, `omega NOT alpha` and a
 * query made only of `not` all behave as ordinary terms.
 *
 * The words are OR-ed, so the answer stays "anything sharing a word". An empty
 * query is no query at all.
 */
export function toMatchQuery(query: string): string | null {
  const tokens = [...tokenize(query)]
  if (tokens.length === 0) return null
  return tokens.join(' OR ')
}

/** Case and spacing are not a difference: the same text twice is one row. */
export function hashOf(text: string): string {
  return createHash('sha1').update(text.trim().replace(/\s+/g, ' ').toLowerCase()).digest('hex')
}

/** A database and the write-ahead log beside it: what the file costs, not what is live. */
export function sizeOnDisk(location: string): number {
  return ['', '-wal'].reduce((sum, suffix) => {
    try {
      return sum + statSync(`${location}${suffix}`).size
    } catch {
      return sum
    }
  }, 0)
}

/**
 * Tightens a database and its siblings to owner-only.
 *
 * The directory is 0700, which already covers the `-wal` and `-shm` files; the
 * database is tightened too, because a file left to the umask is readable by
 * every account on the machine.
 */
export function tightenDb(location: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${location}${suffix}`
    if (existsSync(file)) chmodSync(file, PRIVATE_FILE_MODE)
  }
}
