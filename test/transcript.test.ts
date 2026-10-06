import { describe, expect, it } from 'vitest'
import { buildLines, padToBottom, visibleWindow, wrapText, type Line } from '../src/gateways/cli/transcript.js'
import { theme } from '../src/gateways/cli/theme.js'

describe('wrapText', () => {
  it('wraps on word boundaries', () => {
    expect(wrapText('one two three four', 8)).toEqual(['one two', 'three', 'four'])
  })

  it('preserves blank lines and hard-breaks long words', () => {
    expect(wrapText('a\n\nabcdefghij', 4)).toEqual(['a', '', 'abcd', 'efgh', 'ij'])
  })
})

describe('buildLines', () => {
  it('prefixes user lines and colors tool/error lines', () => {
    const lines = buildLines(
      [
        { kind: 'user', text: 'hi' },
        { kind: 'tool', name: 'read_file', detail: 'a.txt', ok: true },
        { kind: 'error', text: 'boom' },
      ],
      40,
    )

    expect(lines[0]).toMatchObject({ text: '› hi', color: theme.accent })
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

  it('hides the fence markers and shows the code as it was written', () => {
    const lines = assistant('Here:\n\n```ts\nconst a = 1\n  indented()\n```\n')

    expect(lines.map((line) => line.text)).toEqual([
      'Here:',
      '',
      'const a = 1',
      '  indented()',
      '',
    ])
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
