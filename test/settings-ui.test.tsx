import { useState } from 'react'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render } from 'ink-testing-library'

// Point the app at a throwaway home *before* the config modules load.
const home = mkdtempSync(path.join(tmpdir(), 'milo-settings-'))
process.env.MILO_HOME = home

const config = {
  provider: 'commandcode',
  model: 'some-model',
  providers: { commandcode: { baseURL: 'https://api.commandcode.ai/provider/v1' } },
  memory: { backend: 'file' as const },
  display: { tools: 'full' as const, thinking: true },
  gateways: {},
  permissions: { mode: 'ask' as const, allow: [], deny: [], jevThreshold: 0.35, jevTimeoutMs: 1500 },
}
writeFileSync(path.join(home, 'config.json'), JSON.stringify(config, null, 2))

const { SettingsScreen } = await import('../src/gateways/cli/screens/settings.js')
type PermissionMode = import('../src/core/tools/permission.js').PermissionMode

const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms))
const DOWN = '\u001b[B'

interface App {
  stdin: { write: (data: string) => void }
  lastFrame: () => string | undefined
}

async function press(app: App, key: string): Promise<void> {
  app.stdin.write(key)
  await tick(20)
}

/** Waits for the rendered frame to contain `text`, so steps are never raced. */
async function waitFor(app: App, text: string, timeoutMs = 1500): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if ((app.lastFrame() ?? '').includes(text)) return
    await tick(20)
  }
  throw new Error(`timed out waiting for ${JSON.stringify(text)}`)
}

/** Waits for a side effect (usually a file write). */
async function waitUntil(check: () => boolean, timeoutMs = 1500): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (check()) return
    await tick(20)
  }
  throw new Error('timed out waiting for condition')
}

const readJson = (name: string) => JSON.parse(readFileSync(path.join(home, name), 'utf8'))

function renderSettings(overrides: Record<string, unknown> = {}) {
  /**
   * Mirrors the shell: it re-reads the config after every save and hands the
   * screen the fresh copy. Without that a cycling row would not cycle, since it
   * reads the value it is about to change from its props.
   */
  function Live() {
    const [current, setCurrent] = useState(() => readJson('config.json'))
    return (
      <SettingsScreen
        config={current}
        mode="ask"
        onModeChange={
          (overrides.onModeChange as ((mode: PermissionMode) => void) | undefined) ?? (() => {})
        }
        onOpenModel={() => {}}
        onSaved={() => setCurrent(readJson('config.json'))}
        onClose={(overrides.onClose as () => void) ?? (() => {})}
      />
    )
  }

  return render(<Live />)
}

afterEach(() => cleanup())

// Each test starts from a clean config + auth, so flows do not inherit the
// previous test's token or allowlist.
beforeEach(() => {
  writeFileSync(path.join(home, 'config.json'), JSON.stringify(config, null, 2))
  rmSync(path.join(home, 'auth.json'), { force: true })
})

