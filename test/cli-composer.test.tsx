import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from 'ink-testing-library'
import { COMMAND_CATALOG } from '../src/gateways/command-catalog.js'
import { Composer, type ComposerProps } from '../src/gateways/cli/components/composer.js'

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

const LEFT = '\u001b[D'
const RIGHT = '\u001b[C'
const UP = '\u001b[A'
const DOWN = '\u001b[B'
const HOME = '\u001b[H'
const END = '\u001b[F'
const DEL = '\u001b[3~'
const ALT_LEFT = '\u001b[1;3D'
const ALT_RIGHT = '\u001b[1;3C'
const ALT_UP = '\u001b[1;3A'
const ALT_DOWN = '\u001b[1;3B'
const SHIFT_ENTER = '\u001b[13;2u'
const CTRL_ENTER = '\u001b[13;5u'
const ALT_ENTER = '\u001b\r'
const CTRL_A = '\u0001'
const CTRL_E = '\u0005'
const CTRL_J = '\n'
const CTRL_J_KITTY = '\u001b[106;5u'
const CTRL_K = '\u000b'
const CTRL_U = '\u0015'
const CTRL_W = '\u0017'
const BACKSPACE = '\u007f'
const TAB = '\t'
const ESC = '\u001b'

interface HarnessProps extends Omit<ComposerProps, 'value' | 'onChange'> {
  initialValue?: string
}

function Harness({ initialValue = '', ...props }: HarnessProps) {
  const [value, setValue] = useState(initialValue)
  return <Composer value={value} onChange={setValue} {...props} />
}

async function send(stdin: { write: (data: string) => void }, seq: string, ms = 25): Promise<void> {
  stdin.write(seq)
  await tick(ms)
}

afterEach(() => cleanup())

