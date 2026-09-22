import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// Point the app at a throwaway home *before* the config modules load.
const home = mkdtempSync(path.join(tmpdir(), 'milo-config-'))
process.env.MILO_HOME = home

const { readConfig, setPermissionMode } = await import('../src/core/config/load')

const configFile = path.join(home, 'config.json')

const base = {
  provider: 'commandcode',
  model: 'some-model',
  providers: { commandcode: { baseURL: 'https://api.commandcode.ai/provider/v1' } },
  memory: { backend: 'file' as const },
  gateways: {},
  permissions: {
    mode: 'ask' as const,
    allow: ['shell_command'],
    deny: ['never'],
    jevThreshold: 0.35,
    jevTimeoutMs: 1500,
  },
}

beforeEach(() => {
  writeFileSync(configFile, JSON.stringify(base, null, 2))
})

afterEach(() => {
  rmSync(configFile, { force: true })
})

describe('setPermissionMode', () => {
  it('writes the mode and leaves the rest of the file alone', () => {
    setPermissionMode('yolo')

    const config = readConfig()
    expect(config?.permissions.mode).toBe('yolo')
    expect(config?.permissions.allow).toEqual(['shell_command'])
    expect(config?.permissions.deny).toEqual(['never'])
    expect(config?.permissions.jevThreshold).toBe(0.35)
    expect(config?.provider).toBe('commandcode')
  })

  it('does nothing when there is no config yet', () => {
    rmSync(configFile, { force: true })

    expect(() => setPermissionMode('auto')).not.toThrow()
    expect(existsSync(configFile)).toBe(false)
  })
})
