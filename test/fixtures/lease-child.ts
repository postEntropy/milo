import { FileSessionStore } from '../../src/core/sessions/file-store.js'

/**
 * One turn's worth of the lease protocol, run as its own process by
 * `session-store.test.ts`. Two of these at once are two Milos on one session —
 * which a test holding two store instances can only imitate, since the lock
 * that matters is the one on the filesystem.
 *
 * Usage: <dir> <session id> <label>
 */
const [dir, id, label] = process.argv.slice(2) as [string, string, string]

// A watchdog, so a bug here fails the parent instead of hanging it.
const watchdog = setTimeout(() => process.exit(3), 20_000)

const store = new FileSessionStore({ dir })
const lease = await store.acquire(id)
// Held long enough that two of these overlap unless something serializes them.
await new Promise((resolve) => setTimeout(resolve, 300))
const latest = (await store.load(id))!
latest.messages.push({ role: 'user', content: [{ type: 'text', text: label }] })
await store.save(latest, latest.version)
await lease.release()

clearTimeout(watchdog)
