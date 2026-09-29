import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stringify } from 'yaml'
import { cleanup, render } from 'ink-testing-library'

// Point the app at a throwaway home *before* the config modules load.
const home = mkdtempSync(path.join(tmpdir(), 'milo-shell-layout-'))
process.env.MILO_HOME = home

writeFileSync(
  path.join(home, 'config.yml'),
  stringify(
  {
      provider: 'commandcode',
      model: 'deepseek/deepseek-v4.1-flash',
      providers: { commandcode: { baseURL: 'https://api.commandcode.ai/provider/v1' } },
      gateways: {},
      permissions: { mode: 'ask', allow: [], deny: [], jevThreshold: 0.35, jevTimeoutMs: 1500 },
      classifier: { backend: 'commandcode' },
    },
    null,
    2,
  ),
)

// A turn is sent in these tests, and the wire is not what is under test.
vi.stubGlobal(
  'fetch',
  vi.fn(async () => new Response('nope', { status: 500 })),
)

const { loadConfig } = await import('../src/core/config/load.js')
const { Shell } = await import('../src/gateways/cli/index.js')

const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms))

function resize(app: ReturnType<typeof render>, columns: number, rows: number): void {
  Object.defineProperty(app.stdout, 'columns', { value: columns, configurable: true })
  Object.defineProperty(app.stdout, 'rows', { value: rows, configurable: true })
  app.stdout.emit('resize')
}

/** The header's and the composer's borders are the frame's only rounded rows. */
const TOP_BORDER = /^\s*╭─+╮\s*$/
const BOTTOM_BORDER = /^\s*╰─+╯\s*$/

describe('Shell layout on small terminals', () => {
  afterEach(() => cleanup())

  it('keeps the header on one row, with the effort beside the model', async () => {
    const app = render(<Shell initial={loadConfig()} cwd={home} startScreen="chat" />)
    resize(app, 60, 20)
    await tick()

    const lines = (app.lastFrame() ?? '').split('\n')
    // Borders around exactly one row of text: a header that wraps is one row
    // more than every screen below it budgets for, and the composer pays.
    expect(lines[0]).toMatch(TOP_BORDER)
    expect(lines[2]).toMatch(BOTTOM_BORDER)
    expect(lines[1]).toContain('Milo')
    // Without the vendor prefix: the provider beside it already says enough.
    expect(lines[1]).toContain('deepseek-v4.1-flash')
    expect(lines[1]).not.toContain('deepseek/deepseek')
    expect(lines[1]).toContain('effort medium')

    app.stdin.write('/effort low')
    await tick(20)
    app.stdin.write('\r')
    await tick()

    expect((app.lastFrame() ?? '').split('\n')[1]).toContain('effort low')
  })

  it('keeps the composer intact while a turn runs on a tiny viewport', async () => {
    const app = render(<Shell initial={loadConfig()} cwd={home} startScreen="chat" />)
    resize(app, 44, 12)
    await tick()

    app.stdin.write(
      'uma mensagem bem longa digitada no celular que passa da largura da linha do composer',
    )
    await tick(20)
    app.stdin.write('\r')
    await tick(150)

    const lines = (app.lastFrame() ?? '').split('\n')
    // The frame is the screen: whatever is taller, the terminal cuts off — and
    // what it cut was the bottom of the composer.
    expect(lines.length).toBeLessThanOrEqual(12)
    // Both bordered boxes keep top and bottom borders, one row each.
    expect(lines.filter((line) => TOP_BORDER.test(line))).toHaveLength(2)
    expect(lines.filter((line) => BOTTOM_BORDER.test(line))).toHaveLength(2)
    // Nothing is painted over the composer's bottom border: the status line
    // used to collide with it once a message had been sent.
    expect(
      lines.some((line) => line.includes('─') && /\b(Enter send|last |queued)/.test(line)),
    ).toBe(false)
  })
})
