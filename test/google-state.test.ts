import { describe, expect, it } from 'vitest'
import { googleState } from '../src/core/google/state.js'
import type { Auth, Config } from '../src/core/config/schema.js'

const config = (enabled: boolean) => ({ google: { enabled } }) as Config
const auth = (google: unknown) => ({ google }) as unknown as Auth

const granted = {
  clientId: 'c',
  clientSecret: 's',
  refreshToken: 'r',
  email: 'ana@exemplo',
  connectedAt: '2026-09-30T12:00:00.000Z',
}

describe('the state of the Google connection', () => {
  it('is off when nothing is wanted and nothing is granted', () => {
    expect(googleState(config(false), auth(undefined))).toEqual({ kind: 'off' })
  })

  it('is wanted when the config asks for it and no account answered', () => {
    expect(googleState(config(true), auth(undefined))).toEqual({ kind: 'wanted' })
  })

  it('carries who and since, and that the tools are on', () => {
    expect(googleState(config(true), auth({ ...granted }))).toEqual({
      kind: 'connected',
      email: 'ana@exemplo',
      connectedAt: '2026-09-30T12:00:00.000Z',
      enabled: true,
    })
  })

  it('is connected but says the tools are off when the config turned them off', () => {
    expect(googleState(config(false), auth({ ...granted }))).toEqual({
      kind: 'connected',
      email: 'ana@exemplo',
      connectedAt: '2026-09-30T12:00:00.000Z',
      enabled: false,
    })
  })

  it('is not a connection when the app identity was stored without a grant', () => {
    const { refreshToken: _grant, ...identity } = granted
    expect(googleState(config(true), auth(identity))).toEqual({ kind: 'wanted' })
  })

  it('reads a missing config as nothing wanted', () => {
    expect(googleState(null, auth({ ...granted }))).toEqual({
      kind: 'connected',
      email: 'ana@exemplo',
      connectedAt: '2026-09-30T12:00:00.000Z',
      enabled: false,
    })
  })
})
