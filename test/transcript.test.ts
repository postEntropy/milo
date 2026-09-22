import { describe, expect, it } from 'vitest'
import { buildLines, padToBottom, visibleWindow, wrapText, type Line } from '../src/gateways/cli/transcript'
import { theme } from '../src/gateways/cli/theme'

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

    // buildLines puts a blank line between items; the icons are what matters.
    expect(lines.filter((line) => line.text !== '').map((line) => line.text)).toEqual([
      '🌐 web_search(bun 1.2)',
      '📄 read_file(a.txt)',
      '✗ web_search(bun 1.2)',
    ])
  })

  it('omits the parentheses when there is no detail to show', () => {
    const lines = buildLines([{ kind: 'tool', name: 'read_file', detail: '', ok: true }], 40)

    expect(lines.map((line) => line.text)).toEqual(['📄 read_file'])
  })

  it('bolds the tool name so it does not read as the start of the call', () => {
    const lines = buildLines([{ kind: 'tool', name: 'read_file', detail: 'a.txt', ok: true }], 40)
    const line = lines.find((entry) => entry.text.includes('read_file'))!

    expect(line.segments).toEqual([
      { text: '📄 ' },
      { text: 'read_file', bold: true },
      { text: '(a.txt)' },
    ])
    // The plain text stays intact for the window and the tests around it.
    expect(line.text).toBe('📄 read_file(a.txt)')
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
