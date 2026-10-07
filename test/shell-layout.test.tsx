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

/**
 * No row carries a rounded box any more: the composer is a filled bar, delimited
 * by its own surface rather than by borders. The frame under test must draw none.
 */
const ROUNDED = /^\s*[╭╰]─+[╮╯]\s*$/

describe('Shell layout on small terminals', () => {
  afterEach(() => cleanup())

  it('keeps the status band on the last row, with the effort beside the model', async () => {
    const app = render(<Shell initial={loadConfig()} cwd={home} startScreen="chat" />)
    resize(app, 60, 20)
    await tick()

    const lines = (app.lastFrame() ?? '').split('\n')
    // The chat has no header: the knobs live in the band under the composer, the
    // frame's last row — so the transcript keeps the top of the screen.
    const band = lines.at(-1) ?? ''
    // Without the vendor prefix: the provider beside it already says enough.
    expect(band).toContain('deepseek-v4.1-flash')
    expect(band).not.toContain('deepseek/deepseek')
    expect(band).toContain('effort medium')

    app.stdin.write('/effort low')
    await tick(20)
    app.stdin.write('\r')
    await tick()

    expect((app.lastFrame() ?? '').split('\n').at(-1)).toContain('effort low')
  })

  it('keeps the filled composer intact while a turn runs on a tiny viewport', async () => {
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
    // The composer is a filled bar, so nothing in the frame is boxed.
    expect(lines.filter((line) => ROUNDED.test(line))).toHaveLength(0)
    expect(lines.some((line) => line.includes('─'))).toBe(false)
    // The composer survives below the status line, its prompt drawn whole: a
    // status/counter row painted onto it is what this guards against.
    expect(lines.some((line) => /› /.test(line))).toBe(true)
  })
})
