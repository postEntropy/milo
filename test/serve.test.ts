import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stringify } from 'yaml'

// Point the app at a throwaway home *before* the config modules load.
const home = mkdtempSync(path.join(tmpdir(), 'milo-serve-'))
process.env.MILO_HOME = home

const calls = vi.hoisted(() => ({
  started: [] as string[],
  web: null as { host: string; port: number; token?: string } | null,
}))

vi.mock('../src/gateways/telegram/index.js', () => ({
  TelegramGateway: class {
    id = 'telegram'
    async start() {
      calls.started.push('telegram')
    }
    async stop() {}
  },
}))

vi.mock('../src/gateways/discord/index.js', () => ({
  DiscordGateway: class {
    id = 'discord'
    async start() {
      calls.started.push('discord')
    }
    async stop() {}
  },
}))

vi.mock('../src/gateways/web/gateway.js', () => ({
  WebGateway: class {
    id = 'web'
    constructor(options: { host: string; port: number; token?: string }) {
      calls.web = { host: options.host, port: options.port, token: options.token }
    }
    async start() {
      calls.started.push('web')
    }
    async stop() {}
  },
}))

const { runServe } = await import('../src/gateways/serve.js')

const configWith = (
  gateways: Record<string, { enabled: boolean; allowlist: string[] }>,
  extra: Record<string, unknown> = {},
) =>
  stringify({
    provider: 'test',
    model: 'test-model',
    providers: { test: { baseURL: 'https://x.test/v1', wire: 'openai' } },
    display: { tools: 'full', thinking: 'on' },
    gateways,
    permissions: { mode: 'ask', allow: [], deny: [], jevThreshold: 0.35, jevTimeoutMs: 1500 },
    ...extra,
  })

const messages: string[] = []
const originalExitCode = process.exitCode

