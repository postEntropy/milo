import { useState } from 'react'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from 'ink-testing-library'

// Point the app at a throwaway home *before* the config modules load.
const home = mkdtempSync(path.join(tmpdir(), 'milo-settings-'))
process.env.MILO_HOME = home

const config = {
  provider: 'commandcode',
  model: 'some-model',
  providers: { commandcode: { baseURL: 'https://api.commandcode.ai/provider/v1' } },
  memory: { backend: 'file' as const },
  display: { tools: 'full' as const, thinking: 'on' },
  reasoningEffort: 'medium' as const,
  gateways: {},
  permissions: { mode: 'ask' as const, allow: [], deny: [], jevThreshold: 0.35, jevTimeoutMs: 1500 },
  browser: { enabled: false, chromePath: null, headless: true, profileDir: null, cdpUrl: null, keepSnapshots: 2 },
}
writeFileSync(path.join(home, 'config.json'), JSON.stringify(config, null, 2))

const { SettingsScreen } = await import('../src/gateways/cli/screens/settings.js')
type PermissionMode = import('../src/core/tools/permission.js').PermissionMode
const { defaultProfileRoots } = await import('../src/core/browser/chrome.js')

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

/**
 * Walks the cursor down to the row whose text matches, rather than counting
 * presses from the top: how many rows sit above a given one depends on which
 * bundled skills ship, and a test should not break because one was added.
 */
