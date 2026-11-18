import { updateAuth } from '../config/load.js'
import type { GoogleAccount } from '../config/schema.js'
import { refreshAccessToken, type GoogleOutcome, type GoogleTokens } from './oauth.js'

export type TokenSource = () => Promise<GoogleOutcome<GoogleTokens>>

/**
 * The access token for a call, shared by every Google tool of one runtime.
 *
 * A refresh is a round trip, and a turn that reads five things should pay for it
 * once. Concurrent callers share one in-flight refresh, and a rotated refresh
 * token updates both memory and disk under lock.
 */
export function tokenSource(account: GoogleAccount | null): TokenSource {
  let cached: GoogleTokens | null = null
  let inflight: Promise<GoogleOutcome<GoogleTokens>> | null = null

  const refresh = async (): Promise<GoogleOutcome<GoogleTokens>> => {
    if (!account?.refreshToken) {
      return {
        ok: false,
        error: 'Milo is not connected to Google — `milo google connect` has to be run in a terminal first.',
      }
    }
    const fresh = await refreshAccessToken(account)
    if (!fresh.ok) return fresh
    cached = fresh.value
    // A rotated refresh token has to update memory as well as disk, so the next
    // refresh in this process does not present the retired token again.
    if (fresh.value.refreshToken && fresh.value.refreshToken !== account.refreshToken) {
      account.refreshToken = fresh.value.refreshToken
      await updateAuth((auth) => {
        if (auth.google) {
          auth.google = { ...auth.google, refreshToken: fresh.value.refreshToken! }
        }
      })
    }
    return { ok: true, value: cached }
  }

  return async function token(): Promise<GoogleOutcome<GoogleTokens>> {
    if (!account?.refreshToken) {
      return {
        ok: false,
        error: 'Milo is not connected to Google — `milo google connect` has to be run in a terminal first.',
      }
    }
    if (cached && cached.expiresAt > Date.now()) return { ok: true, value: cached }
    if (!inflight) {
      inflight = refresh().finally(() => {
        inflight = null
      })
    }
    return inflight
  }
}