describe('SettingsScreen', () => {
  it('shows the section hub', () => {
    const { lastFrame } = renderSettings()
    const frame = lastFrame() ?? ''
    expect(frame).toContain('Setup')
    expect(frame).toContain('Provider & model')
    expect(frame).toContain('API keys / tokens')
    expect(frame).toContain('Gateways')
    expect(frame).toContain('Memory')
  })

  it('offers an explicit exit and says nothing is pending', () => {
    const frame = renderSettings().lastFrame() ?? ''
    expect(frame).toContain('Save & exit')
    expect(frame).toContain('everything is already saved')
    expect(frame).toContain('changes save as you make them')
    expect(frame).toContain('Esc exit')
  })

  it('closes when Save & exit is chosen', async () => {
    let closed = false
    const app = renderSettings({
      onClose: () => {
        closed = true
      },
    })

    // Provider & model, API keys, Web search, permissions, display, gateways, memory
    for (let index = 0; index < 7; index += 1) await press(app, DOWN)
    await press(app, '\r')

    expect(closed).toBe(true)
  })

  it('says Esc goes back inside a section', async () => {
    const app = renderSettings()
    await press(app, DOWN)
    await press(app, '\r')
    await waitFor(app, 'API keys')
    expect(app.lastFrame()).toContain('Esc back')
  })

  it('lists the key slots', async () => {
    const app = renderSettings()
    await press(app, DOWN)
    await press(app, '\r')
    await waitFor(app, 'API keys')

    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('Command Code')
    expect(frame).toContain('Telegram bot')
    expect(frame).toContain('DISCORD_BOT_TOKEN')
  })

  it('stores a pasted key in auth.json', async () => {
    const app = renderSettings()
    await press(app, DOWN)
    await press(app, '\r')
    await waitFor(app, 'API keys')
    await press(app, '\r') // Command Code slot
    await waitFor(app, 'COMMANDCODE_API_KEY')

    app.stdin.write('sk-test-123')
    await tick(20)
    app.stdin.write('\r')
    await waitFor(app, 'API keys')

    expect(readJson('auth.json').providers.commandcode).toBe('sk-test-123')
  })

  it('cycles the permission mode and hands it to the shell', async () => {
    const modes: string[] = []
    const app = renderSettings({ onModeChange: (mode: string) => modes.push(mode) })

    // Provider & model, API keys, Web search, Tools & permissions
    await press(app, DOWN)
    await press(app, DOWN)
    await press(app, DOWN)
    await press(app, '\r')
    await waitFor(app, 'Tools & permissions')

    await press(app, '\r') // Mode row: ask -> auto
    await waitUntil(() => modes.length > 0)

    // The shell owns persistence for the mode; the screen only reports it.
    expect(modes).toEqual(['auto'])
  })

  it('closes on Ctrl+C', async () => {
    let closed = false
    const { stdin } = renderSettings({ onClose: () => { closed = true } })
    stdin.write('\u0003')
    await tick()
    expect(closed).toBe(true)
  })

  it('walks a gateway through token, access and enable', async () => {
    const app = renderSettings()
    for (let index = 0; index < 5; index += 1) await press(app, DOWN)
    await press(app, '\r') // Gateways list
    await waitFor(app, 'telegram')

    await press(app, '\r') // step 1: token
    await waitFor(app, 'Step 1 of 3')
    expect(app.lastFrame()).toContain('BotFather')

    app.stdin.write('123:ABC')
    await tick(20)
    app.stdin.write('\r') // step 2: access
    await waitFor(app, 'Step 2 of 3')
    expect(app.lastFrame()).toContain('who can talk')

    app.stdin.write('42, 99')
    await tick(20)
    app.stdin.write('\r') // step 3: enable
    await waitFor(app, 'Step 3 of 3')

    await press(app, '\r') // Enable
    await waitFor(app, 'enabled')

    expect(readJson('auth.json').gateways.telegram).toBe('123:ABC')
    expect(readJson('config.json').gateways.telegram.allowlist).toEqual(['42', '99'])
    expect(readJson('config.json').gateways.telegram.enabled).toBe(true)
  })

  it('lets the access step be left empty (anyone)', async () => {
    const app = renderSettings()
    for (let index = 0; index < 5; index += 1) await press(app, DOWN)
    await press(app, '\r')
    await waitFor(app, 'telegram')

    await press(app, '\r') // token step
    await waitFor(app, 'Step 1 of 3')

    app.stdin.write('tok')
    await tick(20)
    app.stdin.write('\r') // access step
    await waitFor(app, 'Step 2 of 3')

    app.stdin.write('\r') // leave it empty
    await waitFor(app, 'Step 3 of 3')

    expect(readJson('config.json').gateways.telegram.allowlist).toEqual([])
  })

  it('cycles how much of a tool call is shown, and writes it down', async () => {
    const app = renderSettings()
    for (let index = 0; index < 4; index += 1) await press(app, DOWN)
    await press(app, '\r') // Display
    await waitFor(app, 'Tool calls')

    expect(app.lastFrame()).toContain('full')
    await press(app, '\r') // full -> name
    await waitUntil(() => readJson('config.json').display?.tools === 'name')

    await press(app, '\r') // name -> off
    await waitUntil(() => readJson('config.json').display?.tools === 'off')
    expect(app.lastFrame()).toContain('off')
  })

  it('toggles thinking and says it applies everywhere', async () => {
    const app = renderSettings()
    for (let index = 0; index < 4; index += 1) await press(app, DOWN)
    await press(app, '\r')
    await waitFor(app, 'Thinking')

    await press(app, DOWN)
    await press(app, '\r')

    await waitUntil(() => readJson('config.json').display?.thinking === false)
    expect(app.lastFrame()).toContain('applies to every surface')
  })

  it('sets and clears the output ceiling', async () => {
    const app = renderSettings()
    for (let index = 0; index < 4; index += 1) await press(app, DOWN)
    await press(app, '\r')
    await waitFor(app, 'Output limit')

    await press(app, DOWN)
    await press(app, DOWN)
    await press(app, '\r')
    await waitFor(app, 'token ceiling')

    app.stdin.write('8192')
    await tick(20)
    app.stdin.write('\r')
    await waitUntil(() => readJson('config.json').maxTokens === 8192)

    // Reopening shows what is stored; empty means "leave it to the wire", and an
    // empty field is how that is asked for.
    await press(app, DOWN)
    await press(app, DOWN)
    await press(app, '\r')
    await waitFor(app, 'token ceiling')
    await tick(20)
    expect(app.lastFrame()).toContain('8192')

    // Sent one at a time: a run of backspaces in a single write arrives as one
    // keypress, the way a terminal delivers it.
    for (let press = 0; press < 4; press += 1) {
      app.stdin.write('\u007f')
      await tick(20)
    }
    app.stdin.write('\r')
    await waitUntil(() => readJson('config.json').maxTokens === undefined)
  })

  it('rejects a nonsense ceiling rather than writing it', async () => {
    const app = renderSettings()
    for (let index = 0; index < 4; index += 1) await press(app, DOWN)
    await press(app, '\r')
    await waitFor(app, 'Output limit')
    await press(app, DOWN)
    await press(app, DOWN)
    await press(app, '\r')
    await waitFor(app, 'token ceiling')

    app.stdin.write('lots')
    await tick(20)
    app.stdin.write('\r')
    await waitUntil(() => readJson('config.json').maxTokens === undefined)
  })
})
