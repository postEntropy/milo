import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stringify } from 'yaml'

const home = mkdtempSync(path.join(os.tmpdir(), 'milo-core-settings-'))
process.env.MILO_HOME = home

const {
  setWebHost,
  setWebPort,
  setWebEnabled,
  setBrowserField,
  setBrowserEnabled,
  setSearchProvider,
  saveSecret,
  removeSecret,
} = await import('../src/core/settings.js')
const { readConfig, readAuth } = await import('../src/core/config/load.js')

function writeBaseConfig(): void {
  writeFileSync(
    path.join(home, 'config.yml'),
    stringify({
      provider: 'test',
      model: 'test-model',
      providers: { test: { baseURL: 'https://provider.example/v1' } },
    }),
  )
}

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
})

describe('core settings operations', () => {
  it('updates web host and trims surrounding whitespace', () => {
    writeBaseConfig()
    const res = setWebHost('  0.0.0.0  ')
    expect(res.ok).toBe(true)
    expect(readConfig()?.web.host).toBe('0.0.0.0')
  })

  it('refuses an empty web host', () => {
    writeBaseConfig()
    const res = setWebHost('   ')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('Host cannot be empty')
  })

  it('updates web port when given a valid integer', () => {
    writeBaseConfig()
    const res = setWebPort(8080)
    expect(res.ok).toBe(true)
    expect(readConfig()?.web.port).toBe(8080)
  })

  it('refuses a port outside the 0-65535 range', () => {
    writeBaseConfig()
    const res = setWebPort(70000)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('integer between 0 and 65535')
  })

  it('toggles web enabled state', () => {
    writeBaseConfig()
    expect(setWebEnabled(false).ok).toBe(true)
    expect(readConfig()?.web.enabled).toBe(false)
    expect(setWebEnabled(true).ok).toBe(true)
    expect(readConfig()?.web.enabled).toBe(true)
  })

  it('updates browser fields and cleans up empty string values', () => {
    writeBaseConfig()
    const res = setBrowserField('chromePath', '  /usr/bin/google-chrome  ')
    expect(res.ok).toBe(true)
    expect(readConfig()?.browser.chromePath).toBe('/usr/bin/google-chrome')

    setBrowserField('chromePath', '   ')
    expect(readConfig()?.browser.chromePath).toBeNull()
  })

  it('enables and disables browser capability', () => {
    writeBaseConfig()
    setBrowserEnabled(true)
    expect(readConfig()?.browser.enabled).toBe(true)
  })

  it('sets and clears search providers', () => {
    writeBaseConfig()
    setSearchProvider('tavily')
    expect(readConfig()?.search?.provider).toBe('tavily')

    setSearchProvider(undefined)
    expect(readConfig()?.search).toBeUndefined()
  })

  it('saves and removes secrets across groups', () => {
    writeBaseConfig()
    const saved = saveSecret('providers', 'openai', 'sk-test-123')
    expect(saved.ok).toBe(true)
    expect(readAuth().providers.openai).toBe('sk-test-123')

    const removed = removeSecret('providers', 'openai')
    expect(removed.ok).toBe(true)
    expect(readAuth().providers.openai).toBeUndefined()
  })
})
