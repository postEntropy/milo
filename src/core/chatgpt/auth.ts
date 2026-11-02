import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import path from 'node:path'
import { readAuth, readConfig, saveAuth, saveConfig } from '../config/load.js'
import { findPreset } from '../config/presets.js'
import type { ChatGptAccount } from '../config/schema.js'
import { errorMessage } from '../../util/errors.js'
import { logDebug } from '../../util/log.js'
import { chatGptPlanName } from './plan.js'
import {
  CHATGPT_CLIENT_ID,
  CHATGPT_DEVICE_REDIRECT_URI,
  CHATGPT_DEVICE_VERIFICATION_URL,
  CHATGPT_TOKEN_URL,
  accountFromTokens,
  buildAuthorizeUrl,
  codexAuthFile,
  readCodexAccount,
  tokenFailure,
  type ChatGptTokenResponse,
} from './token.js'

export { chatGptPlanName } from './plan.js'

/** The ports the Codex OAuth app allows for a loopback callback. */
const CALLBACK_PORTS = [1455, 1457] as const
const CALLBACK_TIMEOUT_MS = 5 * 60_000
const DEVICE_TIMEOUT_MS = 15 * 60_000
const REFRESH_MARGIN_MS = 60_000

export interface ChatGptStatus {
  signedIn: boolean
  email?: string
  planType?: string
  /** The plan as the surfaces show it: the claim's value with its first letter raised. */
  planName?: string
  expiresAt?: number
  /** A Codex login on this machine that `milo chatgpt login` can import. */
  codexLogin?: boolean
}

export interface ChatGptLogin {
  url: string
  wait: Promise<ChatGptAccount>
  cancel: () => void
}

export interface ChatGptDeviceLogin {
  verificationUrl: string
  userCode: string
  wait: Promise<ChatGptAccount>
  cancel: () => void
}

/** The account this install holds, or nothing. Read per call, so a login lands without a restart. */
export function loadChatGptAccount(): ChatGptAccount | null {
  return readAuth().chatgpt ?? null
}

export function chatGptStatus(): ChatGptStatus {
  const account = loadChatGptAccount()
  if (account) {
    const planName = chatGptPlanName(account.planType)
    return {
      signedIn: true,
      ...(account.email ? { email: account.email } : {}),
      ...(account.planType ? { planType: account.planType } : {}),
      ...(planName ? { planName } : {}),
      ...(account.expiresAt ? { expiresAt: account.expiresAt } : {}),
    }
  }
  return { signedIn: false, codexLogin: Boolean(readCodexAccount()) }
}

/**
 * Stores a grant and keeps Codex's own file in step, so one sign-in serves both
 * tools. A Codex login for another account is left alone: switching it would log
 * that tool out of the account its person chose.
 */
export function saveChatGptAccount(account: ChatGptAccount): void {
  const auth = readAuth()
  auth.chatgpt = account
  saveAuth(auth)
  mirrorToCodex(account)
}

export function forgetChatGptAccount(): void {
  const auth = readAuth()
  delete auth.chatgpt
  saveAuth(auth)
}

/**
 * Makes the ChatGPT preset an entry the install can switch to, without moving
 * the active provider. A sign-in is the consent; a person who has just signed
 * in should find it in `/provider` and the model picker, not have to add it by
 * hand on a second screen. Idempotent, and silent when the config cannot be
 * read — a status read must not fail because the file is being edited.
 */
export function enableChatGptProvider(): void {
  const preset = findPreset('chatgpt')
  if (!preset) return
  try {
    const config = readConfig()
    if (!config || config.providers.chatgpt) return
    saveConfig({
      ...config,
      providers: {
        ...config.providers,
        chatgpt: {
          name: preset.name,
          baseURL: preset.baseURL,
          wire: preset.wire,
          ...(preset.oauth ? { oauth: preset.oauth } : {}),
        },
      },
    })
  } catch (error) {
    logDebug(`could not add the ChatGPT preset to the config: ${errorMessage(error)}`)
  }
}

