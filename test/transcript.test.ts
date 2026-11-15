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
    expect(lines.find((line) => line.text.includes('Read a.txt'))).toMatchObject({
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
      '🌐 Searched web bun 1.2',
      '📄 Read a.txt',
      '✗ Searched web bun 1.2',
    ])
  })

  it('shows only the name when there is no detail to show', () => {
    const lines = buildLines([{ kind: 'tool', name: 'read_file', detail: '', ok: true }], 40)

    expect(lines.map((line) => line.text)).toEqual(['📄 Read'])
  })

  it('shows a shell command directly when it has a command, and Shell when it does not', () => {
    const lines = buildLines(
      [
        { kind: 'tool', name: 'shell_command', detail: 'npm test', ok: true },
        { kind: 'tool', name: 'shell_command', detail: '', ok: true },
      ],
      40,
    )

    expect(lines.map((line) => line.text)).toEqual(['⚡ npm test', '⚡ Shell'])
    expect(lines[0]?.segments).toBeUndefined()
    expect(lines[1]?.segments?.find((segment) => segment.bold)?.text).toBe('Shell')
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
    const line = lines.find((entry) => entry.text.includes('Read'))!

    expect(line.segments).toEqual([
      { text: '📄 ' },
      { text: 'Read', bold: true },
      { text: ' a.txt' },
    ])
    // The plain text stays intact for the window and the tests around it.
    expect(line.text).toBe('📄 Read a.txt')
  })

  it('keeps the name bold in a failure line', () => {
    const lines = buildLines(
      [{ kind: 'tool', name: 'web_search', detail: 'x', ok: false }],
      40,
    )
    const line = lines.find((entry) => entry.text.includes('Searched web'))!
    expect(line.segments?.find((segment) => segment.bold)?.text).toBe('Searched web')
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

    expect(lines.map((line) => line.text)).toEqual(['🔗 Fetched one', '🔗 Fetched two'])
  })

  it('still separates a tool call from the prose around it', () => {
    const lines = buildLines(
      [
        { kind: 'assistant', text: 'let me look' },
        { kind: 'tool', name: 'read_file', detail: 'a.txt', ok: true },
      ],
      40,
    )

    expect(lines.map((line) => line.text)).toEqual(['let me look', '', '📄 Read a.txt'])
  })
})

