/**
 * What the Google connection is, said once.
 *
 * Three surfaces have to answer it — `milo google status`, the setup screen and
 * the web panel — and each answers in its own words. This is the part they share,
 * so a fourth surface cannot invent a fourth answer.
 */
import type { Auth, Config } from '../config/schema.js'

export type GoogleState =
  | { kind: 'off' }
  /** Wanted in the config, but no account has been granted. */
  | { kind: 'wanted' }
  | { kind: 'connected'; email?: string; connectedAt?: string; enabled: boolean }

export function googleState(config: Config | null, auth: Auth): GoogleState {
  const account = auth.google
  const enabled = config?.google.enabled ?? false
  // A grant is the refresh token: the client id and secret alone are an app
  // identity, not a connection, and nothing can be read with them.
  if (!account?.refreshToken) return enabled ? { kind: 'wanted' } : { kind: 'off' }
  return {
    kind: 'connected',
    ...(account.email ? { email: account.email } : {}),
    ...(account.connectedAt ? { connectedAt: account.connectedAt } : {}),
    enabled,
  }
}
