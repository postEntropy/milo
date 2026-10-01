/**
 * The Google connection: consent in a browser, the code back on a loopback port,
 * and a refresh token written down so nobody has to do it twice.
 *
 * Hand-rolled over `fetch` and `node:http` deliberately: the official client is a
 * dependency tree big enough to notice, for a flow that is fifty lines of a
 * published protocol (`oauth2/native-app` — loopback + PKCE).
 */
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { GoogleAccount } from '../config/schema.js'
import { errorMessage } from '../../util/errors.js'

export const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
export const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

/**
 * The narrowest scopes that still do the job. `gmail.metadata` is narrower and
 * cannot take a `q`; `drive.metadata.readonly` would list files without reading
 * one. Nothing here writes, and no write scope is ever asked for.
 */
export const GMAIL_READONLY = 'https://www.googleapis.com/auth/gmail.readonly'
export const DRIVE_READONLY = 'https://www.googleapis.com/auth/drive.readonly'
export const GOOGLE_SCOPES = [GMAIL_READONLY, DRIVE_READONLY]

export interface GoogleTokens {
  accessToken: string
  expiresAt: number
  refreshToken?: string
}

/**
 * What a call to Google came back with. A discriminated outcome rather than a
 * value or a throw, because every failure here has a different thing for the
 * person to do — reconnect, wait, or fix the Cloud project.
 */
export type GoogleOutcome<T> = { ok: true; value: T } | { ok: false; error: string }

/** The code challenge for this verifier: S256, as the native-app flow requires. */
export function challengeFor(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

export function newVerifier(): string {
  return randomBytes(32).toString('base64url')
}

/** Where the person is sent to say yes — the state parameter is not, the PKCE verifier is. */
export function consentUrl(request: { clientId: string; redirectUri: string; verifier: string }): string {
  const url = new URL(AUTH_ENDPOINT)
  url.searchParams.set('client_id', request.clientId)
  url.searchParams.set('redirect_uri', request.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', GOOGLE_SCOPES.join(' '))
  url.searchParams.set('code_challenge', challengeFor(request.verifier))
  url.searchParams.set('code_challenge_method', 'S256')
  // `offline` is what asks for a refresh token at all, and `consent` is what makes
  // Google hand one back *again* when someone reconnects — without it a reconnect
  // returns no refresh token and Milo would keep the old one, which is the one
  // being replaced.
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')
  return url.toString()
}

const DONE_PAGE = `<!doctype html><meta charset="utf-8"><title>Milo</title>
<body style="font-family: system-ui; padding: 3rem; max-width: 34rem">
<h1>Connected</h1><p>Milo has the grant it asked for. You can close this tab and go back to the terminal.</p>`

const FAILED_PAGE = `<!doctype html><meta charset="utf-8"><title>Milo</title>
<body style="font-family: system-ui; padding: 3rem; max-width: 34rem">
<h1>Not connected</h1><p>Google did not return a grant. The terminal has the reason.</p>`

/**
 * Opens a port on loopback and waits for the browser to come back with the code.
 *
 * The port is asked for, not chosen: a fixed one is a port that can be taken, and
 * Google's loopback flow allows any.
 */
export async function awaitCode(request: {
  clientId: string
  verifier: string
  onUrl(url: string): void
  timeoutMs?: number
}): Promise<GoogleOutcome<{ code: string; redirectUri: string }>> {
  const timeoutMs = request.timeoutMs ?? 5 * 60_000
  const server = createServer()

  let port: number
  try {
    port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        resolve(typeof address === 'object' && address !== null ? address.port : 0)
      })
    })
  } catch (error) {
    return { ok: false, error: `could not open the port Google answers on: ${errorMessage(error)}` }
  }

  const redirectUri = `http://127.0.0.1:${port}/`

  try {
    const answer = await new Promise<GoogleOutcome<string>>((resolve) => {
      const finish = (outcome: GoogleOutcome<string>): void => {
        clearTimeout(timer)
        resolve(outcome)
      }
      const timer = setTimeout(
        () => finish({ ok: false, error: `nobody answered the consent page within ${Math.round(timeoutMs / 1000)}s` }),
        timeoutMs,
      )
      server.on('request', (incoming, response) => {
        const url = new URL(incoming.url ?? '/', redirectUri)
        const code = url.searchParams.get('code')
        const refused = url.searchParams.get('error')
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(code ? DONE_PAGE : FAILED_PAGE)
        if (code) finish({ ok: true, value: code })
        else finish({ ok: false, error: `Google refused the consent: ${refused ?? 'no code came back'}` })
      })
      request.onUrl(consentUrl({ clientId: request.clientId, redirectUri, verifier: request.verifier }))
    })
    if (!answer.ok) return answer
    return { ok: true, value: { code: answer.value, redirectUri } }
  } finally {
    server.close()
  }
}