describe('markdown in the terminal', () => {
  const assistant = (text: string, width = 40) =>
    buildLines([{ kind: 'assistant', text }], width)

  it('shows a language label line with a left rail and highlights fenced code', () => {
    const lines = assistant('Here:\n\n```ts\nconst a = 1\n  indented()\n```\n')

    expect(lines.map((line) => line.text)).toEqual([
      'Here:',
      '',
      '▎ ts',
      '▎ const a = 1',
      '▎   indented()',
      '',
    ])
    const header = lines.find((line) => line.text === '▎ ts')!
    expect(header.dim).toBeUndefined()
    expect(header.segments).toEqual([
      { text: '▎ ', color: theme.secondary },
      { text: 'ts', color: theme.muted, bold: true },
    ])
    const codeLine = lines.find((line) => line.text === '▎ const a = 1')!
    expect(codeLine.color).toBeUndefined()
    expect(codeLine.segments).toEqual([
      { text: '▎ ', color: theme.secondary },
      { text: 'const', color: theme.accent, bold: true },
      { text: ' a = ' },
      { text: '1', color: theme.secondary },
    ])
  })

  it('does not read markdown inside a fence as markdown', () => {
    const lines = assistant('```\n**not bold** and `not code`\n```')

    expect(lines[0]?.text).toBe('▎ **not bold** and `not code`')
    expect(lines[0]?.segments?.some((segment) => segment.bold)).toBe(false)
  })

  it('highlights strings, comments, numbers, keywords, and aliases inside fenced code', () => {
    const lines = assistant('```py\n# note\nreturn "ok" + 42\n```', 60)

    expect(lines[0]?.segments).toEqual([
      { text: '▎ ', color: theme.secondary },
      { text: 'py', color: theme.muted, bold: true },
    ])
    expect(lines[1]?.segments).toEqual([
      { text: '▎ ', color: theme.secondary },
      { text: '# note', color: theme.muted, italic: true },
    ])
    expect(lines[2]?.segments).toEqual([
      { text: '▎ ', color: theme.secondary },
      { text: 'return', color: theme.accent, bold: true },
      { text: ' ' },
      { text: '"ok"', color: theme.success },
      { text: ' + ' },
      { text: '42', color: theme.secondary },
    ])
  })

  it('preserves multi-line block comments in fenced code', () => {
    const lines = assistant('```ts\n/* first\nsecond */\nconst x = 2\n```', 60)

    expect(lines[1]?.segments).toEqual([
      { text: '▎ ', color: theme.secondary },
      { text: '/* first', color: theme.muted, italic: true },
    ])
    expect(lines[2]?.segments).toEqual([
      { text: '▎ ', color: theme.secondary },
      { text: 'second */', color: theme.muted, italic: true },
    ])
    expect(lines[3]?.segments?.[1]).toEqual({ text: 'const', color: theme.accent, bold: true })
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

  it('supports *italic* and _italic_ without breaking snake_case identifiers', () => {
    const lines = assistant('Use *soft* and _quiet_ with foo_bar_baz')

    expect(lines[0]?.text).toBe('Use soft and quiet with foo_bar_baz')
    expect(lines[0]?.segments).toEqual([
      { text: 'Use' },
      { text: ' soft', italic: true },
      { text: ' and' },
      { text: ' quiet', italic: true },
      { text: ' with foo_bar_baz' },
    ])

    const plainSnake = assistant('call foo_bar_baz now')
    expect(plainSnake[0]?.segments).toBeUndefined()
  })

  it('renders markdown links with underlined accent label and muted URL', () => {
    const lines = assistant('Read [the guide](https://milo.dev/docs).', 60)

    expect(lines[0]?.text).toBe('Read the guide (https://milo.dev/docs).')
    expect(lines[0]?.segments).toEqual([
      { text: 'Read' },
      { text: ' the guide', color: theme.accent, underline: true },
      { text: ' (https://milo.dev/docs).', color: theme.muted },
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

  it('renders headings by level without hashes', () => {
    const lines = assistant('# Main\n## Notes\n### Sub\nbody')

    expect(lines[0]?.text).toBe('Main')
    expect(lines[0]?.segments).toEqual([{ text: 'Main', bold: true, color: theme.accent }])
    expect(lines[1]?.text).toBe('Notes')
    expect(lines[1]?.segments).toEqual([{ text: 'Notes', bold: true, color: theme.secondary }])
    expect(lines[2]?.text).toBe('Sub')
    expect(lines[2]?.segments).toEqual([{ text: 'Sub', bold: true }])
    expect(lines[3]?.text).toBe('body')
  })

  it('renders pipe tables aligned with bold accent header and no dashes or box rules', () => {
    const lines = assistant(
      '| Name | Role | Status |\n| --- | :---: | ---: |\n| Milo | Assistant | `ready` |\n| Ada | QA | ok |',
      60,
    )

    expect(lines.map((line) => line.text)).toEqual([
      'Name  Role       Status',
      'Milo  Assistant  ready ',
      'Ada   QA         ok    ',
    ])
    expect(lines[0]?.segments?.filter((s) => s.text.trim() !== '')).toEqual([
      { text: 'Name', bold: true, color: theme.accent },
      { text: 'Role', bold: true, color: theme.accent },
      { text: 'Status', bold: true, color: theme.accent },
    ])
    expect(lines[1]?.segments?.some((s) => s.text === 'ready' && s.color === theme.success)).toBe(true)
    const joined = lines.map((line) => line.text).join('\n')
    expect(joined).not.toContain('---')
    expect(joined).not.toMatch(/[─╭╰╮╯]/)
  })

  it('cuts a line of code at the width instead of overflowing', () => {
    const lines = assistant(`\`\`\`\n${'x'.repeat(50)}\n\`\`\``, 20)

    expect(lines.map((line) => line.text)).toEqual([
      `▎ ${'x'.repeat(18)}`,
      `▎ ${'x'.repeat(18)}`,
      `▎ ${'x'.repeat(14)}`,
    ])
    expect(lines.every((line) => line.text.length <= 20)).toBe(true)
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

  it('renders ui, panel, and steer items with rails and without box borders or rules', () => {
    const lines = buildLines(
      [
        { kind: 'ui', title: 'Summary', summary: '3 tasks ready' },
        { kind: 'panel', detail: 'Opened panel: src/index.ts' },
        { kind: 'steer', text: 'focus on the parser first and skip formatting' },
      ],
      30,
    )

    const uiLines = lines.filter((line) => line.text.startsWith('▎ '))
    expect(uiLines.length).toBeGreaterThanOrEqual(2)
    expect(uiLines.every((line) => line.segments?.[0]?.color === theme.secondary)).toBe(true)

    const joined = lines.map((line) => line.text).join('\n')
    expect(joined).toContain('Summary')
    expect(joined).toContain('3 tasks ready')
    expect(joined).toContain('Opened panel: src/index.ts')
    expect(joined).toContain('↳ steered: focus on')
    expect(joined).not.toMatch(/[─╭╰╮╯]/)
  })

  it('colors +N and -M tool counts in success and danger', () => {
    const lines = buildLines(
      [
        { kind: 'tool', name: 'edit_file', detail: 'src/app.ts', ok: true, counts: '+12 −3' },
        { kind: 'tool', name: 'write_file', detail: 'src/new.ts', ok: true, counts: '+5' },
        { kind: 'tool', name: 'edit_file', detail: 'src/old.ts', ok: true, counts: '-2' },
      ],
      60,
    )

    expect(lines[0]?.text).toBe('✏️ Edited src/app.ts +12 −3')
    expect(lines[0]?.segments).toEqual([
      { text: '✏️ ' },
      { text: 'Edited', bold: true },
      { text: ' src/app.ts ' },
      { text: '+12', color: theme.success },
      { text: ' ' },
      { text: '−3', color: theme.danger },
    ])
    expect(lines[1]?.segments?.find((s) => s.text === '+5')?.color).toBe(theme.success)
    expect(lines[2]?.segments?.find((s) => s.text === '-2')?.color).toBe(theme.danger)
  })

  it('renders expanded tool args, diff changes, and results with a left rail and non-dim truncation', () => {
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

    expect(lines[0]?.text).toBe('✏️ Edited src/app.ts +1 −1')
    expect(lines.slice(1).every((line) => line.text.startsWith('▎ '))).toBe(true)
    expect(lines.some((line) => line.text.includes('path: src/app.ts'))).toBe(true)
    const fileHeader = lines.find((line) => line.text.startsWith('▎ src/app.ts'))!
    expect(fileHeader.segments?.[0]).toEqual({ text: '▎ ', color: theme.secondary })
    const removeLine = lines.find((line) => line.text === '▎ - const a = 1')!
    expect(removeLine.segments).toEqual([
      { text: '▎ ', color: theme.muted },
      { text: '- const a = 1', color: theme.danger },
    ])
    const addLine = lines.find((line) => line.text === '▎ + const a = 2')!
    expect(addLine.segments).toEqual([
      { text: '▎ ', color: theme.muted },
      { text: '+ const a = 2', color: theme.success },
    ])
    const truncatedNotice = lines.find((line) => line.text.includes('result truncated'))!
    expect(truncatedNotice.dim).toBeUndefined()
    expect(truncatedNotice.segments?.[1]).toEqual({
      text: '… (result truncated)',
      color: theme.muted,
      italic: true,
    })
    expect(lines.map((line) => line.text).join('\n')).not.toMatch(/[─╭╰╮╯]/)
  })

  it('renders reasoning, todo, and verification items with rails and semantic weights', () => {
    const lines = buildLines(
      [
        { kind: 'reasoning', header: '✻ Thought for 2.4s', text: 'checking constraints' },
        {
          kind: 'todo',
          items: [
            { content: 'Done task', status: 'completed' },
            { content: 'Active task', status: 'in_progress' },
            { content: 'Queued task', status: 'pending' },
          ],
        },
        { kind: 'verification', ok: false, text: 'Checks failed\nAssertionError at line 10' },
      ],
      60,
    )

    const reasoningHeader = lines.find((line) => line.text === '✻ Thought for 2.4s')!
    expect(reasoningHeader.dim).toBeUndefined()
    expect(reasoningHeader.segments).toEqual([
      { text: '✻', color: theme.secondary },
      { text: ' Thought for 2.4s', color: theme.muted, italic: true },
    ])
    const reasoningBody = lines.find((line) => line.text === '▎ checking constraints')!
    expect(reasoningBody.segments).toEqual([
      { text: '▎ ', color: theme.secondary },
      { text: 'checking constraints', color: theme.muted },
    ])

    const activeTodo = lines.find((line) => line.text === '▎ [>] Active task')!
    expect(activeTodo.segments).toEqual([
      { text: '▎ ', color: theme.accent },
      { text: '[>] Active task', color: theme.accent, bold: true },
    ])
    const doneTodo = lines.find((line) => line.text === '▎ [x] Done task')!
    expect(doneTodo.segments).toEqual([
      { text: '▎ ', color: theme.muted },
      { text: '[x] Done task', color: theme.success },
    ])

    const verdict = lines.find((line) => line.text === '▎ Checks failed')!
    expect(verdict.segments).toEqual([
      { text: '▎ ', color: theme.danger },
      { text: 'Checks failed', color: theme.danger, bold: true },
    ])
    const detail = lines.find((line) => line.text === '▎ AssertionError at line 10')!
    expect(detail.segments).toEqual([
      { text: '▎ ', color: theme.danger },
      { text: 'AssertionError at line 10', color: theme.muted },
    ])
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

    expect(lines.map((line) => line.text)).toEqual(['📄 Read a.txt'])
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

    const logoRethemed = buildLines([fixed], 40, { ...theme, logoTop: '#123456' })
    expect(logoRethemed[0]).not.toBe(first[0])
  })
})

describe('resolveTuiTheme', () => {
  it('returns the base theme when unset and maps every palette ID to accessible accent and logo colors', () => {
    expect(resolveTuiTheme()).toEqual(theme)
    expect(contrastRatio(theme.logoTop, '#FFFCF0')).toBeGreaterThanOrEqual(4.4)
    expect(contrastRatio(theme.logoTop, '#100F0F')).toBeGreaterThanOrEqual(4.0)
    expect(contrastRatio(theme.logoBottom, '#FFFCF0')).toBeGreaterThanOrEqual(4.4)
    expect(contrastRatio(theme.logoBottom, '#100F0F')).toBeGreaterThanOrEqual(4.0)

    for (const id of COLOR_PALETTE_IDS) {
      const resolved = resolveTuiTheme(id)
      expect(resolved.secondary).toBe(theme.secondary)
      expect(resolved.surface).toBe(theme.surface)
      expect(contrastRatio(resolved.accent, '#FFFCF0')).toBeGreaterThanOrEqual(4.4)
      expect(contrastRatio(resolved.accent, '#100F0F')).toBeGreaterThanOrEqual(4.0)
      expect(contrastRatio(resolved.logoTop, '#FFFCF0')).toBeGreaterThanOrEqual(4.4)
      expect(contrastRatio(resolved.logoTop, '#100F0F')).toBeGreaterThanOrEqual(4.0)
      expect(contrastRatio(resolved.logoBottom, '#FFFCF0')).toBeGreaterThanOrEqual(4.4)
      expect(contrastRatio(resolved.logoBottom, '#100F0F')).toBeGreaterThanOrEqual(4.0)
    }
  })

  it('applies activeTheme colors inside buildLines', () => {
    const ocean = resolveTuiTheme('ocean')
    const lines = buildLines([{ kind: 'todo', items: [{ content: 'Run', status: 'in_progress' }] }], 40, ocean)
    expect(lines[0]).toMatchObject({ color: ocean.accent })
  })
})