function mirrorToCodex(account: ChatGptAccount): void {
  const file = codexAuthFile()
  if (!existsSync(path.dirname(file))) return
  const existing = readCodexAccount()
  if (existing && existing.accountId !== account.accountId) return
  const payload = {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      ...(account.idToken ? { id_token: account.idToken } : {}),
      access_token: account.accessToken,
      refresh_token: account.refreshToken,
      account_id: account.accountId,
    },
    last_refresh: new Date().toISOString(),
  }
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
    chmodSync(file, 0o600)
  } catch (error) {
    logDebug(`could not write ${file}: ${errorMessage(error)}`)
  }
}

/**
 * A valid access token, refreshed when it is at or near its expiry. Coalesced:
 * several sessions preparing a turn at once share one refresh, because rotating
 * a refresh token twice with the same value is how a grant is lost.
 */
let refreshing: Promise<ChatGptAccount> | null = null

export async function chatGptAccessToken(options: { force?: boolean } = {}): Promise<{
  token: string
  accountId: string
}> {
  const account = loadChatGptAccount()
  if (!account) throw new Error('ChatGPT is not signed in. Run `milo chatgpt login`.')
  const fresh =
    options.force === true || (account.expiresAt !== undefined && account.expiresAt - Date.now() <= REFRESH_MARGIN_MS)
  if (!fresh) return { token: account.accessToken, accountId: account.accountId }
  const next = await refreshChatGpt(account)
  return { token: next.accessToken, accountId: next.accountId }
}

export async function refreshChatGpt(account: ChatGptAccount): Promise<ChatGptAccount> {
  if (refreshing) return refreshing
  refreshing = doRefresh(account).finally(() => {
    refreshing = null
  })
  return refreshing
}

async function doRefresh(account: ChatGptAccount): Promise<ChatGptAccount> {
  const response = await fetch(CHATGPT_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: account.refreshToken,
      client_id: CHATGPT_CLIENT_ID,
    }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(tokenFailure(response.status, response.statusText, detail))
  }
  const tokens = (await response.json()) as ChatGptTokenResponse
  const next = accountFromTokens(tokens, account)
  saveChatGptAccount(next)
  return next
}

/**
 * Imports a grant Codex already holds on this machine, refreshing it so an old
 * access token is not carried over. Null when there is none.
 */
