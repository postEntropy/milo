import { errorMessage } from '../../util/errors.js'
import { logWarn } from '../../util/log.js'
import type { RecapStore } from './recap.js'
import type { SessionStore } from './types.js'

/**
 * Keeps `~/.milo/sessions/` from growing a file per run.
 *
 * A run begins a new conversation and leaves the old one behind — that is the
 * rule, and it means the directory grows by a file every launch. This is the
 * policy for it: keep the `keep` most recently updated, and never delete a
 * session a scope is still bound to (the store protects those itself).
 *
 * Returns how many were removed. Never throws: it runs on the way to a first
 * turn, and a store that cannot be pruned must not take the launch down.
 */
export async function pruneSessions(
  store: SessionStore,
  recaps: RecapStore,
  keep: number,
): Promise<number> {
  let removed: string[]
  try {
    removed = await store.prune({ keep })
  } catch (error) {
    logWarn(`could not prune old sessions: ${errorMessage(error)}`)
    return 0
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
  return removed.length
}