async function moveTo(app: App, text: string, steps = 12): Promise<void> {
  for (let index = 0; index < steps; index += 1) {
    const line = (app.lastFrame() ?? '').split('\n').find((row) => row.includes(text))
    // The cursor glyph sits before the row's own text — and after the box border,
    // so the marker is looked for in the part that leads up to the label.
    const leading = line?.slice(0, line.indexOf(text)) ?? ''
    if (leading.includes('❯')) return
    await press(app, DOWN)
  }
  throw new Error(`could not reach the row ${JSON.stringify(text)}:\n${app.lastFrame() ?? ''}`)
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

/** The rendered line carrying a row's label, for reading its hint. */
function rowFor(app: App, label: string): string {
  return (app.lastFrame() ?? '').split('\n').find((line) => line.includes(label)) ?? ''
}

/**
 * The frame with its line breaks folded into single spaces, and the box borders
 * taken out.
 *
 * The test terminal is a fixed 100 columns, so a sentence the screen wraps would
 * otherwise never match as one string — and the assertions that matter here are
 * about whole sentences. The border matters too: a wrapped line inside a box ends
 * in `│` and the next begins with one, which would land in the middle of the
 * sentence being looked for.
 */
function flatFrame(app: App): string {
  return (app.lastFrame() ?? '')
    .replace(/[│╭╮╰╯─]/g, ' ')
    .replace(/\s+/g, ' ')
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

/** A leaderboard row the way the page prints it: a heading, a repository, a count. */
const LEADERBOARD_ROW =
  '<a href="/acme/thing/thing">' +
  '<div><span>1</span></div>' +
  '<div><h3>thing</h3><p>acme/thing</p></div>' +
  '<div><span class="font-mono text-sm text-foreground">9.1K</span></div>' +
  '</a>'

/** A skill's own page, where the one-line summary lives. */
const SKILL_PAGE =
  '<h2>Summary</h2><p><strong>Relentless interviewing that stress-tests plans and designs ' +
  'through systematic questioning of every assumption.</strong></p>'

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

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

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
    expect(frame).toContain('Skills')
    // A glyph per section, so nine flat rows are scannable — and the same
    // language the tool lines already speak.
    for (const icon of ['🤖', '🔑', '🧰', '🛡️', '👁️', '📡', '🧠', '📘', '🚪']) {
      expect(frame).toContain(icon)
    }
  })

  it('says what Enter does once, in the footer — never on every row', async () => {
    // The instruction per row was noise that crowded out the values, and it
    // disagreed with itself from row to row: "toggles", "cycles", "change".
    const app = renderSettings()
    expect(app.lastFrame() ?? '').toContain('Enter open')

    for (const section of ['Tools', 'Permissions', 'Display']) {
      await moveTo(app, section)
      await press(app, '\r')
      const frame = app.lastFrame() ?? ''
      expect(frame).toContain('Enter change')
      expect(frame).not.toContain('(Enter')
      await press(app, '\u001b')
    }
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

    // Provider & model, API keys, Web search, permissions, display, browser,
    // gateways, memory, skills, and the exit row at the end
    await moveTo(app, 'Save & exit')
    await press(app, '\r')

    expect(closed).toBe(true)
  })

  it('creates the skills directory and offers the bundled ones and the ranking', async () => {
    const dir = path.join(home, 'skills')
    rmSync(dir, { recursive: true, force: true })
    // The section reads the directory's ranking when it opens, and a test is not
    // the place to reach the network.
    vi.stubGlobal('fetch', async () => new Response(LEADERBOARD_ROW, { status: 200 }))

    const app = renderSettings()
    await waitFor(app, 'Skills')

    // Opening setup makes the place a SKILL.md belongs, before anything is
    // typed into it: an empty directory nobody is told about is not a feature.
    expect(existsSync(dir)).toBe(true)

    // Provider & model, API keys, Web search, permissions, display, gateways,
    // memory
    await moveTo(app, 'Skills')
    await press(app, '\r')
    await press(app, '\r')

    await waitFor(app, dir)
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('skill-creator')
    expect(frame).toContain('How to write a skill for Milo')
    expect(frame).toContain('release-notes')
    expect(frame).toContain('Turn the commits since the last tag')
    expect(frame).toContain('ships with Milo')

    // The directory's row, with what it prints: repository and install count.
    await waitFor(app, 'acme/thing/thing')
    expect(app.lastFrame() ?? '').toContain('9.1K')
  })

  it('keeps the label and the count when a long summary wraps', async () => {
    const dir = path.join(home, 'skills')
    rmSync(dir, { recursive: true, force: true })
    // The listing carries the count; the summary comes from the skill's page,
    // and a real one is a full sentence.
    vi.stubGlobal('fetch', async (input: string | URL) => {
      const url = String(input)
      return new Response(url.includes('/acme/thing/thing') ? SKILL_PAGE : LEADERBOARD_ROW, {
        status: 200,
      })
    })

    const app = renderSettings()
    await waitFor(app, 'Skills')
    await moveTo(app, 'Skills')
    await press(app, '\r')
    await press(app, '\r')

    await waitFor(app, '9.1K')
    const frame = app.lastFrame() ?? ''
    // The row is a layout, not one run of text: wrapping the summary must not
    // push the label or the count off the line.
    expect(frame).toContain('acme/thing/thing')
    expect(frame).toContain('9.1K')
    expect(frame).toContain('Relentless interviewing')
  })

  it('installs what Space picked, and only on Enter', async () => {
    const dir = path.join(home, 'skills')
    rmSync(dir, { recursive: true, force: true })
    vi.stubGlobal('fetch', async () => new Response('<html></html>', { status: 200 }))

    const app = renderSettings()
    await waitFor(app, 'Skills')
    await moveTo(app, 'Skills')
    await press(app, '\r')
    await press(app, '\r')
    await waitFor(app, 'skill-creator')

    // Enter on its own writes nothing: toggling is the decision, and guessing at
    // the row under the cursor would install what was never chosen.
    await press(app, '\r')
    await waitFor(app, 'Nothing to apply')
    expect(existsSync(path.join(dir, 'skill-creator'))).toBe(false)

    // The cursor starts on the first row, which is the first bundled skill.
    await press(app, ' ')
    await press(app, '\r')
    await waitFor(app, 'restart milo')
    expect(existsSync(path.join(dir, 'skill-creator', 'SKILL.md'))).toBe(true)
  })

  it('spins while it is reading the directory', async () => {
    // Never answers, so the waiting state is the one left on screen.
    vi.stubGlobal('fetch', () => new Promise(() => {}))

    const app = renderSettings()
    await waitFor(app, 'Skills')
    await moveTo(app, 'Skills')
    await press(app, '\r')
    await press(app, '\r')

    await waitFor(app, 'Reading')
    // The spinner itself, not just the words: a frozen line reads as a hang.
    expect(app.lastFrame() ?? '').toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Reading https:\/\/skills\.sh/)
  })

  it('installs a picked row from the directory, page to file', async () => {
    const dir = path.join(home, 'skills')
    rmSync(dir, { recursive: true, force: true })
    // The whole path a popular row takes: the skills.sh page resolves to a
    // repository, which resolves to the one SKILL.md.
    vi.stubGlobal('fetch', async (input: string | URL) => {
      const url = String(input)
      if (url.includes('api.github.com')) {
        return new Response(
          JSON.stringify({ tree: [{ path: 'skills/thing/SKILL.md', type: 'blob' }] }),
          { status: 200 },
        )
      }
      if (url.includes('raw.githubusercontent.com')) {
        return new Response('---\nname: thing\ndescription: The thing\n---\n\nDo it.\n', {
          status: 200,
        })
      }
      return new Response(LEADERBOARD_ROW, { status: 200 })
    })

    const app = renderSettings()
    await waitFor(app, 'Skills')
    await moveTo(app, 'Skills')
    await press(app, '\r')
    await press(app, '\r')
    await waitFor(app, 'acme/thing/thing')

    await moveTo(app, 'acme/thing/thing')
    await press(app, ' ')
    await press(app, '\r')

    await waitFor(app, 'restart milo')
    // The outcome is boxed and glyph-marked, so it reads as the result of the write.
    expect(app.lastFrame() ?? '').toContain('✓')
    const file = path.join(dir, 'thing', 'SKILL.md')
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, 'utf8')).toContain('The thing')

    // The row flips to installed, so the screen says what happened instead of
    // dropping the check back to `[ ]` the moment the install finishes.
    expect(app.lastFrame() ?? '').toContain('[x] acme/thing/thing')
    expect(app.lastFrame() ?? '').toContain('installed ·')
  })

  it('names the install while it is in flight', async () => {
    const dir = path.join(home, 'skills')
    rmSync(dir, { recursive: true, force: true })
    let release: (() => void) | undefined
    // The GitHub tree is held open so the in-flight state is the one on screen.
    vi.stubGlobal('fetch', async (input: string | URL) => {
      const url = String(input)
      if (url.includes('api.github.com')) {
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return new Response(
          JSON.stringify({ tree: [{ path: 'skills/thing/SKILL.md', type: 'blob' }] }),
          { status: 200 },
        )
      }
      if (url.includes('raw.githubusercontent.com')) {
        return new Response('---\nname: thing\ndescription: The thing\n---\n\nDo it.\n', {
          status: 200,
        })
      }
      return new Response(LEADERBOARD_ROW, { status: 200 })
    })

    const app = renderSettings()
    await waitFor(app, 'Skills')
    await moveTo(app, 'Skills')
    await press(app, '\r')
    await press(app, '\r')
    await waitFor(app, 'acme/thing/thing')

    await moveTo(app, 'acme/thing/thing')
    await press(app, ' ')
    await press(app, '\r')

    // A round trip the user is paying for has to be named where they wait.
    await waitFor(app, 'Installing acme/thing/thing')
    expect(app.lastFrame() ?? '').toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Installing/)

    release?.()
    await waitFor(app, 'restart milo')
    expect(existsSync(path.join(dir, 'thing', 'SKILL.md'))).toBe(true)
  })

  it('unchecks an installed skill and removes it on the next Enter', async () => {
    const dir = path.join(home, 'skills')
    rmSync(dir, { recursive: true, force: true })
    vi.stubGlobal('fetch', async (input: string | URL) => {
      const url = String(input)
      if (url.includes('api.github.com')) {
        return new Response(
          JSON.stringify({ tree: [{ path: 'skills/thing/SKILL.md', type: 'blob' }] }),
          { status: 200 },
        )
      }
      if (url.includes('raw.githubusercontent.com')) {
        return new Response('---\nname: thing\ndescription: The thing\n---\n\nDo it.\n', {
          status: 200,
        })
      }
      return new Response(LEADERBOARD_ROW, { status: 200 })
    })

    const app = renderSettings()
    await waitFor(app, 'Skills')
    await moveTo(app, 'Skills')
    await press(app, '\r')
    await press(app, '\r')
    await waitFor(app, 'acme/thing/thing')

    await moveTo(app, 'acme/thing/thing')
    await press(app, ' ')
    await press(app, '\r')
    await waitFor(app, 'restart milo')
    expect(existsSync(path.join(dir, 'thing'))).toBe(true)

    // The cursor is still on the row; Space unchecks it, and the row says the
    // unchecking means a removal rather than nothing.
    await press(app, ' ')
    await waitFor(app, 'remove')
    expect(app.lastFrame() ?? '').toContain('[ ] acme/thing/thing')

    await press(app, '\r')
    await waitUntil(() => !existsSync(path.join(dir, 'thing')))
    expect(app.lastFrame() ?? '').toContain('removed — restart milo to drop')
  })

  it('lists an installed skill the ranking never shows, so it can be removed', async () => {
    const dir = path.join(home, 'skills')
    rmSync(dir, { recursive: true, force: true })
    const custom = path.join(dir, 'custom')
    mkdirSync(custom, { recursive: true })
    writeFileSync(
      path.join(custom, 'SKILL.md'),
      '---\nname: custom\ndescription: Something only I have\n---\n\nDo it.\n',
    )
    // No ranking at all: the bundled pair and the one already on disk.
    vi.stubGlobal('fetch', async () => new Response('<html></html>', { status: 200 }))

    const app = renderSettings()
    await waitFor(app, 'Skills')
    await moveTo(app, 'Skills')
    await press(app, '\r')
    await press(app, '\r')

    await waitFor(app, 'custom')
    expect(app.lastFrame() ?? '').toContain('Something only I have')

    // The installed one the catalogue never shows, found by its name.
    await moveTo(app, 'custom')
    await press(app, ' ')
    await press(app, '\r')
    await waitUntil(() => !existsSync(custom))
    expect(app.lastFrame() ?? '').toContain('custom removed')
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

  it('groups the keys, and the cursor skips the group headers', async () => {
    const app = renderSettings()
    await press(app, DOWN)
    await press(app, '\r')
    await waitFor(app, 'API keys')

    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('Providers')
    expect(frame).toContain('Web search')
    expect(frame).toContain('Gateways')

    // Four provider slots, then Tavily: the header in between is not a stop.
    for (let index = 0; index < 4; index += 1) await press(app, DOWN)
    await press(app, '\r')
    await waitFor(app, 'TAVILY_API_KEY')
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

    await moveTo(app, 'Permissions')
    await press(app, '\r')
    await waitFor(app, 'Permissions')

    await press(app, '\r') // Mode row: ask -> auto
    await waitUntil(() => modes.length > 0)

    // The shell owns persistence for the mode; the screen only reports it.
    expect(modes).toEqual(['auto'])
  })

  it('leaves from a section two deep with one key, and says which one', async () => {
    let closed = 0
    const app = renderSettings({
      onClose: () => {
        closed += 1
      },
    })
    await moveTo(app, 'Tools')
    await press(app, '\r')
    await moveTo(app, 'Browser')
    await press(app, '\r')

    // Esc walks up one level, so from here it used to take three presses to get
    // out. The key that ends it outright was always there and never written
    // down — and the title now shows how deep the screen is.
    expect(app.lastFrame() ?? '').toContain('Setup · Tools · Browser')
    expect(app.lastFrame() ?? '').toContain('Ctrl+C exit')

    app.stdin.write('\u0003')
    await tick(40)
    expect(closed).toBe(1)
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
    await moveTo(app, 'Gateways')
    await press(app, '\r')
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
    await moveTo(app, 'Gateways')
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

  it('toggles the thinking display and says it applies everywhere', async () => {
    const app = renderSettings()
    for (let index = 0; index < 4; index += 1) await press(app, DOWN)
    await press(app, '\r')
    await waitFor(app, 'Thinking display')

    await press(app, DOWN)
    await press(app, '\r')

    // on → off
    await waitUntil(() => readJson('config.json').display?.thinking === 'off')
    expect(app.lastFrame()).toContain('applies to every surface')
  })

  it('cycles the reasoning effort', async () => {
    const app = renderSettings()
    for (let index = 0; index < 4; index += 1) await press(app, DOWN)
    await press(app, '\r')
    await waitFor(app, 'Reasoning effort')

    await press(app, DOWN)
    await press(app, DOWN)
    await press(app, '\r')

    // medium → high
    await waitUntil(() => readJson('config.json').reasoningEffort === 'high')
    expect(app.lastFrame()).toContain('applies to every surface')
  })

  it('sets and clears the output ceiling', async () => {
    const app = renderSettings()
    for (let index = 0; index < 4; index += 1) await press(app, DOWN)
    await press(app, '\r')
    await waitFor(app, 'Output limit')

    await press(app, DOWN)
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
    await press(app, DOWN)
    await press(app, '\r')
    await waitFor(app, 'token ceiling')

    app.stdin.write('lots')
    await tick(20)
    app.stdin.write('\r')
    await waitUntil(() => readJson('config.json').maxTokens === undefined)
  })

  it('shows the browser off in the hub while the tools are absent, not idle', async () => {
    const app = renderSettings()
    // The hub says what is set up without opening the section.
    expect(rowFor(app, 'Tools')).toContain('none enabled')

    await moveTo(app, 'Tools')
    await press(app, '\r')
    await moveTo(app, 'Browser')
    await press(app, '\r')
    await waitUntil(() => !(app.lastFrame() ?? '').includes('checking…'))

    // Whether this machine has a browser is not the test's business; that the
    // screen reports the real answer is.
    expect(app.lastFrame() ?? '').toMatch(/no Chrome found|Chromium \d|Chrome \d/)
    expect(app.lastFrame()).toContain('not in the catalog')
  })

  it('lists the browsers it found, so one of them can be chosen', async () => {
    const app = renderSettings()
    await moveTo(app, 'Tools')
    await press(app, '\r')
    await moveTo(app, 'Browser')
    await press(app, '\r')
    await moveTo(app, 'Browser to run')
    await press(app, '\r')
    await waitFor(app, 'Download a Chrome for Testing')

    // Whatever this machine has, the picker is a way to choose it — and the
    // download is always there for a machine that has nothing.
    expect(app.lastFrame()).toContain('Every Chromium on this machine')
    expect(/Chromium|Google Chrome|Brave|Helium|Microsoft Edge|Nothing found/.test(app.lastFrame() ?? '')).toBe(
      true,
    )
  })

  it('offers its own profile, a copy of one here, or a path named by hand', async () => {
    const app = renderSettings()
    await moveTo(app, 'Tools')
    await press(app, '\r')
    await moveTo(app, 'Browser')
    await press(app, '\r')
    await moveTo(app, 'Profile')
    await press(app, '\r')

    const frame = flatFrame(app)
    expect(frame).toContain('Its own')
    expect(frame).toContain('Name a directory')
    // The copy is the only route that works, and the screen says why.
    expect(frame).toContain('never shared')
  })

  it('warns when the profile is one the browser refuses to be debugged on', async () => {
    const app = renderSettings()
    await moveTo(app, 'Tools')
    await press(app, '\r')
    await moveTo(app, 'Browser')
    await press(app, '\r')
    await moveTo(app, 'Profile')
    await press(app, '\r')
    // The row opens the picker now: its own, a copy of one here, or a path typed.
    await moveTo(app, 'Name a directory')
    await press(app, '\r')

    // Built from the platform's own list, so the assertion holds wherever the
    // suite runs rather than only on the machine it was written on.
    const blocked = defaultProfileRoots()[0]!
    app.stdin.write(blocked)
    await tick(20)
    app.stdin.write('\r')

    // The sentence the section explains it with, rather than the notice's own
    // wording: the explanation is the part that stays on screen.
    await waitUntil(() =>
      flatFrame(app).includes('Chrome 136 and later ignore the debugging port there without saying so'),
    )
    expect(readJson('config.json').browser.profileDir).toBe(blocked)
  })

  it('takes a profile of its own without complaint', async () => {
    const app = renderSettings()
    await moveTo(app, 'Tools')
    await press(app, '\r')
    await moveTo(app, 'Browser')
    await press(app, '\r')
    await moveTo(app, 'Profile')
    await press(app, '\r')
    await moveTo(app, 'Name a directory')
    await press(app, '\r')

    app.stdin.write('~/chrome-copy')
    await tick(20)
    app.stdin.write('\r')
    await waitUntil(() => flatFrame(app).includes('cookies from it are what Milo will be signed in with'))

    expect(readJson('config.json').browser.profileDir).toBe('~/chrome-copy')
  })

  it('turns the browser on, which is what adds the tools', async () => {
    const app = renderSettings()
    await moveTo(app, 'Tools')
    await press(app, '\r')
    await moveTo(app, 'Browser')
    await press(app, '\r')
    await press(app, '\r') // the Enabled row

    await waitUntil(() => readJson('config.json').browser.enabled === true)
    expect(app.lastFrame()).toContain('on — the three browser tools')
  })

  it('cycles how many page snapshots stay in context', async () => {
    const app = renderSettings()
    await moveTo(app, 'Tools')
    await press(app, '\r')
    await moveTo(app, 'Browser')
    await press(app, '\r')
    await moveTo(app, 'Snapshots kept')
    await press(app, '\r')

    // 2 → 4: the one direction that changes anything, since the row reads its
    // value from the config the shell hands back.
    await waitUntil(() => readJson('config.json').browser.keepSnapshots === 4)
  })
})