/** The one place a token request is made, so the shape of the body lives once. */
async function tokenRequest(body: Record<string, string>): Promise<GoogleOutcome<GoogleTokens>> {
  let response: Response
  try {
    response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    })
  } catch (error) {
    return { ok: false, error: `could not reach Google: ${errorMessage(error)}` }
  }

  const text = await response.text()
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(text) as Record<string, unknown>
  } catch {
    return { ok: false, error: `Google answered something that is not a token: ${text.slice(0, 200)}` }
  }

  if (!response.ok) return { ok: false, error: tokenFailure(payload, response.status) }

  const accessToken = typeof payload.access_token === 'string' ? payload.access_token : ''
  if (!accessToken) return { ok: false, error: 'Google answered without an access token.' }
  const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : 3600
  return {
    ok: true,
    value: {
      accessToken,
      // A minute early, so a token is never handed out on the edge of its life.
      expiresAt: Date.now() + (expiresIn - 60) * 1000,
      ...(typeof payload.refresh_token === 'string' ? { refreshToken: payload.refresh_token } : {}),
    },
  }
}

/**
 * Why a token request was refused, in terms of what to do about it.
 *
 * `invalid_grant` is the one that matters: it is what a revoked grant answers, and
 * also what a grant that died of old age answers — including the seven days an
 * OAuth app that is still in "Testing" gives its refresh tokens. Reconnecting
 * fixes the symptom; publishing the app is what fixes the cause, and saying only
 * "reconnect" would have someone doing it every week without knowing why.
 */
function tokenFailure(payload: Record<string, unknown>, status: number): string {
  const code = typeof payload.error === 'string' ? payload.error : ''
  const detail = typeof payload.error_description === 'string' ? payload.error_description : ''
  const where = 'https://console.cloud.google.com/apis/credentials'

  if (code === 'invalid_grant') {
    return (
      'the Google grant is gone (revoked, unused for six months — or, if the Cloud app is still in "Testing", ' +
      `expired after seven days). Run \`milo google connect\` again; to stop it happening weekly, publish the app ` +
      `in the OAuth consent screen at ${where}. ` +
      (detail ? `Google said: ${detail}` : '')
    ).trim()
  }
  if (code === 'invalid_client') {
    return `Google did not recognise this client id/secret (${detail || 'invalid_client'}) — check them at ${where}`
  }
  return `Google refused the token request (HTTP ${status}${code ? `, ${code}` : ''}${detail ? `: ${detail}` : ''})`
}

/** Swaps the code for the first pair of tokens. */
export async function exchangeCode(request: {
  account: GoogleAccount
  code: string
  redirectUri: string
  verifier: string
}): Promise<GoogleOutcome<GoogleTokens>> {
  return tokenRequest({
    grant_type: 'authorization_code',
    code: request.code,
    redirect_uri: request.redirectUri,
    client_id: request.account.clientId,
    client_secret: request.account.clientSecret,
    code_verifier: request.verifier,
  })
}

/** A fresh access token from the grant on disk. */
export async function refreshAccessToken(account: GoogleAccount): Promise<GoogleOutcome<GoogleTokens>> {
  if (!account.refreshToken) {
    return { ok: false, error: 'not connected to Google — run `milo google connect`' }
  }
  return tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: account.refreshToken,
    client_id: account.clientId,
    client_secret: account.clientSecret,
  })
}

/**
 * A Google API call, with the two failures every one of them can have already
 * turned into what to do about it.
 *
 * It lives here rather than in each service so the sentence a person reads when
 * the grant has expired is written once — the same 401 answers Gmail and Drive,
 * and only the URL differs between them.
 */
async function request(tokens: GoogleTokens, url: URL): Promise<GoogleOutcome<Response>> {
  let response: Response
  try {
    response = await fetch(url, { headers: { authorization: `Bearer ${tokens.accessToken}` } })
  } catch (error) {
    return { ok: false, error: `could not reach Google: ${errorMessage(error)}` }
  }

  if (response.status === 401) {
    return {
      ok: false,
      error: 'Google refused the access token — run `milo google connect` again.',
    }
  }
  if (!response.ok) {
    const body = await response.text()
    return { ok: false, error: `Google refused the request (HTTP ${response.status}): ${body.slice(0, 200)}` }
  }
  return { ok: true, value: response }
}

/** The JSON of a call, or why it could not be read. */
export async function authorizedJson(tokens: GoogleTokens, url: URL): Promise<GoogleOutcome<unknown>> {
  const response = await request(tokens, url)
  if (!response.ok) return response
  const text = await response.value.text()
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    return { ok: false, error: `Google answered something that is not JSON: ${text.slice(0, 200)}` }
  }
}

/** The body of a call as text — a file's bytes, an exported document. */
export async function authorizedText(tokens: GoogleTokens, url: URL): Promise<GoogleOutcome<string>> {
  const response = await request(tokens, url)
  if (!response.ok) return response
  return { ok: true, value: await response.value.text() }
}