describe('Composer', () => {
  it('renders a filled bar with the prompt prefix, placeholder, cursor cell, and no borders', () => {
    const { lastFrame, rerender } = render(
      <Composer
        value=""
        onChange={() => {}}
        onSubmit={() => {}}
        onRecallHistory={() => {}}
        columns={60}
      />,
    )
    const frame = lastFrame() ?? ''
    const lines = frame.split('\n')

    expect(lines).toHaveLength(3)
    expect(frame).toContain('›  Type a message or @file…')
    expect(frame).not.toContain('─')
    expect(frame).not.toMatch(/[╭╰╮╯]/)

    rerender(
      <Composer
        value=""
        onChange={() => {}}
        onSubmit={() => {}}
        onRecallHistory={() => {}}
        disabled
        columns={60}
      />,
    )
    expect(lastFrame()).toContain('› Type a message or @file…')
  })

  it('submits typed text with steer=false on Enter', async () => {
    const submissions: Array<{ text: string; steer: boolean }> = []
    const { stdin } = render(
      <Harness
        columns={60}
        onSubmit={(text, steer) => submissions.push({ text, steer })}
        onRecallHistory={() => {}}
      />,
    )

    await send(stdin, 'hello milo')
    await send(stdin, '\r')

    expect(submissions).toEqual([{ text: 'hello milo', steer: false }])
  })

  it('submits with steer=true on Ctrl+Enter and Alt+Enter without inserting newlines', async () => {
    const submissions: Array<{ text: string; steer: boolean }> = []
    const { stdin } = render(
      <Harness
        columns={60}
        initialValue="steer now"
        onSubmit={(text, steer) => submissions.push({ text, steer })}
        onRecallHistory={() => {}}
      />,
    )

    await send(stdin, CTRL_ENTER)
    await send(stdin, ALT_ENTER)

    expect(submissions).toEqual([
      { text: 'steer now', steer: true },
      { text: 'steer now', steer: true },
    ])
  })

  it('inserts a newline without submitting on Shift+Enter and Ctrl+J', async () => {
    const submissions: Array<{ text: string; steer: boolean }> = []
    const { stdin, lastFrame } = render(
      <Harness
        columns={60}
        onSubmit={(text, steer) => submissions.push({ text, steer })}
        onRecallHistory={() => {}}
      />,
    )

    await send(stdin, 'line1')
    await send(stdin, SHIFT_ENTER)
    await send(stdin, 'line2')
    await send(stdin, CTRL_J)
    await send(stdin, 'line3')
    await send(stdin, CTRL_J_KITTY)
    await send(stdin, 'line4')

    expect(submissions).toEqual([])
    const frame = lastFrame() ?? ''
    expect(frame).toContain('› line1')
    expect(frame).toContain('  line2')
    expect(frame).toContain('  line3')
    expect(frame).toContain('  line4')

    await send(stdin, '\r')
    expect(submissions).toEqual([{ text: 'line1\nline2\nline3\nline4', steer: false }])
  })

  it('inserts multiline bracketed paste text without submitting, even across chunks', async () => {
    const submissions: Array<{ text: string; steer: boolean }> = []
    const { stdin, lastFrame } = render(
      <Harness
        columns={60}
        onSubmit={(text, steer) => submissions.push({ text, steer })}
        onRecallHistory={() => {}}
      />,
    )

    await send(stdin, 'prefix ')
    await send(stdin, '\u001b[200~first pasted\n')
    await send(stdin, 'second pasted\u001b[201~')

    expect(submissions).toEqual([])
    const frame = lastFrame() ?? ''
    expect(frame).toContain('› prefix first pasted')
    expect(frame).toContain('  second pasted')

    await send(stdin, '\r')
    expect(submissions).toEqual([{ text: 'prefix first pasted\nsecond pasted', steer: false }])
  })

  it('supports cursor movement and line editing shortcuts', async () => {
    const submissions: Array<{ text: string; steer: boolean }> = []
    const { stdin } = render(
      <Harness
        columns={60}
        onSubmit={(text, steer) => submissions.push({ text, steer })}
        onRecallHistory={() => {}}
      />,
    )

    await send(stdin, 'alpha beta gamma')
    await send(stdin, ALT_LEFT) // before gamma
    await send(stdin, CTRL_K) // kill "gamma" -> "alpha beta "
    await send(stdin, CTRL_W) // delete "beta " -> "alpha "
    await send(stdin, HOME)
    await send(stdin, RIGHT)
    await send(stdin, DEL) // delete 'l' -> "apha "
    await send(stdin, END)
    await send(stdin, BACKSPACE) // delete trailing space -> "apha"
    await send(stdin, '\r')
    expect(submissions[0]?.text).toBe('apha')

    // Also test Ctrl+A, Ctrl+E, Alt+Right, and Ctrl+U
    await send(stdin, CTRL_A)
    await send(stdin, CTRL_U) // at start: no-op
    await send(stdin, ALT_RIGHT)
    await send(stdin, CTRL_U) // clears "apha"
    await send(stdin, 'one two')
    await send(stdin, LEFT)
    await send(stdin, LEFT)
    await send(stdin, 'X')
    await send(stdin, CTRL_E)
    await send(stdin, '!')
    await send(stdin, '\r')
    expect(submissions[1]?.text).toBe('one tXwo!')
  })

  it('moves up and down across multiline and wrapped lines before recalling history', async () => {
    const recalls: Array<-1 | 1> = []
    const submissions: Array<{ text: string; steer: boolean }> = []
    const { stdin } = render(
      <Harness
        columns={24}
        initialValue={'first line\nsecond'}
        onSubmit={(text, steer) => submissions.push({ text, steer })}
        onRecallHistory={(dir) => recalls.push(dir)}
      />,
    )

    // Cursor starts at end of "second" (row 1). Up moves to row 0, not history.
    await send(stdin, UP)
    expect(recalls).toEqual([])
    await send(stdin, '!')
    // Now on row 0; Up recalls history (-1).
    await send(stdin, UP)
    expect(recalls).toEqual([-1])

    // Move down to row 1; Down recalls history (+1).
    await send(stdin, DOWN)
    await send(stdin, DOWN)
    expect(recalls).toEqual([-1, 1])

    await send(stdin, '\r')
    // "second" length is 6 -> col 6 on "first line" inserts '!' after "first "
    expect(submissions[0]?.text).toBe('first !line\nsecond')
  })

  it('auto-expands up to 6 text lines (8 total rows) and keeps height capped beyond that', async () => {
    const eightLines = Array.from({ length: 8 }, (_, idx) => `row ${idx + 1}`).join('\n')
    const { lastFrame, rerender } = render(
      <Composer
        value={'one\ntwo\nthree'}
        onChange={() => {}}
        onSubmit={() => {}}
        onRecallHistory={() => {}}
        columns={50}
      />,
    )

    expect((lastFrame() ?? '').split('\n')).toHaveLength(5) // 3 text lines + 2 padding rows

    rerender(
      <Composer
        value={eightLines}
        onChange={() => {}}
        onSubmit={() => {}}
        onRecallHistory={() => {}}
        columns={50}
      />,
    )
    await tick()

    const lines = (lastFrame() ?? '').split('\n')
    expect(lines).toHaveLength(8) // 6 text lines cap + 2 padding rows
    expect(lines.join('\n')).toContain('row 8')
  })

  it('forwards Alt+Up and Alt+Down to onScroll without triggering history recall', async () => {
    const scrolls: number[] = []
    const recalls: number[] = []
    const { stdin } = render(
      <Harness
        columns={50}
        onSubmit={() => {}}
        onRecallHistory={(dir) => recalls.push(dir)}
        onScroll={(delta) => scrolls.push(delta)}
      />,
    )

    await send(stdin, ALT_UP)
    await send(stdin, ALT_DOWN)

    expect(scrolls).toEqual([1, -1])
    expect(recalls).toEqual([])
  })

  it('shows slash command autocomplete, completes on Tab, and submits exact commands on Enter', async () => {
    const submissions: Array<{ text: string; steer: boolean }> = []
    const { stdin, lastFrame } = render(
      <Harness
        columns={70}
        commands={COMMAND_CATALOG}
        onSubmit={(text, steer) => submissions.push({ text, steer })}
        onRecallHistory={() => {}}
      />,
    )

    await send(stdin, '/mo')
    const popupFrame = lastFrame() ?? ''
    expect(popupFrame).toContain('/mode')
    expect(popupFrame).toContain('/model')

    // Move down to /model and complete with Tab (inserts "/model ")
    await send(stdin, DOWN)
    await send(stdin, TAB)
    await send(stdin, 'gpt-5')
    expect(lastFrame()).toContain('› /model gpt-5')

    // Clear and test exact match Enter submission (/help)
    await send(stdin, CTRL_U)
    await send(stdin, '/help')
    await send(stdin, '\r')
    expect(submissions).toEqual([{ text: '/help', steer: false }])
  })

  it('dismisses the command popup on Esc and completes partial command on Enter', async () => {
    const submissions: Array<{ text: string; steer: boolean }> = []
    const { stdin, lastFrame } = render(
      <Harness
        columns={70}
        commands={COMMAND_CATALOG}
        onSubmit={(text, steer) => submissions.push({ text, steer })}
        onRecallHistory={() => {}}
      />,
    )

    await send(stdin, '/ef')
    expect(lastFrame()).toContain('/effort')
    await send(stdin, '\r')
    expect(submissions).toEqual([])
    await send(stdin, 'low')
    expect(lastFrame()).toContain('› /effort low')

    // Esc dismisses popup when open
    await send(stdin, CTRL_U)
    await send(stdin, '/mo')
    expect(lastFrame()).toContain('/mode')
    await send(stdin, ESC)
    await tick(30)
    expect(lastFrame()).not.toContain('permission mode')
  })

  it('shows @file suggestions and inserts @path on Tab or Enter, while ignoring emails', async () => {
    const suggestFiles = vi.fn(async (query: string) =>
      ['src/gateways/cli/keys.ts', 'src/gateways/cli/theme.ts', 'README.md'].filter((file) =>
        file.toLowerCase().includes(query.toLowerCase()),
      ),
    )
    const submissions: Array<{ text: string; steer: boolean }> = []
    const { stdin, lastFrame } = render(
      <Harness
        columns={70}
        suggestFiles={suggestFiles}
        onSubmit={(text, steer) => submissions.push({ text, steer })}
        onRecallHistory={() => {}}
      />,
    )

    await send(stdin, 'email me@example.com', 40)
    expect(suggestFiles).not.toHaveBeenCalled()
    await send(stdin, CTRL_U)

    await send(stdin, 'check @cli/', 50)
    const frame = lastFrame() ?? ''
    expect(suggestFiles).toHaveBeenCalledWith('cli/')
    expect(frame).toContain('@src/gateways/cli/keys.ts')
    expect(frame).toContain('@src/gateways/cli/theme.ts')

    await send(stdin, DOWN)
    await send(stdin, '\r')
    expect(submissions).toEqual([])
    await send(stdin, 'please')
    expect(lastFrame()).toContain('› check @src/gateways/cli/theme.ts please')

    await send(stdin, '\r')
    expect(submissions).toEqual([{ text: 'check @src/gateways/cli/theme.ts please', steer: false }])
  })

  it('navigates up and down across soft-wrapped lines within one paragraph', async () => {
    const recalls: number[] = []
    const submissions: Array<{ text: string; steer: boolean }> = []
    const { stdin, lastFrame } = render(
      <Harness
        columns={22}
        initialValue="alpha bravo charlie delta"
        onSubmit={(text, steer) => submissions.push({ text, steer })}
        onRecallHistory={(dir) => recalls.push(dir)}
      />,
    )

    // At columns=22, textWidth=15 so the text wraps across multiple visual rows.
    expect((lastFrame() ?? '').split('\n').length).toBeGreaterThan(3)

    await send(stdin, UP)
    expect(recalls).toEqual([])
    await send(stdin, '*')
    await send(stdin, '\r')
    expect(submissions[0]?.text).not.toBe('alpha bravo charlie delta*')
    expect(submissions[0]?.text).toContain('*')
  })

  it('puts cursor at the end when value changes externally via history recall', async () => {
    const submissions: Array<{ text: string; steer: boolean }> = []
    function RecallHarness() {
      const [value, setValue] = useState('')
      return (
        <Composer
          value={value}
          onChange={setValue}
          onSubmit={(text, steer) => submissions.push({ text, steer })}
          onRecallHistory={() => setValue('recalled prompt')}
          columns={60}
        />
      )
    }

    const { stdin } = render(<RecallHarness />)
    await send(stdin, UP)
    await send(stdin, '!')
    await send(stdin, '\r')
    expect(submissions).toEqual([{ text: 'recalled prompt!', steer: false }])
  })

  it('ignores input when disabled', async () => {
    const onChange = vi.fn()
    const onSubmit = vi.fn()
    const { stdin } = render(
      <Composer
        value="locked"
        onChange={onChange}
        onSubmit={onSubmit}
        onRecallHistory={() => {}}
        disabled
        columns={60}
      />,
    )

    await send(stdin, 'abc')
    await send(stdin, '\r')
    expect(onChange).not.toHaveBeenCalled()
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
