import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  auth: {} as Record<string, unknown>,
  config: {} as Record<string, unknown>,
}))

vi.mock('../src/core/config/load.js', () => ({
  readAuth: () => mocks.auth,
  readConfig: () => mocks.config,
  saveAuth: () => {},
  saveConfig: () => {},
}))

const { runGoogle } = await import('../src/bin/google.js')

const account = {
  clientId: 'c',
  clientSecret: 's',
  refreshToken: 'r',
  email: 'ana@exemplo',
  connectedAt: '2026-09-30T12:00:00.000Z',
}

async function statusLines(): Promise<string[]> {
  const out: string[] = []
  await runGoogle(['google', 'status'], { out: (line) => out.push(line), err: (line) => out.push(line) })
  return out
}

// A parsed config always carries the `google` section — `readConfig` runs the
// schema, and the schema defaults it in.
const configWith = (enabled: boolean) => ({ google: { enabled } })

beforeEach(() => {
  mocks.auth = { google: { ...account } }
  mocks.config = configWith(true)
})

describe('what `milo google status` reports', () => {
  it('names every tool the grant covers, the Drive ones included', async () => {
    const lines = await statusLines()
    expect(lines[0]).toBe(
      'Connected as ana@exemplo since 2026-09-30. Read-only: gmail_search, gmail_read, drive_search, drive_read — nothing writes.',
    )
  })

  it('says the tools are off when the config turned them off', async () => {
    mocks.config = configWith(false)
    const lines = await statusLines()
    expect(lines[1]).toContain('not registered')
  })

  it('says no account is connected when there is no grant', async () => {
    mocks.auth = {}
    const lines = await statusLines()
    expect(lines[0]).toContain('no account is connected')
  })

  it('says it is off when it is off in the config and nothing is connected', async () => {
    mocks.auth = {}
    mocks.config = configWith(false)
    const lines = await statusLines()
    expect(lines[0]).toContain('Google is off')
  })
})
