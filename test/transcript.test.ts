import { describe, expect, it } from 'vitest'
import { COLOR_PALETTE_IDS } from '../src/core/color-palettes.js'
import { resolveTuiTheme, theme } from '../src/gateways/cli/theme.js'
import {
  buildLines,
  padToBottom,
  visibleWindow,
  wrapText,
  type Item,
  type Line,
} from '../src/gateways/cli/transcript.js'

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

function contrastRatio(a: string, b: string): number {
  const l1 = luminance(a)
  const l2 = luminance(b)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

describe('wrapText', () => {
  it('wraps on word boundaries', () => {
    expect(wrapText('one two three four', 8)).toEqual(['one two', 'three', 'four'])
  })

  it('preserves blank lines and hard-breaks long words', () => {
    expect(wrapText('a\n\nabcdefghij', 4)).toEqual(['a', '', 'abcd', 'efgh', 'ij'])
  })
})

describe('buildLines', () => {
  it("wraps user lines in the composer's band, and colors tool/error lines", () => {
    const lines = buildLines(
      [
        { kind: 'user', text: 'hi' },
        { kind: 'tool', name: 'read_file', detail: 'a.txt', ok: true },
        { kind: 'error', text: 'boom' },
      ],
      40,
    )

    // The person's own line is a filled stripe, like the composer: the surface
    // behind it, and the text drawn on that surface.
    expect(lines[0]).toMatchObject({ text: '› hi', color: theme.surfaceText, background: theme.surface })
    expect(lines.find((line) => line.text.includes('read_file'))).toMatchObject({
      color: theme.muted,
    })
    expect(lines.find((line) => line.text.startsWith('error:'))).toMatchObject({
      color: theme.danger,
    })
  })

  it('gives web_search its own icon and keeps the marker for other tools', () => {
    const lines = buildLines(
      [
        { kind: 'tool', name: 'web_search', detail: 'bun 1.2', ok: true },
        { kind: 'tool', name: 'read_file', detail: 'a.txt', ok: true },
        { kind: 'tool', name: 'web_search', detail: 'bun 1.2', ok: false },
      ],
      40,
    )

    // Consecutive tool lines sit together; the icons are what matters, and the
    // line carries the same shape a chat surface shows: icon, name, value.
    expect(lines.filter((line) => line.text !== '').map((line) => line.text)).toEqual([
      '🌐 web_search bun 1.2',
      '📄 read_file a.txt',
      '✗ web_search bun 1.2',
    ])
  })

  it('shows only the name when there is no detail to show', () => {
    const lines = buildLines([{ kind: 'tool', name: 'read_file', detail: '', ok: true }], 40)

    expect(lines.map((line) => line.text)).toEqual(['📄 read_file'])
  })

  it('names a tool from an external server by its server and its own name', () => {
    const lines = buildLines(
      [{ kind: 'tool', name: 'mcp__github__create_issue', detail: 'leak', ok: true }],
      40,
    )

    const line = lines.find((entry) => entry.text.includes('create_issue'))!
    expect(line.text).toBe('🔌 github: create_issue leak')
    expect(line.segments?.find((segment) => segment.bold)?.text).toBe('github: create_issue')
  })

  it('bolds the tool name so it does not read as the start of the arguments', () => {
    const lines = buildLines([{ kind: 'tool', name: 'read_file', detail: 'a.txt', ok: true }], 40)
    const line = lines.find((entry) => entry.text.includes('read_file'))!

    expect(line.segments).toEqual([
      { text: '📄 ' },
      { text: 'read_file', bold: true },
      { text: ' a.txt' },
    ])
    // The plain text stays intact for the window and the tests around it.
    expect(line.text).toBe('📄 read_file a.txt')
  })

  it('keeps the name bold in a failure line', () => {
    const lines = buildLines(
      [{ kind: 'tool', name: 'web_search', detail: 'x', ok: false }],
      40,
    )
    const line = lines.find((entry) => entry.text.includes('web_search'))!
    expect(line.segments?.find((segment) => segment.bold)?.text).toBe('web_search')
  })

  it('leaves lines without a tool name unstyled', () => {
    const lines = buildLines([{ kind: 'assistant', text: 'hello' }], 40)
    expect(lines[0]?.segments).toBeUndefined()
  })

  it('keeps consecutive tool calls together, with no blank line between', () => {
    const lines = buildLines(
      [
        { kind: 'tool', name: 'fetch_url', detail: 'one', ok: true },
        { kind: 'tool', name: 'fetch_url', detail: 'two', ok: true },
      ],
      40,
    )

    expect(lines.map((line) => line.text)).toEqual(['🔗 fetch_url one', '🔗 fetch_url two'])
  })

  it('still separates a tool call from the prose around it', () => {
    const lines = buildLines(
      [
        { kind: 'assistant', text: 'let me look' },
        { kind: 'tool', name: 'read_file', detail: 'a.txt', ok: true },
      ],
      40,
    )

    expect(lines.map((line) => line.text)).toEqual(['let me look', '', '📄 read_file a.txt'])
  })
})

describe('markdown in the terminal', () => {
  const assistant = (text: string, width = 40) =>
    buildLines([{ kind: 'assistant', text }], width)

  it('shows a subtle language label line when present and keeps the code as it was written', () => {
    const lines = assistant('Here:\n\n```ts\nconst a = 1\n  indented()\n```\n')

    expect(lines.map((line) => line.text)).toEqual([
      'Here:',
      '',
      'ts',
      'const a = 1',
      '  indented()',
      '',
    ])
    expect(lines.find((line) => line.text === 'ts')).toMatchObject({
      color: theme.muted,
      dim: true,
    })
    expect(lines.find((line) => line.text === 'const a = 1')).toMatchObject({
      color: theme.muted,
    })
  })

  it('does not read markdown inside a fence as markdown', () => {
    const lines = assistant('```\n**not bold** and `not code`\n```')

    expect(lines[0]).toMatchObject({ text: '**not bold** and `not code`', color: theme.muted })
  })

  it('drops the markers of inline code and bold', () => {
    const lines = assistant('Use `npm test` and **careful** here')

    expect(lines[0]?.text).toBe('Use npm test and careful here')
    // The space between runs rides with the run that follows it, which is what
    // lets a wrap drop it.
    expect(lines[0]?.segments).toEqual([
      { text: 'Use' },
      { text: ' npm test', color: theme.success },
      { text: ' and' },
      { text: ' careful', bold: true },
      { text: ' here' },
    ])
  })

  it('does not add a space before punctuation that followed a span', () => {
    const lines = assistant('Use `npm test`.')

    expect(lines[0]?.text).toBe('Use npm test.')
  })

  it('keeps a span bold when it wraps', () => {
    const lines = assistant(`**${'boldword '.repeat(8).trim()}**`, 20)

    expect(lines.length).toBeGreaterThan(1)
    expect(lines.every((line) => line.segments?.every((segment) => segment.bold))).toBe(true)
  })

  it('renders a heading without its hashes', () => {
    const lines = assistant('## Notes\nbody')

    expect(lines[0]?.text).toBe('Notes')
    expect(lines[0]?.segments?.[0]).toMatchObject({ bold: true })
    expect(lines[1]?.text).toBe('body')
  })

  it('cuts a line of code at the width instead of overflowing', () => {
    const lines = assistant(`\`\`\`\n${'x'.repeat(50)}\n\`\`\``, 20)

    expect(lines.map((line) => line.text)).toEqual(['x'.repeat(20), 'x'.repeat(20), 'x'.repeat(10)])
  })
})

describe('fields', () => {
  it('lines the values up in a column, with the labels receding', () => {
    const lines = buildLines(
      [
        {
          kind: 'fields',
          rows: [
            { label: 'session', value: 'calm-otter-7' },
            { label: 'context', value: '42 messages · 12 turns' },
          ],
        },
      ],
      40,
    )

    expect(lines.map((line) => line.text)).toEqual([
      'session  calm-otter-7',
      'context  42 messages · 12 turns',
    ])
    expect(lines[0]?.segments).toEqual([
      { text: 'session', color: theme.muted },
      { text: '  calm-otter-7' },
    ])
  })

  it('hangs a wrapped value under itself, not under the next label', () => {
    const lines = buildLines(
      [
        {
          kind: 'fields',
          rows: [{ label: 'session', value: 'a fairly long title that has to wrap somewhere' }],
        },
      ],
      30,
    )

    expect(lines.length).toBeGreaterThan(1)
    const hang = ' '.repeat('session'.length + 2)
    for (const line of lines.slice(1)) {
      expect(line.text.startsWith(hang)).toBe(true)
      expect(line.text.length).toBeLessThanOrEqual(30)
    }
  })
})

describe('visibleWindow', () => {
  const lines: Line[] = Array.from({ length: 10 }, (_, index) => ({ text: `L${index}` }))

  it('anchors to the bottom by default', () => {
    const result = visibleWindow(lines, 3, 0)
    expect(result.lines.map((line) => line.text)).toEqual(['L7', 'L8', 'L9'])
    expect(result.maxOffset).toBe(7)
  })

  it('scrolls up and clamps to the top', () => {
    expect(visibleWindow(lines, 3, 2).lines.map((line) => line.text)).toEqual(['L5', 'L6', 'L7'])
    expect(visibleWindow(lines, 3, 999).lines.map((line) => line.text)).toEqual(['L0', 'L1', 'L2'])
  })
})

describe('padToBottom', () => {
  it('pads the top with blank lines so content hugs the bottom', () => {
    expect(padToBottom([{ text: 'a' }], 3).map((line) => line.text)).toEqual(['', '', 'a'])
  })

  it('leaves overflowing content untouched', () => {
    const lines: Line[] = [{ text: 'a' }, { text: 'b' }, { text: 'c' }]
    expect(padToBottom(lines, 2)).toHaveLength(3)
  })
})

describe('rich markdown and transcript items', () => {
  it('renders unordered and ordered lists with hanging indentation', () => {
    const lines = buildLines(
      [
        {
          kind: 'assistant',
          text: '- first item with **bold** words that wrap cleanly\n* second item\n1. ordered item that wraps onto the next line',
        },
      ],
      26,
    )

    expect(lines[0]?.text.startsWith('• ')).toBe(true)
    expect(lines[1]?.text.startsWith('  ')).toBe(true)
    expect(lines.some((line) => line.text.startsWith('• second item'))).toBe(true)
    const orderedIdx = lines.findIndex((line) => line.text.startsWith('1. '))
    expect(orderedIdx).toBeGreaterThan(-1)
    expect(lines[orderedIdx + 1]?.text.startsWith('   ')).toBe(true)
  })

  it('renders blockquotes with a hanging accent bar and muted text', () => {
    const lines = buildLines(
      [{ kind: 'assistant', text: '> quoted sentence that wraps across two terminal lines' }],
      26,
    )

    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) {
      expect(line.text.startsWith('▎ ')).toBe(true)
      expect(line.segments?.[0]).toEqual({ text: '▎ ', color: theme.secondary })
    }
  })

  it('renders ui, panel, and steer items without box borders or rules', () => {
    const lines = buildLines(
      [
        { kind: 'ui', title: 'Summary', summary: '3 tasks ready' },
        { kind: 'panel', detail: 'Opened panel: src/index.ts' },
        { kind: 'steer', text: 'focus on the parser first and skip formatting' },
      ],
      30,
    )

    const joined = lines.map((line) => line.text).join('\n')
    expect(joined).toContain('Summary')
    expect(joined).toContain('3 tasks ready')
    expect(joined).toContain('Opened panel: src/index.ts')
    expect(joined).toContain('↳ steered: focus on')
    expect(joined).not.toMatch(/[─╭╰╮╯]/)
  })

  it('renders expanded tool args, diff changes, and results with sensible truncation', () => {
    const longResult = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join('\n')
    const lines = buildLines(
      [
        {
          kind: 'tool',
          name: 'edit_file',
          detail: 'src/app.ts',
          ok: true,
          counts: '+1 −1',
          args: { path: 'src/app.ts', oldText: 'const a = 1', newText: 'const a = 2' },
          change: [
            {
              path: 'src/app.ts',
              additions: 1,
              deletions: 1,
              lines: [
                { kind: 'remove', text: 'const a = 1', old: 1 },
                { kind: 'add', text: 'const a = 2', new: 1 },
              ],
            },
          ],
          result: longResult,
          expanded: true,
        },
      ],
      60,
    )

    expect(lines[0]?.text).toBe('✏️ edit_file src/app.ts +1 −1')
    expect(lines.some((line) => line.text.includes('"path": "src/app.ts"'))).toBe(true)
    expect(lines.find((line) => line.text === '  - const a = 1')).toMatchObject({ color: theme.danger })
    expect(lines.find((line) => line.text === '  + const a = 2')).toMatchObject({ color: theme.success })
    expect(lines.some((line) => line.text.includes('result truncated'))).toBe(true)
    expect(lines.map((line) => line.text).join('\n')).not.toMatch(/[─╭╰╮╯]/)
  })

  it('keeps unexpanded tools to their single summary line even when detail fields are present', () => {
    const lines = buildLines(
      [
        {
          kind: 'tool',
          name: 'read_file',
          detail: 'a.txt',
          ok: true,
          args: { path: 'a.txt' },
          result: 'secret body',
        },
      ],
      40,
    )

    expect(lines.map((line) => line.text)).toEqual(['📄 read_file a.txt'])
  })

  it('memoizes rendered lines per item across streaming updates and invalidates on width or theme change', () => {
    const fixed: Item = { kind: 'assistant', text: 'Completed turn **answer**.' }
    const first = buildLines([fixed, { kind: 'assistant', text: 'streaming 1' }], 40)
    const second = buildLines([fixed, { kind: 'assistant', text: 'streaming 1 2' }], 40)

    expect(second[0]).toBe(first[0])

    const narrower = buildLines([fixed], 12)
    expect(narrower[0]).not.toBe(first[0])

    const rethemed = buildLines([fixed], 40, resolveTuiTheme('ocean'))
    expect(rethemed[0]).not.toBe(first[0])
  })
})

describe('resolveTuiTheme', () => {
  it('returns the base theme when unset and maps every palette ID to an accessible accent', () => {
    expect(resolveTuiTheme()).toEqual(theme)

    for (const id of COLOR_PALETTE_IDS) {
      const resolved = resolveTuiTheme(id)
      expect(resolved.secondary).toBe(theme.secondary)
      expect(resolved.surface).toBe(theme.surface)
      expect(contrastRatio(resolved.accent, '#FFFCF0')).toBeGreaterThanOrEqual(4.4)
      expect(contrastRatio(resolved.accent, '#100F0F')).toBeGreaterThanOrEqual(4.0)
    }
  })

  it('applies activeTheme colors inside buildLines', () => {
    const ocean = resolveTuiTheme('ocean')
    const lines = buildLines([{ kind: 'todo', items: [{ content: 'Run', status: 'in_progress' }] }], 40, ocean)
    expect(lines[0]).toMatchObject({ color: ocean.accent })
  })
})
