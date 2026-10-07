/**
 * The connect flow, from a client id and secret to a grant on disk.
 *
 * It lives here rather than in the command because two surfaces drive it — the
 * `milo google connect` verb and the setup screen — and they differ only in how
 * they ask and how they show the wait. The protocol is in `oauth.ts`; what this
 * adds is the order, the one place the grant is written, and the wording of the
 * failures that are the flow's own (a missing refresh token, an address Gmail
 * would not name).
 */
import { readAuth, readConfig, saveAuth, saveConfig } from '../config/load.js'
import type { GoogleAccount } from '../config/schema.js'
import { profile } from './gmail.js'
import { awaitCode, exchangeCode, newVerifier, type GoogleOutcome } from './oauth.js'
import type { GoogleAccess } from './tiers.js'

export interface ConnectResult {
  account: GoogleAccount
  /** True when the config had the tools off and the flow turned them on. */
  enabledInConfig: boolean
  /** Set when Gmail would not name the address: the grant works, the address is unknown. */
  warning?: string
}

export async function connectGoogle(request: {
  clientId: string
  clientSecret: string
  /**
   * The level the person chose. Required and never defaulted: the consent is the
   * one moment the grant is decided, and a flow that picked a level on its own
   * would be deciding something that is not its to decide.
   */
  access: GoogleAccess
  /**
   * Where the person is sent. The caller prints it, because a terminal and a
   * screen show an address differently — one wraps it in a clickable link.
   */
  onUrl(url: string): void
  timeoutMs?: number
}): Promise<GoogleOutcome<ConnectResult>> {
  const verifier = newVerifier()
  const answered = await awaitCode({
    clientId: request.clientId,
    verifier,
    access: request.access,
    onUrl: request.onUrl,
    ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {}),
  })
  if (!answered.ok) return answered

  const tokens = await exchangeCode({
    account: { clientId: request.clientId, clientSecret: request.clientSecret },
    code: answered.value.code,
    redirectUri: answered.value.redirectUri,
    verifier,
  })
  if (!tokens.ok) return tokens

  if (!tokens.value.refreshToken) {
    // Worth its own words: without it nothing works after this process ends, and
    // the fix is in the Cloud project, not here.
    return {
      ok: false,
      error:
        'Google did not return a refresh token, so the connection would die with this command. ' +
        "Remove Milo's access at https://myaccount.google.com/permissions and connect again.",
    }
  }

  // The address is read back from Google, so the connection is proven rather than
  // assumed — and `status` can say who it is without spending a call.
  const who = await profile(tokens.value)

  const account: GoogleAccount = {
    clientId: request.clientId,
    clientSecret: request.clientSecret,
    refreshToken: tokens.value.refreshToken,
    ...(who.ok ? { email: who.value } : {}),
    connectedAt: new Date().toISOString(),
    access: request.access,
  }
  const auth = readAuth()
  auth.google = account
  saveAuth(auth)

  // Wanted is what registers the tools, so connecting without turning it on would
  // leave a grant nothing could use.
  const config = readConfig()
  let enabledInConfig = false
  if (config && !config.google.enabled) {
    config.google = { enabled: true }
    saveConfig(config)
    enabledInConfig = true
  }

  return {
    ok: true,
    value: {
      account,
      enabledInConfig,
      ...(who.ok ? {} : { warning: `Connected, but Gmail would not say which address: ${who.error}` }),
    },
  }
}
