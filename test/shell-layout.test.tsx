import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { stripVTControlCharacters as stripAnsi } from 'node:util'
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

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForFrame(app: ReturnType<typeof render>, check: (frame: string) => boolean, timeoutMs = 4000): Promise<string> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const frame = app.lastFrame() ?? ''
    if (check(frame)) return frame
    await tick(20)
  }
  throw new Error(`timed out waiting for frame:\n${app.lastFrame() ?? ''}`)
}

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
    const initial = await waitForFrame(app, (frame) => frame.includes('effort medium'))

    const lines = initial.split('\n')
    // The chat has no header: the knobs live in the band under the composer, the
    // frame's last row — so the transcript keeps the top of the screen.
    const band = lines.at(-1) ?? ''
    // Without the vendor prefix: the provider beside it already says enough.
    expect(band).toContain('deepseek-v4.1-flash')
    expect(band).not.toContain('deepseek/deepseek')
    expect(band).toContain('effort medium')

    app.stdin.write('/effort low')
    await waitForFrame(app, (frame) => frame.includes('/effort low'))
    app.stdin.write('\r')
    const updated = await waitForFrame(app, (frame) => (frame.split('\n').at(-1) ?? '').includes('effort low'))

    expect(updated.split('\n').at(-1)).toContain('effort low')
  })

  it('keeps the filled composer intact while a turn runs on a tiny viewport', async () => {
    const app = render(<Shell initial={loadConfig()} cwd={home} startScreen="chat" />)
    resize(app, 44, 12)
    await waitForFrame(app, (frame) => frame.includes('› '))

    app.stdin.write(
      'uma mensagem bem longa digitada no celular que passa da largura da linha do composer',
    )
    await waitForFrame(app, (frame) => frame.includes('celular'))
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

  it('keeps multiline composer within the viewport height without borders', async () => {
    const app = render(<Shell initial={loadConfig()} cwd={home} startScreen="chat" />)
    resize(app, 44, 12)
    await waitForFrame(app, (frame) => frame.includes('› '))

    app.stdin.write('line one')
    await waitForFrame(app, (frame) => frame.includes('line one'))
    app.stdin.write('\u001b[13;2u')
    await tick(20)
    app.stdin.write('line two')
    await waitForFrame(app, (frame) => frame.includes('line two'))
    app.stdin.write('\u001b[13;2u')
    await tick(20)
    app.stdin.write('line three')
    const multiline = await waitForFrame(app, (frame) => frame.includes('line three'))

    const lines = multiline.split('\n')
    expect(lines.length).toBeLessThanOrEqual(12)
    expect(lines.filter((line) => ROUNDED.test(line))).toHaveLength(0)
    expect(lines.some((line) => line.includes('─'))).toBe(false)
    expect(lines.some((line) => line.includes('line one'))).toBe(true)
    expect(lines.some((line) => line.includes('line three'))).toBe(true)
  })

  it('shows the adaptive empty-state hero and ● MILO badge without box borders', async () => {
    const app = render(<Shell initial={loadConfig()} cwd={home} startScreen="chat" />)
    resize(app, 70, 22)
    const normalFrame = stripAnsi(await waitForFrame(app, (frame) => stripAnsi(frame).includes('▄▄█████▄')))
    expect(normalFrame).toContain('▄▄█████▄')
    expect(normalFrame).toContain('▄██████▀')
    expect(normalFrame).toContain('▀█████▀')
    expect(normalFrame).toContain('MILO')
    expect(normalFrame).toContain('deepseek-v4.1-flash')
    expect(normalFrame).toContain('Default directory')
    expect(normalFrame).not.toContain('● Ready')
    expect(normalFrame).not.toMatch(/[─╭╰╮╯│]/)

    resize(app, 42, 12)
    const tinyFrame = stripAnsi(await waitForFrame(app, (frame) => stripAnsi(frame).includes('MILO · ready')))
    expect(tinyFrame.split('\n').length).toBeLessThanOrEqual(12)
    expect(tinyFrame).toContain('MILO · ready')
    expect(tinyFrame).not.toContain('▄▄█████▄')
    expect(tinyFrame).not.toMatch(/[─╭╰╮╯│]/)
  })

  it('draws the ● MILO status badge in the non-chat Shell header', async () => {
    const app = render(<Shell initial={loadConfig()} cwd={home} startScreen="settings" />)
    resize(app, 80, 24)
    const frame = stripAnsi(await waitForFrame(app, (frame) => stripAnsi(frame).includes('● ▀▄ MILO')))

    const headerLine = frame.split('\n')[0] ?? ''
    expect(headerLine).toContain('● ▀▄ MILO')
    expect(headerLine).toContain('deepseek-v4.1-flash')
  })
})
