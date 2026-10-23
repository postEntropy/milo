import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stringify } from 'yaml'

const home = mkdtempSync(path.join(os.tmpdir(), 'milo-core-settings-'))
process.env.MILO_HOME = home

const {
  saveSecret,
  removeSecret,
} = await import('../src/core/settings.js')
const { readAuth } = await import('../src/core/config/load.js')

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
