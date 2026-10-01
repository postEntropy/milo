import { readAuth, saveAuth } from '../config/load.js'
import type { GoogleAccount } from '../config/schema.js'
import { refreshAccessToken, type GoogleOutcome, type GoogleTokens } from './oauth.js'

export type TokenSource = () => Promise<GoogleOutcome<GoogleTokens>>

/**
 * The access token for a call, shared by every Google tool of one runtime.
 *
 * A refresh is a round trip, and a turn that reads five things should pay for it
 * once. The cache lives in this closure and not in the module, so it belongs to
 * the registry that made it: a test can make two, and nothing survives a restart
 * except the grant itself, which is on disk.
 */
export function tokenSource(account: GoogleAccount | null): TokenSource {
  let cached: GoogleTokens | null = null

  return async function token(): Promise<GoogleOutcome<GoogleTokens>> {
    if (!account?.refreshToken) {
      return {
        ok: false,
        error: 'Milo is not connected to Google — `milo google connect` has to be run in a terminal first.',
      }
    }
    if (cached && cached.expiresAt > Date.now()) return { ok: true, value: cached }

    const fresh = await refreshAccessToken(account)
    if (!fresh.ok) return fresh
    cached = fresh.value
    // A rotated refresh token has to reach the disk, or the next process starts
    // holding the one Google has already retired.
    if (fresh.value.refreshToken && fresh.value.refreshToken !== account.refreshToken) {
      const auth = readAuth()
      if (auth.google) {
        auth.google = { ...auth.google, refreshToken: fresh.value.refreshToken }
        saveAuth(auth)
      }
    }
    return { ok: true, value: cached }
  }
}