export async function importCodexLogin(): Promise<ChatGptAccount | null> {
  const codex = readCodexAccount()
  if (!codex) return null
  const account = await refreshChatGpt(codex)
  saveChatGptAccount(account)
  return account
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(64).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/**
 * Starts the browser sign-in on the loopback callback the Codex app registers.
 * The server is up before this resolves, so a browser opened with `url` finds it.
 */
export async function beginChatGptBrowserLogin(
  options: {
    timeoutMs?: number
    /** Swapped in tests, so a login does not write this machine's real grant. */
    save?: (account: ChatGptAccount) => void
    /** The ports to try; tests pass `[0]` for whatever the OS hands out. */
    ports?: readonly number[]
  } = {},
): Promise<ChatGptLogin> {
  const { verifier, challenge } = pkce()
  const state = randomBytes(32).toString('base64url')
  const { server, port } = await listen(options.ports ?? CALLBACK_PORTS)
  const redirectUri = `http://127.0.0.1:${port}/auth/callback`
  const url = buildAuthorizeUrl({ redirectUri, state, codeChallenge: challenge })
  const persist = options.save ?? saveChatGptAccount

  let settle!: { resolve: (account: ChatGptAccount) => void; reject: (error: Error) => void }
  const wait = new Promise<ChatGptAccount>((resolve, reject) => {
    settle = { resolve, reject }
  })
  // A caller that only watches the surface should not turn a cancel into an
  // unhandled rejection; the promise stays awaitable all the same.
  void wait.catch(() => {})

  let done = false
  const finish = (error: Error | null, account?: ChatGptAccount): void => {
    if (done) return
    done = true
    clearTimeout(timer)
    server.close()
    if (error) settle.reject(error)
    else settle.resolve(account!)
  }

  const timer = setTimeout(
    () => finish(new Error('ChatGPT sign-in timed out. Run `milo chatgpt login` again.')),
    options.timeoutMs ?? CALLBACK_TIMEOUT_MS,
  )
  timer.unref?.()

  server.on('request', (request, response) => {
    void (async () => {
      const parsed = new URL(request.url ?? '/', redirectUri)
      if (request.method !== 'GET' || parsed.pathname !== '/auth/callback') {
        respond(response, 404, 'Not found')
        return
      }
      const denial = parsed.searchParams.get('error')
      if (denial) {
        const description = parsed.searchParams.get('error_description') ?? denial
        respond(response, 400, page('Sign-in failed.', description))
        finish(new Error(`ChatGPT sign-in was denied: ${description}`))
        return
      }
      if (parsed.searchParams.get('state') !== state) {
        respond(response, 400, page('Sign-in failed.', 'The sign-in answer did not match this request.'))
        finish(new Error('ChatGPT sign-in failed: the callback state did not match. Run `milo chatgpt login` again.'))
        return
      }
      const code = parsed.searchParams.get('code')
      if (!code) {
        respond(response, 400, page('Sign-in failed.', 'The callback carried no authorization code.'))
        finish(new Error('ChatGPT sign-in failed: the callback carried no code.'))
        return
      }
      try {
        const tokens = await exchangeCode({ code, codeVerifier: verifier, redirectUri })
        const account = accountFromTokens(tokens)
        persist(account)
        respond(response, 200, page('Sign-in complete.', 'You may close this window and return to Milo.'))
        finish(null, account)
      } catch (error) {
        respond(response, 500, page('Sign-in failed.', errorMessage(error)))
        finish(new Error(errorMessage(error)))
      }
    })().catch((error: unknown) => {
      respond(response, 500, page('Sign-in failed.', errorMessage(error)))
      finish(new Error(errorMessage(error)))
    })
  })

  return {
    url,
    wait,
    cancel: () => finish(new Error('ChatGPT sign-in was cancelled.')),
  }
}

/**
 * The device-code sign-in, for a surface with no browser on the same loopback:
 * a phone, a chat gateway, or a terminal over SSH. The person enters the code
 * on another device and this side polls until the grant lands.
 */
export async function beginChatGptDeviceLogin(): Promise<ChatGptDeviceLogin> {
  const user = await requestDeviceCode()
  const controller = new AbortController()
  let cancelled = false
  let settle!: { resolve: (account: ChatGptAccount) => void; reject: (error: Error) => void }
  const wait = new Promise<ChatGptAccount>((resolve, reject) => {
    settle = { resolve, reject }
  })
  void wait.catch(() => {})

  void (async () => {
    try {
      const code = await pollDeviceCode(user, controller.signal)
      const tokens = await exchangeCode({
        code: code.authorization_code,
        codeVerifier: code.code_verifier,
        redirectUri: CHATGPT_DEVICE_REDIRECT_URI,
        signal: controller.signal,
      })
      const account = accountFromTokens(tokens)
      saveChatGptAccount(account)
      if (!cancelled) settle.resolve(account)
    } catch (error) {
      if (!cancelled) settle.reject(new Error(errorMessage(error)))
    }
  })()

  return {
    verificationUrl: CHATGPT_DEVICE_VERIFICATION_URL,
    userCode: user.userCode,
    wait,
    cancel: () => {
      cancelled = true
      controller.abort()
      settle.reject(new Error('ChatGPT sign-in was cancelled.'))
    },
  }
}

interface DeviceCodeRequest {
  deviceAuthId: string
  userCode: string
  interval: number
}

interface DeviceCodeSuccess {
  authorization_code: string
  code_challenge: string
  code_verifier: string
}

async function requestDeviceCode(): Promise<DeviceCodeRequest> {
  const response = await fetch(`${CHATGPT_AUTH_BASE_API}/deviceauth/usercode`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ client_id: CHATGPT_CLIENT_ID }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(tokenFailure(response.status, response.statusText, detail))
  }
  const body = (await response.json()) as {
    device_auth_id?: unknown
    user_code?: unknown
    usercode?: unknown
    interval?: unknown
  }
  const deviceAuthId = typeof body.device_auth_id === 'string' ? body.device_auth_id : ''
  const userCode =
    typeof body.user_code === 'string' ? body.user_code : typeof body.usercode === 'string' ? body.usercode : ''
  if (!deviceAuthId || !userCode) throw new Error('ChatGPT returned an incomplete device code.')
  const seconds = typeof body.interval === 'string' ? Number(body.interval) : body.interval
  return {
    deviceAuthId,
    userCode,
    interval: typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 30) : 5,
  }
}

