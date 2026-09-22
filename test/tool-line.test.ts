import { describe, expect, it } from 'vitest'
import { toolIcon, toolLine, toolStyle } from '../src/gateways/tool-line'

describe('toolLine', () => {
  it('gives a shell command a code block and shows the command', () => {
    expect(toolLine('shell_command', { command: 'docker compose up -d' })).toEqual({
      text: '▸ shell_command docker compose up -d',
      style: 'code',
    })
  })

  it('keeps a search in the quote box, with the query', () => {
    expect(toolLine('web_search', { query: 'bun 1.2 release' })).toEqual({
      text: '🌐 web_search bun 1.2 release',
      style: 'quote',
    })
  })

  it('falls back to the marker and a quote for an unknown tool', () => {
    expect(toolLine('read_file', { path: 'src/index.ts' })).toEqual({
      text: '▸ read_file src/index.ts',
      style: 'quote',
    })
    expect(toolLine('something_new', { path: 'a' })).toEqual({
      text: '▸ something_new a',
      style: 'quote',
    })
  })

  it('shows nothing rather than an empty object when no value is useful', () => {
    expect(toolLine('read_file', {}).text).toBe('▸ read_file')
    expect(toolLine('read_file').text).toBe('▸ read_file')
    expect(toolLine('read_file', { offset: 10 }).text).toBe('▸ read_file')
    expect(toolLine('read_file', 'nonsense').text).toBe('▸ read_file')
  })

  it('flattens and shortens a long command', () => {
    const line = toolLine('shell_command', { command: `echo ${'x'.repeat(200)}\nnext line` })
    expect(line.text).not.toContain('\n')
    expect(line.text.endsWith('…')).toBe(true)
    expect(line.text.length).toBeLessThanOrEqual('▸ shell_command '.length + 120)
  })
})

describe('toolIcon', () => {
  it('still answers the icon alone, for the CLI', () => {
    expect(toolIcon('web_search')).toBe('🌐')
    expect(toolIcon('shell_command')).toBe('▸')
    expect(toolIcon('anything')).toBe('▸')
  })

  it('marks shell as the code-block tool', () => {
    expect(toolStyle('shell_command')).toBe('code')
    expect(toolStyle('web_search')).toBe('quote')
  })
})
