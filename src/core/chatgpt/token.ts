import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { ChatGptAccount } from '../config/schema.js'
import { errorMessage } from '../../util/errors.js'
import { logDebug } from '../../util/log.js'

/**
 * The OAuth app the Codex CLI signs in with. Using the same public client is what
 * makes a ChatGPT subscription usable here: the grant is the same one Codex holds,
 * and the backend only answers requests carrying a token minted for it.
 */
export const CHATGPT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const CHATGPT_AUTH_BASE = 'https://auth.openai.com'
export const CHATGPT_TOKEN_URL = `${CHATGPT_AUTH_BASE}/oauth/token`
export const CHATGPT_AUTHORIZE_URL = `${CHATGPT_AUTH_BASE}/oauth/authorize`
export const CHATGPT_DEVICE_REDIRECT_URI = `${CHATGPT_AUTH_BASE}/deviceauth/callback`
export const CHATGPT_DEVICE_VERIFICATION_URL = `${CHATGPT_AUTH_BASE}/codex/device`
/** The scopes Codex asks for; the connectors are part of its own grant. */
export const CHATGPT_SCOPES =
  'openid profile email offline_access api.connectors.read api.connectors.invoke'

export interface ChatGptTokenResponse {
  access_token?: string
  refresh_token?: string
  id_token?: string
  expires_in?: number
  error?: string
  error_description?: string
}

/** Where the Codex CLI keeps its own state, honoring `CODEX_HOME` as it does. */
export function codexHome(): string {
  const configured = process.env.CODEX_HOME?.trim()
  return configured ? path.resolve(configured) : path.join(homedir(), '.codex')
}

/** Codex's own grant file. Kept in sync so one sign-in serves both tools. */
export function codexAuthFile(): string {
  return path.join(codexHome(), 'auth.json')
}

/** The claims this needs from a JWT, without verifying the signature — the token came from the issuer. */
export function tokenClaims(token: string | undefined): Record<string, unknown> | null {
  if (!token) return null
  const parts = token.split('.')
  if (parts.length < 2) return null
  try {
    const payload = Buffer.from(parts[1]!, 'base64url').toString('utf8')
    const parsed: unknown = JSON.parse(payload)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

interface OpenAiAuthClaims {
  chatgpt_account_id?: string
  chatgpt_plan_type?: string
}

function openAiAuthClaims(token: string | undefined): OpenAiAuthClaims {
  const claims = tokenClaims(token)
  const auth = claims?.['https://api.openai.com/auth']
  return auth && typeof auth === 'object' ? (auth as OpenAiAuthClaims) : {}
}

function numericDate(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value * 1000 : undefined
}

/**
 * Turns a token response into the stored shape. The ID token is the one that
 * names the account and the plan; a refresh may omit it, so the previous grant
 * supplies what the new answer does not.
 */
export function accountFromTokens(
  tokens: ChatGptTokenResponse,
  previous?: ChatGptAccount,
  now = Date.now(),
): ChatGptAccount {
  const accessToken = tokens.access_token?.trim()
  if (!accessToken) throw new Error('ChatGPT returned no access token.')
  const refreshToken = tokens.refresh_token?.trim() || previous?.refreshToken
  if (!refreshToken) throw new Error('ChatGPT returned no refresh token.')
  const idToken = tokens.id_token?.trim() || previous?.idToken

  const accountClaims = openAiAuthClaims(idToken)
  const accessClaims = openAiAuthClaims(accessToken)
  const accountId =
    accountClaims.chatgpt_account_id ||
    accessClaims.chatgpt_account_id ||
    previous?.accountId
  if (!accountId) throw new Error('ChatGPT returned a token with no account id.')

  const claims = tokenClaims(idToken)
  const email = typeof claims?.email === 'string' ? claims.email : previous?.email
  const planType = accountClaims.chatgpt_plan_type || previous?.planType
  const expiresAt = tokens.expires_in
    ? now + tokens.expires_in * 1000
    : (numericDate(tokenClaims(accessToken)?.exp) ?? previous?.expiresAt)

  return {
    accessToken,
    refreshToken,
    ...(idToken ? { idToken } : {}),
    accountId,
    ...(email ? { email } : {}),
    ...(planType ? { planType } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  }
}

/**
 * A grant Codex already holds on this machine, when one exists. Read-only: an
 * import is a deliberate act (`milo chatgpt login`), so a logout here cannot be
 * undone by the other tool's file.
 */
export function readCodexAccount(): ChatGptAccount | null {
  const file = codexAuthFile()
  if (!existsSync(file)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    const auth = parsed as { auth_mode?: unknown; tokens?: unknown }
    if (auth.auth_mode !== 'chatgpt' || !auth.tokens || typeof auth.tokens !== 'object') return null
    const tokens = auth.tokens as Record<string, unknown>
    const accessToken = typeof tokens.access_token === 'string' ? tokens.access_token : ''
    const refreshToken = typeof tokens.refresh_token === 'string' ? tokens.refresh_token : ''
    const idToken = typeof tokens.id_token === 'string' ? tokens.id_token : undefined
    const storedAccountId = typeof tokens.account_id === 'string' ? tokens.account_id : undefined
    if (!accessToken || !refreshToken) return null
    const accountId =
      openAiAuthClaims(idToken).chatgpt_account_id ||
      openAiAuthClaims(accessToken).chatgpt_account_id ||
      storedAccountId
    if (!accountId) return null
    return accountFromTokens(
      { access_token: accessToken, refresh_token: refreshToken, id_token: idToken },
      { accessToken, refreshToken, accountId, ...(idToken ? { idToken } : {}) },
    )
  } catch (error) {
    logDebug(`could not read ${file}: ${errorMessage(error)}`)
    return null
  }
}

/** The URL a browser is sent to, with the PKCE challenge and the Codex flow's own flags. */
export function buildAuthorizeUrl(input: {
  redirectUri: string
  state: string
  codeChallenge: string
}): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CHATGPT_CLIENT_ID,
    redirect_uri: input.redirectUri,
    code_challenge: input.codeChallenge,
    code_challenge_method: 'S256',
    state: input.state,
    scope: CHATGPT_SCOPES,
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: 'codex_cli_rs',
  })
  return `${CHATGPT_AUTHORIZE_URL}?${params.toString()}`
}

/** The sentence a failed token call carries, without pasting the whole envelope. */
export function tokenFailure(status: number, statusText: string, detail: string): string {
  const trimmed = detail.trim()
  if (!trimmed) return `ChatGPT sign-in failed (${status} ${statusText}).`
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>
      const reason =
        (typeof record.error_description === 'string' && record.error_description) ||
        (typeof record.error === 'string' && record.error) ||
        (typeof record.message === 'string' && record.message)
      if (reason) return `ChatGPT sign-in failed (${status}): ${reason}`
    }
  } catch {
    // Not JSON: the body is the sentence.
  }
  return `ChatGPT sign-in failed (${status} ${statusText}): ${trimmed.slice(0, 500)}`
}
