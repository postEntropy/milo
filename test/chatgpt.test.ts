import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { get } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { beginChatGptBrowserLogin, chatGptPlanName } from '../src/core/chatgpt/auth.js'
import {
  accountFromTokens,
  buildAuthorizeUrl,
  readCodexAccount,
  tokenClaims,
  tokenFailure,
} from '../src/core/chatgpt/token.js'

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.signature`
}

const account = 'fe644c66-2b2c-4aaf-9a30-f213e1487dcb'
const idToken = jwt({
  email: 'person@example.com',
  exp: 1_800_000_000,
  'https://api.openai.com/auth': {
    chatgpt_account_id: account,
    chatgpt_plan_type: 'plus',
  },
})
const accessToken = jwt({
  exp: 1_800_000_000,
  session_id: 'sess_1',
  'https://api.openai.com/auth': { chatgpt_account_id: account },
})

let codexHome: string | null = null

afterEach(() => {
  vi.unstubAllGlobals()
  if (codexHome) rmSync(codexHome, { recursive: true, force: true })
  codexHome = null
  delete process.env.CODEX_HOME
})

describe('ChatGPT token handling', () => {
  it('spells the plan name with its first letter raised', () => {
    expect(chatGptPlanName('plus')).toBe('Plus')
    expect(chatGptPlanName('pro')).toBe('Pro')
    expect(chatGptPlanName()).toBeUndefined()
  })

  it('reads the account, plan and expiry from the tokens', () => {
    const next = accountFromTokens(
      { access_token: accessToken, refresh_token: 'refresh_1', id_token: idToken },
      undefined,
      1_000,
    )

    expect(next).toMatchObject({
      accessToken,
      refreshToken: 'refresh_1',
      idToken,
      accountId: account,
      email: 'person@example.com',
      planType: 'plus',
      expiresAt: 1_800_000_000_000,
    })
    expect(tokenClaims(accessToken)?.session_id).toBe('sess_1')
  })

  it('keeps the previous refresh token and account when a refresh omits them', () => {
    const next = accountFromTokens(
      { access_token: accessToken },
      {
        accessToken: 'old',
        refreshToken: 'refresh_old',
        accountId: account,
        email: 'person@example.com',
        planType: 'plus',
      },
    )

    expect(next.refreshToken).toBe('refresh_old')
    expect(next.accountId).toBe(account)
    expect(next.email).toBe('person@example.com')
  })

  it('builds the Codex authorize URL with PKCE and its own flow flags', () => {
    const url = new URL(
      buildAuthorizeUrl({
        redirectUri: 'http://127.0.0.1:1455/auth/callback',
        state: 'state_1',
        codeChallenge: 'challenge_1',
      }),
    )

    expect(url.origin + url.pathname).toBe('https://auth.openai.com/oauth/authorize')
    expect(url.searchParams.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('scope')).toContain('offline_access')
    expect(url.searchParams.get('codex_cli_simplified_flow')).toBe('true')
    expect(url.searchParams.get('originator')).toBe('codex_cli_rs')
  })

  it('imports an existing Codex login', () => {
    codexHome = mkdtempSync(path.join(tmpdir(), 'milo-codex-'))
    process.env.CODEX_HOME = codexHome
    mkdirSync(codexHome, { recursive: true })
    writeFileSync(
      path.join(codexHome, 'auth.json'),
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { access_token: accessToken, refresh_token: 'refresh_1', id_token: idToken, account_id: account },
      }),
    )

    expect(readCodexAccount()).toMatchObject({ accountId: account, planType: 'plus', email: 'person@example.com' })
  })

  it('puts the provider sentence on a refusal, not the envelope', () => {
    expect(tokenFailure(401, 'Unauthorized', '{"error":"invalid_grant","error_description":"refresh token expired"}')).toBe(
      'ChatGPT sign-in failed (401): refresh token expired',
    )
  })

  it('completes the browser flow: callback, code exchange, stored grant', async () => {
    const tokenRequest = vi.fn(
      async (_url: string | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({ access_token: accessToken, refresh_token: 'refresh_1', id_token: idToken, expires_in: 3600 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    )
    vi.stubGlobal('fetch', tokenRequest)
    let stored: unknown = null
    const login = await beginChatGptBrowserLogin({ ports: [0], timeoutMs: 5_000, save: (account) => { stored = account } })
    const state = new URL(login.url).searchParams.get('state')

    const redirect = new URL(new URL(login.url).searchParams.get('redirect_uri')!)
    await new Promise<void>((resolve, reject) => {
      get(`${redirect.origin}/auth/callback?code=code_1&state=${state}`, (response) => {
        response.resume()
        response.on('end', resolve)
      }).on('error', reject)
    })

    await expect(login.wait).resolves.toMatchObject({ accountId: account, planType: 'plus' })
    expect(stored).toMatchObject({ accountId: account, email: 'person@example.com' })
    const [url, init] = tokenRequest.mock.calls[0]!
    expect(String(url)).toBe('https://auth.openai.com/oauth/token')
    const body = new URLSearchParams(String(init?.body))
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('code_1')
    expect(body.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann')
    expect(body.get('code_verifier')).toBeTruthy()
  })
})