describe('runServe', () => {
  beforeEach(() => {
    calls.started = []
    calls.web = null
    messages.length = 0
    process.exitCode = 0
    delete process.env.TELEGRAM_BOT_TOKEN
    delete process.env.DISCORD_BOT_TOKEN
    delete process.env.MILO_WEB_TOKEN
    rmSync(path.join(home, 'config.yml'), { force: true })
    rmSync(path.join(home, 'auth.json'), { force: true })
    // Startup creates this one, so a skill left behind by a test would be read
    // by the next.
    rmSync(path.join(home, 'skills'), { recursive: true, force: true })
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      messages.push(args.map(String).join(' '))
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    process.exitCode = originalExitCode
  })

  it('refuses to serve without a configuration', async () => {
    await runServe()

    expect(process.exitCode).toBe(1)
    expect(messages.join('\n')).toContain('No configuration found')
  })

  it('starts the enabled gateways, the web UI among them, and says which', async () => {
    writeFileSync(
      path.join(home, 'config.yml'),
      configWith({
        telegram: { enabled: true, allowlist: [] },
        discord: { enabled: true, allowlist: [] },
      }),
    )
    process.env.TELEGRAM_BOT_TOKEN = 'tg-token'
    process.env.DISCORD_BOT_TOKEN = 'dc-token'

    await runServe()

    // The web UI rides along unless it is turned off, so a plain `milo serve`
    // is the bots and the browser chat at once.
    expect(calls.started).toEqual(['telegram', 'discord', 'web'])
    expect(messages.join('\n')).toContain('Milo serving: telegram, discord, web')
    // Loopback:7717 unless the config or a flag says otherwise.
    expect(calls.web).toEqual({ host: '127.0.0.1', port: 7717 })
    expect(process.exitCode).toBe(0)
  })

  it('leaves the web UI out when it is turned off', async () => {
    writeFileSync(
      path.join(home, 'config.yml'),
      configWith({ telegram: { enabled: true, allowlist: [] } }),
    )
    process.env.TELEGRAM_BOT_TOKEN = 'tg-token'

    await runServe({ noWeb: true })

    expect(calls.started).toEqual(['telegram'])
    expect(messages.join('\n')).not.toContain('web')
    expect(process.exitCode).toBe(0)
  })

  it('takes the web host and port from the config', async () => {
    writeFileSync(
      path.join(home, 'config.yml'),
      configWith(
        { telegram: { enabled: true, allowlist: [] } },
        { web: { enabled: true, host: '0.0.0.0', port: 8123 } },
      ),
    )
    process.env.TELEGRAM_BOT_TOKEN = 'tg-token'

    await runServe()

    // The config decides where the surface lives; `--web-port` only overrides it.
    expect(calls.web).toEqual({ host: '0.0.0.0', port: 8123 })
  })

  it('leaves the web UI out when the config disables it', async () => {
    writeFileSync(
      path.join(home, 'config.yml'),
      configWith(
        { telegram: { enabled: true, allowlist: [] } },
        { web: { enabled: false } },
      ),
    )
    process.env.TELEGRAM_BOT_TOKEN = 'tg-token'

    await runServe()

    expect(calls.started).toEqual(['telegram'])
    expect(calls.web).toBeNull()
  })

  it('hands the web UI the stored token, so the URL outlives a restart', async () => {
    writeFileSync(path.join(home, 'config.yml'), configWith({}))
    writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ gateways: { web: 'stored-token' } }))

    await runServe()

    expect(calls.web).toEqual({ host: '127.0.0.1', port: 7717, token: 'stored-token' })
  })

  it('lets MILO_WEB_TOKEN override the stored one', async () => {
    writeFileSync(path.join(home, 'config.yml'), configWith({}))
    writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ gateways: { web: 'stored-token' } }))
    process.env.MILO_WEB_TOKEN = 'from-env'

    await runServe()

    expect(calls.web).toEqual({ host: '127.0.0.1', port: 7717, token: 'from-env' })
  })

  it('leaves the token to the server to mint when nothing is stored', async () => {
    writeFileSync(path.join(home, 'config.yml'), configWith({}))

    await runServe()

    // Undefined rather than empty: the server mints a fresh one per run, which
    // is what an install that never sets a token keeps doing.
    expect(calls.web?.token).toBeUndefined()
  })

  it('says what it is running with, and how many skills it read', async () => {
    writeFileSync(
      path.join(home, 'config.yml'),
      configWith({ telegram: { enabled: true, allowlist: [] } }),
    )
    process.env.TELEGRAM_BOT_TOKEN = 'tg-token'
    const dir = path.join(home, 'skills', 'deploy')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path.join(dir, 'SKILL.md'),
      '---\nname: deploy\ndescription: How to deploy\n---\n\nRun it.\n',
    )

    await runServe()

    // The count is the only way to tell whether the startup index saw the
    // skills, since nothing else about them is printed.
    const output = messages.join('\n')
    expect(output).toContain('test-model (test)')
    expect(output).toContain('mode ask')
    expect(output).toContain('1 skill')
    expect(output).toContain(home)
  })

  it('counts the routines it will run', async () => {
    writeFileSync(
      path.join(home, 'config.yml'),
      configWith({ telegram: { enabled: true, allowlist: [] } }),
    )
    process.env.TELEGRAM_BOT_TOKEN = 'tg-token'
    writeFileSync(
      path.join(home, 'routines.json'),
      JSON.stringify([
        {
          id: 'calm-otter-1',
          prompt: 'briefing',
          when: { kind: 'at', time: '08:00' },
          target: { gateway: 'telegram', conversationId: '123' },
          enabled: true,
          createdAt: 0,
        },
      ]),
    )

    await runServe()

    // Only visible on the boot line, and only true if the loop started.
    expect(messages.join('\n')).toContain('1 routine')
  })

  it('says the token is missing, and with the web UI off starts nothing', async () => {
    writeFileSync(
      path.join(home, 'config.yml'),
      configWith({ telegram: { enabled: true, allowlist: [] } }),
    )

    await runServe({ noWeb: true })

    expect(calls.started).toEqual([])
    expect(process.exitCode).toBe(1)
    const output = messages.join('\n')
    expect(output).toContain('Telegram is enabled but no token was found (TELEGRAM_BOT_TOKEN).')
    expect(output).toContain('No gateways enabled')
  })
})
