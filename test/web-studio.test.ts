import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = mkdtempSync(path.join(os.tmpdir(), 'milo-web-studio-'))
process.env.MILO_HOME = home

const { WebStudio } = await import('../src/gateways/web/studio.js')
const { AgentRuntime } = await import('../src/core/runtime.js')
const { saveAuth } = await import('../src/core/config/load.js')

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('web Studio secret handling', () => {
  it('never returns API keys or custom headers in overview', async () => {
    writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      provider: 'test',
      model: 'test-model',
      providers: { test: { baseURL: 'https://provider.example/v1', headers: { authorization: 'Bearer header-secret' } } },
    }))
    saveAuth({ providers: { test: 'provider-secret' }, gateways: {}, search: {} })
    const runtime = new AgentRuntime({
      provider: { id: 'test', stream: async function* () {} },
      model: 'test-model',
      system: '',
      registry: { specs: () => [] } as never,
      memory: {} as never,
      cwd: home,
    })
    const studio = new WebStudio(runtime, home)
    const overview = JSON.stringify(await studio.handle('overview'))
    expect(overview).not.toContain('provider-secret')
    expect(overview).not.toContain('header-secret')
    expect(overview).toContain('••••••••')
  })
})
