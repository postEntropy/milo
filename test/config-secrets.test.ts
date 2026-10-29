import { afterEach, describe, expect, it } from 'vitest'
import { resolveApiKey, resolveGatewayToken } from '../src/core/config/load.js'
import { emptyAuth, type ProviderEntry } from '../src/core/config/schema.js'

const entry: ProviderEntry = {
  name: 'Test',
  baseURL: 'https://example.invalid/v1',
  wire: 'openai',
  keyEnv: 'MILO_TEST_PROVIDER_KEY',
}

afterEach(() => {
  delete process.env.MILO_TEST_PROVIDER_KEY
  delete process.env.MILO_WEB_TOKEN
})

describe('a secret the install stores', () => {
  it('wins over one left in the environment, so a rotated key is not silently outranked', () => {
    process.env.MILO_TEST_PROVIDER_KEY = 'from-env'
    const auth = { ...emptyAuth(), providers: { test: 'stored-key' } }
    expect(resolveApiKey('test', entry, auth)).toBe('stored-key')
  })

  it('is the one used when the environment says nothing', () => {
    const auth = { ...emptyAuth(), providers: { test: '  stored-key  ' } }
    expect(resolveApiKey('test', entry, auth)).toBe('stored-key')
  })

  it('leaves the environment as the way to configure a machine that stores nothing', () => {
    process.env.MILO_TEST_PROVIDER_KEY = '  from-env  '
    expect(resolveApiKey('test', entry, emptyAuth())).toBe('from-env')
  })

  it('takes the same rank for a gateway token', () => {
    process.env.MILO_WEB_TOKEN = 'from-env'
    expect(resolveGatewayToken('web', { ...emptyAuth(), gateways: { web: 'stored-token' } })).toBe('stored-token')
    expect(resolveGatewayToken('web', emptyAuth())).toBe('from-env')
  })
})