async function pollDeviceCode(
  user: DeviceCodeRequest,
  signal: AbortSignal,
): Promise<DeviceCodeSuccess> {
  const deadline = Date.now() + DEVICE_TIMEOUT_MS
  while (Date.now() < deadline) {
    const response = await fetch(`${CHATGPT_AUTH_BASE_API}/deviceauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ device_auth_id: user.deviceAuthId, user_code: user.userCode }),
      signal: combineSignal(signal, 30_000),
    })
    if (response.ok) {
      return (await response.json()) as DeviceCodeSuccess
    }
    // 403 and 404 are the endpoints saying "not yet"; anything else is a real failure.
    if (response.status !== 403 && response.status !== 404) {
      const detail = await response.text().catch(() => '')
      throw new Error(tokenFailure(response.status, response.statusText, detail))
    }
    await sleep(user.interval * 1000, signal)
  }
  throw new Error('ChatGPT sign-in timed out. Run `milo chatgpt login --device` again.')
}

const CHATGPT_AUTH_BASE_API = 'https://auth.openai.com/api/accounts'

async function exchangeCode(input: {
  code: string
  codeVerifier: string
  redirectUri: string
  signal?: AbortSignal
}): Promise<ChatGptTokenResponse> {
  const response = await fetch(CHATGPT_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: CHATGPT_CLIENT_ID,
      code_verifier: input.codeVerifier,
    }),
    signal: input.signal ?? AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(tokenFailure(response.status, response.statusText, detail))
  }
  return (await response.json()) as ChatGptTokenResponse
}

async function listen(ports: readonly number[]): Promise<{ server: Server; port: number }> {
  let lastError: unknown
  for (const port of ports) {
    const server = createServer()
    try {
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error): void => {
          server.off('listening', ready)
          reject(error)
        }
        const ready = (): void => {
          server.off('error', failed)
          resolve()
        }
        server.once('error', failed)
        server.once('listening', ready)
        server.listen(port, '127.0.0.1')
      })
      const address = server.address()
      return { server, port: typeof address === 'object' && address ? address.port : port }
    } catch (error) {
      lastError = error
      server.close()
    }
  }
  throw new Error(
    `Could not open the ChatGPT sign-in callback on port ${CALLBACK_PORTS.join(' or ')}: ${errorMessage(lastError)}`,
  )
}

function page(title: string, detail: string): string {
  const escaped = detail.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><p>${escaped}</p></body></html>`
}

function respond(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
  response.end(body)
}

function combineSignal(signal: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('ChatGPT sign-in was cancelled.'))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', aborted)
      resolve()
    }, ms)
    const aborted = (): void => {
      clearTimeout(timer)
      reject(new Error('ChatGPT sign-in was cancelled.'))
    }
    signal.addEventListener('abort', aborted, { once: true })
  })
}

