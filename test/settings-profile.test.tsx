import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { useState } from 'react'
import { cleanup, render } from 'ink-testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Copying a profile from the setup screen — the question being whether Milo
 * does it, or whether someone had to do it by hand.
 *
 * `findProfiles` is faked to point at a profile this test made, so the run is
 * the same on a machine with twelve browsers and on one with none: what is under
 * test is the button, not the machine.
 */
const home = mkdtempSync(path.join(tmpdir(), 'milo-profile-ui-'))
process.env.MILO_HOME = home

vi.mock('../src/core/browser/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/browser/index.js')>()
  const fs = await import('node:fs')
  const os = await import('node:os')
  const p = await import('node:path')

  // A real directory with the files a sign-in lives in, and a cache that must
  // not be copied: the copy is real, only the source is invented.
  const dir = fs.mkdtempSync(p.join(os.tmpdir(), 'milo-fake-profile-'))
  fs.mkdirSync(p.join(dir, 'Default', 'Service Worker'), { recursive: true })
  fs.writeFileSync(p.join(dir, 'Default', 'Cookies'), 'SQLite format 3\0the cookies')
  fs.writeFileSync(p.join(dir, 'Default', 'Preferences'), '{"profile":{}}')
  fs.writeFileSync(p.join(dir, 'Local State'), '{"os_crypt":{}}')
  fs.writeFileSync(p.join(dir, 'Default', 'Service Worker', 'big'), 'x'.repeat(40_000))

  return {
    ...actual,
    findProfiles: async () => [
      { id: 'helium', name: 'Helium', dir, bytes: 48, cookieStore: { bytes: 1024, at: Date.now() } },
    ],
  }
})

const config = {
  provider: 'commandcode',
  model: 'some-model',
  providers: { commandcode: { baseURL: 'https://api.commandcode.ai/provider/v1' } },
  memory: { backend: 'file' as const },
  display: { tools: 'full' as const, thinking: 'on' },
  reasoningEffort: 'medium' as const,
  gateways: {},
  permissions: { mode: 'ask' as const, allow: [], deny: [], jevThreshold: 0.35, jevTimeoutMs: 1500 },
  browser: { enabled: true, chromePath: null, headless: true, profileDir: null, cdpUrl: null, keepSnapshots: 2 },
}
writeFileSync(path.join(home, 'config.json'), JSON.stringify(config, null, 2))

const { SettingsScreen } = await import('../src/gateways/cli/screens/settings.js')

const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms))
const DOWN = '\u001b[B'

function renderSettings() {
  function Live() {
    const [current, setCurrent] = useState(() => JSON.parse(readFileSync(path.join(home, 'config.json'), 'utf8')))
    return (
      <SettingsScreen
        config={current}
        mode="ask"
        onModeChange={() => {}}
        onOpenModel={() => {}}
        onSaved={() => setCurrent(JSON.parse(readFileSync(path.join(home, 'config.json'), 'utf8')))}
        onClose={() => {}}
      />
    )
  }
  return render(<Live />)
}

type App = ReturnType<typeof renderSettings>
const press = async (app: App, key: string) => {
  app.stdin.write(key)
  await tick(30)
}

/** Walks the cursor to the row whose text matches, rather than counting presses. */
async function moveTo(app: App, text: string, steps = 12): Promise<void> {
  for (let index = 0; index < steps; index += 1) {
    const line = (app.lastFrame() ?? '').split('\n').find((row) => row.includes(text))
    const leading = line?.slice(0, line.indexOf(text)) ?? ''
    if (leading.includes('❯')) return
    await press(app, DOWN)
  }
  throw new Error(`could not reach ${JSON.stringify(text)}:\n${app.lastFrame() ?? ''}`)
}

async function waitUntil(check: () => boolean, timeoutMs = 4000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (check()) return
    await tick(30)
  }
  throw new Error('timed out waiting for condition')
}

const readConfig = () => JSON.parse(readFileSync(path.join(home, 'config.json'), 'utf8'))

beforeEach(() => {
  writeFileSync(path.join(home, 'config.json'), JSON.stringify(config, null, 2))
})

afterEach(() => cleanup())

describe('picking a profile in setup', () => {
  it('copies it there and then, and points Milo at the copy', async () => {
    const app = renderSettings()
    await moveTo(app, 'Tools')
    await press(app, '\r')
    await moveTo(app, 'Browser')
    await press(app, '\r')
    await moveTo(app, 'Profile')
    await press(app, '\r')

    // The profile the fake discovery offered, with what it holds. Discovery is a
    // round trip, so the row arrives a tick after the screen does.
    await waitUntil(() => (app.lastFrame() ?? '').includes('Helium'))
    expect(app.lastFrame() ?? '').toContain('Helium')
    await moveTo(app, 'Helium')
    await press(app, '\r')

    const target = path.join(home, 'browser', 'profiles', 'helium')

    // Picking asks first, and says what it means before anything is written.
    await waitUntil(() => (app.lastFrame() ?? '').includes('into Milo'))
    expect(app.lastFrame()).toContain('signed in as you on every site')
    // The way out is offered at the moment it matters, not buried elsewhere.
    expect(app.lastFrame()).toContain('signed in nowhere, nothing copied')
    expect(existsSync(target)).toBe(false)
    expect(readConfig().browser.profileDir).toBeNull()

    // Saying no copies nothing.
    await moveTo(app, 'Cancel')
    await press(app, '\r')
    await waitUntil(() => (app.lastFrame() ?? '').includes('Name a directory'))
    expect(existsSync(target)).toBe(false)

    // Saying yes is what does it.
    await moveTo(app, 'Helium')
    await press(app, '\r')
    await moveTo(app, 'Copy it')
    await press(app, '\r')
    await waitUntil(() => readConfig().browser.profileDir === target)

    // The copy is on disk, with the cookies and without the cache.
    expect(readFileSync(path.join(target, 'Default', 'Cookies'), 'utf8')).toContain('the cookies')
    expect(existsSync(path.join(target, 'Local State'))).toBe(true)
    expect(existsSync(path.join(target, 'Default', 'Service Worker'))).toBe(false)

    // And the screen says what happened, and where the logins came from — by
    // the browser's name, not by its directory.
    await waitUntil(() => (app.lastFrame() ?? '').includes('copied from Helium'))
  })

  it('keeps the copied files private', async () => {
    const app = renderSettings()
    await moveTo(app, 'Tools')
    await press(app, '\r')
    await moveTo(app, 'Browser')
    await press(app, '\r')
    await moveTo(app, 'Profile')
    await press(app, '\r')
    await moveTo(app, 'Helium')
    await press(app, '\r')
    await moveTo(app, 'Copy it')
    await press(app, '\r')

    const target = path.join(home, 'browser', 'profiles', 'helium')
    await waitUntil(() => readConfig().browser.profileDir === target)

    const { statSync } = await import('node:fs')
    expect(statSync(path.join(target, 'Default', 'Cookies')).mode & 0o777).toBe(0o600)
  })
})
