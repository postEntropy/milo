import { errorMessage } from '../../util/errors.js'
import { logWarn } from '../../util/log.js'
import { ROUTINE_GATEWAY } from '../routines.js'
import type { RecapStore } from './recap.js'
import type { SessionStore } from './types.js'

/**
 * Keeps `~/.milo/sessions/` from growing a file per run.
 *
 * A run begins a new conversation and leaves the old one behind — that is the
 * rule, and it means the directory grows by a file every launch. This is the
 * policy for it: the sessions nothing was ever said in go first and regardless
 * of `keep` (which limits the count, not the debris) — and regardless of any
 * binding, since an empty record holds nothing — then the `keep` most recently
 * updated are kept and the rest go, never one a scope is still bound to (the
 * store protects those itself).
 *
 * Returns how many were removed. Never throws: it runs on the way to a first
 * turn, and a store that cannot be pruned must not take the launch down.
 */
export async function pruneSessions(
  store: SessionStore,
  recaps: RecapStore,
  keep: number,
): Promise<number> {
  const removed = new Set<string>()
  try {
    // The leftovers a run opened but never spoke in, swept whatever `keep` says.
    for (const id of await store.pruneEmpty()) removed.add(id)
  } catch (error) {
    logWarn(`could not prune empty sessions: ${errorMessage(error)}`)
  }
  try {
    // A routine's runs outlive `keep`: their history is bounded by the routine
    // itself, and pruning them here would make the Runs surface lose what it had
    // shown. The store only knows ids, so the exclusion stays here with the rest
    // of the policy.
    const runs = (await store.list())
      .filter((session) => session.scope?.gateway === ROUTINE_GATEWAY)
      .map((session) => session.id)
    for (const id of await store.prune({ keep, protect: runs })) removed.add(id)
  } catch (error) {
    logWarn(`could not prune old sessions: ${errorMessage(error)}`)
  }

  // A recap has no owner but its session, so it goes with it rather than being
  // left for nothing to read.
  for (const id of removed) {
    try {
      await recaps.remove(id)
    } catch (error) {
      logWarn(`could not remove the recap of ${id}: ${errorMessage(error)}`)
    }
  }
  return removed.size
}
