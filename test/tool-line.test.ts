import { describe, expect, it } from 'vitest'
import { toolIcon, toolLine, toolStyle } from '../src/gateways/tool-line'

describe('toolLine', () => {
  it('gives a shell command a code block and shows the command', () => {
    expect(toolLine('shell_command', { command: 'docker compose up -d' })).toEqual({
      text: '⚡ shell_command docker compose up -d',
      style: 'code',
    })
  })

  it('keeps a search in the quote box, with the query', () => {
    expect(toolLine('web_search', { query: 'bun 1.2 release' })).toEqual({
      text: '🌐 web_search bun 1.2 release',
      style: 'quote',
    })
  })

  it('marks the read tools with their own icon and keeps them in the quote box', () => {
    expect(toolLine('list_dir', { path: 'src' })).toEqual({
      text: '📁 list_dir src',
      style: 'quote',
    })
    expect(toolLine('glob', { pattern: '**/*.ts' })).toEqual({
      text: '🔎 glob **/*.ts',
      style: 'quote',
    })
    expect(toolLine('grep', { pattern: 'alpha' })).toEqual({
      text: '🔍 grep alpha',
      style: 'quote',
    })
  })

  it('gives a file write a code block, like the shell', () => {
    expect(toolLine('write_file', { path: 'src/a.ts', content: 'x' })).toEqual({
      text: '📝 write_file src/a.ts',
      style: 'code',
    })
    expect(toolLine('edit_file', { path: 'src/a.ts', old_string: 'a', new_string: 'b' })).toEqual({
      text: '✏️ edit_file src/a.ts',
      style: 'code',
    })
  })

  it('falls back to the marker and a quote for an unknown tool', () => {
    expect(toolLine('read_file', { path: 'src/index.ts' })).toEqual({
      text: '📄 read_file src/index.ts',
      style: 'quote',
    })
    expect(toolLine('something_new', { path: 'a' })).toEqual({
      text: '🔧 something_new a',
      style: 'quote',
    })
  })

  it('starts every line with an emoji, never a typographic glyph', () => {
    const emoji = /\p{Extended_Pictographic}/u
    const names = ['read_file', 'list_dir', 'glob', 'grep', 'write_file', 'edit_file', 'remember', 'web_search', 'shell_command', 'unknown_tool']

    for (const name of names) {
      const [icon] = toolLine(name, { path: 'a' }).text.split(' ')
      expect(icon).toBeDefined()
      expect(emoji.test(icon!)).toBe(true)
    }
  })

  it('shows nothing rather than an empty object when no value is useful', () => {
    expect(toolLine('read_file', {}).text).toBe('📄 read_file')
    expect(toolLine('read_file').text).toBe('📄 read_file')
    expect(toolLine('read_file', { offset: 10 }).text).toBe('📄 read_file')
    expect(toolLine('read_file', 'nonsense').text).toBe('📄 read_file')
  })

  it('flattens and shortens a long command', () => {
    const line = toolLine('shell_command', { command: `echo ${'x'.repeat(200)}\nnext line` })
    expect(line.text).not.toContain('\n')
    expect(line.text.endsWith('…')).toBe(true)
    expect(line.text.length).toBeLessThanOrEqual('⚡ shell_command '.length + 120)
  })
})

describe('toolIcon', () => {
  it('still answers the icon alone, for the CLI', () => {
    expect(toolIcon('web_search')).toBe('🌐')
    expect(toolIcon('shell_command')).toBe('⚡')
    expect(toolIcon('anything')).toBe('🔧')
  })

  it('marks shell as the code-block tool', () => {
    expect(toolStyle('shell_command')).toBe('code')
    expect(toolStyle('web_search')).toBe('quote')
  })
})
