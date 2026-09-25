import { mkdtempSync, } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from 'ink-testing-library'

// Point the app at a throwaway home *before* the config modules load.
const home = mkdtempSync(path.join(tmpdir(), 'milo-shell-'))
process.env.MILO_HOME = home

const { CONFIG } = vi.hoisted(() => ({
  CONFIG: {
    provider: 'commandcode',
    model: 'some-model',
    providers: { commandcode: { baseURL: 'https://api.commandcode.ai/provider/v1' } },
    memory: {},
    gateways: {},
    permissions: {
      mode: 'ask' as const,
      allow: [],
      deny: [],
      jevThreshold: 0.35,
      jevTimeoutMs: 1500,
    },
  },
}))

// The wizard's only job here is to hand a saved config back, so the shell's
// handoff can be tested without a provider round-trip.
vi.mock('../src/gateways/cli/screens/model-picker', async () => {
  const { Box, Text, useInput } = await import('ink')
  const { writeFileSync: write } = await import('node:fs')
  const path = await import('node:path')

  return {
    ModelPicker: ({ onDone }: { onDone: (config: unknown) => void }) => {
      useInput((_input, key) => {
        if (!key.return) return
        const file = path.join(process.env.MILO_HOME!, 'config.json')
        write(file, JSON.stringify(CONFIG, null, 2))
        onDone(CONFIG)
      })
      return (
        <Box>
          <Text>wizard-stub</Text>
        </Box>
      )
    },
  }
})

const { Shell } = await import('../src/gateways/cli/index.js')

const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms))

/** Waits for the rendered frame to contain `text`, so steps are never raced. */
async function waitFor(lastFrame: () => string | undefined, text: string, timeoutMs = 1500) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if ((lastFrame() ?? '').includes(text)) return
    await tick(20)
  }
  throw new Error(`timed out waiting for ${JSON.stringify(text)}`)
}

afterEach(() => cleanup())

describe('Shell', () => {
  it('continues into the settings hub after the first-run wizard of `milo setup`', async () => {
    // Fresh install: nothing on disk, so the shell starts on the wizard.
    const app = render(
      <Shell initial={null} cwd={home} startScreen="settings" standalone resumeId={undefined} />,
    )
    expect(app.lastFrame()).toContain('wizard-stub')

    app.stdin.write('\r')
    await waitFor(app.lastFrame, 'Save & exit')

    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('Setup')
    expect(frame).toContain('Provider & model')
    expect(frame).toContain('some-model')
    expect(frame).not.toContain('wizard-stub')
  })

  it('leaves the wizard instead of the hub for `milo model`', async () => {
    const app = render(
      <Shell initial={null} cwd={home} startScreen="model" standalone resumeId={undefined} />,
    )
    expect(app.lastFrame()).toContain('wizard-stub')

    app.stdin.write('\r')
    await tick(80)

    expect(app.lastFrame() ?? '').not.toContain('Save & exit')
  })

  /**
   * One `milo` launch, far enough to know which conversation it is in: the
   * wizard hands over, and the header's first right-hand field is the session.
   */
  async function launch(continueSession: boolean): Promise<string> {
    const app = render(
      <Shell
        initial={null}
        cwd={home}
        startScreen="chat"
        continueSession={continueSession}
        resumeId={undefined}
      />,
    )
    app.stdin.write('\r')

    const started = Date.now()
    while (Date.now() - started < 2000) {
      const match = /([a-z]+-[a-z]+-\d{1,3})/.exec(app.lastFrame() ?? '')
      if (match) {
        app.unmount()
        // The runtime closes on unmount, and the next launch reads what it wrote.
        await tick(40)
        return match[1]!
      }
      await tick(20)
    }
    throw new Error('no session id in the header')
  }

  it('opens a new conversation on each run, and `--continue` picks the last one up', async () => {
    const first = await launch(false)
    const second = await launch(false)
    expect(second).not.toBe(first)

    // The way back to the conversation this terminal left, without `/resume`.
    expect(await launch(true)).toBe(second)
  })
})
