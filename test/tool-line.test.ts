import { describe, expect, it } from 'vitest'
import { isExternalTool, toolBrand, toolDisplayName, toolIcon, toolLine, toolText } from '../src/gateways/tool-line.js'

describe('toolLine', () => {
  it('shows a shell command like any other tool, with the command beside it', () => {
    expect(toolLine('shell_command', { command: 'docker compose up -d' })).toBe(
      '⚡ shell_command docker compose up -d',
    )
  })

  it('keeps a search in the same shape, with the query', () => {
    expect(toolLine('web_search', { query: 'bun 1.2 release' })).toBe('🌐 web_search bun 1.2 release')
  })

  it('marks the read tools with their own icon', () => {
    expect(toolLine('list_dir', { path: 'src' })).toBe('📁 list_dir src')
    expect(toolLine('glob', { pattern: '**/*.ts' })).toBe('🔎 glob **/*.ts')
    expect(toolLine('grep', { pattern: 'alpha' })).toBe('🔍 grep alpha')
  })

  it('gives every email tool the one envelope, and Drive the folder', () => {
    expect(toolLine('gmail_search', { query: 'is:unread' })).toBe('📧 gmail_search is:unread')
    expect(toolLine('gmail_modify', { id: 'm1', op: 'trash' })).toBe('📧 gmail_modify')
    expect(toolLine('mail_labels', { action: 'list' })).toBe('📧 mail_labels list')
    expect(toolLine('drive_search', { query: 'budget' })).toBe('📂 drive_search budget')
  })

  it('writes a file change the same way, by its path', () => {
    expect(toolLine('write_file', { path: 'src/a.ts', content: 'x' })).toBe('📝 write_file src/a.ts')
    expect(toolLine('edit_file', { path: 'src/a.ts', old_string: 'a', new_string: 'b' })).toBe(
      '✏️ edit_file src/a.ts',
    )
  })

  it('falls back to the marker for an unknown tool', () => {
    expect(toolLine('read_file', { path: 'src/index.ts' })).toBe('📄 read_file src/index.ts')
    expect(toolLine('something_new', { path: 'a' })).toBe('🔧 something_new a')
  })

  it('shows a subtask by its label, never by its prompt', () => {
    expect(toolLine('task', { description: 'survey deps', prompt: 'a long instruction' })).toBe(
      '🤖 task survey deps',
    )
  })

  it('names the skill being loaded and the URL being fetched', () => {
    expect(toolLine('read_skill', { name: 'deploy' })).toBe('📘 read_skill deploy')
    expect(toolLine('fetch_url', { url: 'https://example.com/a' })).toBe(
      '🔗 fetch_url https://example.com/a',
    )
  })

  it('starts every line with an emoji, never a typographic glyph', () => {
    const emoji = /\p{Extended_Pictographic}/u
    const names = ['read_file', 'list_dir', 'glob', 'grep', 'fetch_url', 'write_file', 'edit_file', 'remember', 'recall', 'search_history', 'web_search', 'read_skill', 'task', 'shell_command', 'gmail_search', 'gmail_read', 'gmail_modify', 'mail_labels', 'drive_search', 'drive_read', 'unknown_tool']

    for (const name of names) {
      const [icon] = toolLine(name, { path: 'a' }).split(' ')
      expect(icon).toBeDefined()
      expect(emoji.test(icon!)).toBe(true)
    }
  })

  it('shows nothing rather than an empty object when no value is useful', () => {
    expect(toolLine('read_file', {})).toBe('📄 read_file')
    expect(toolLine('read_file')).toBe('📄 read_file')
    expect(toolLine('read_file', { offset: 10 })).toBe('📄 read_file')
    expect(toolLine('read_file', 'nonsense')).toBe('📄 read_file')
  })

  it('emphasises the name only where the surface renders Markdown', () => {
    expect(toolLine('read_file', { path: 'a.txt' }, { markdown: true })).toBe(
      '📄 **read_file** a.txt',
    )
    expect(toolLine('web_search', { query: 'x' }, { markdown: true })).toBe('🌐 **web_search** x')
    // A shell command is one of these lines now, so it is emphasised and named
    // exactly like the rest — the chat surfaces draw them all the same way.
    expect(toolLine('shell_command', { command: 'ls' }, { markdown: true })).toBe(
      '⚡ **shell_command** ls',
    )
    expect(toolLine('read_file', { path: 'a.txt' })).toBe('📄 read_file a.txt')
  })

  it('flattens and shortens a long command', () => {
    const line = toolLine('shell_command', { command: `echo ${'x'.repeat(200)}\nnext line` })
    expect(line).not.toContain('\n')
    expect(line.endsWith('…')).toBe(true)
    expect(line.length).toBeLessThanOrEqual('⚡ shell_command '.length + 120)
  })
})

describe('toolIcon', () => {
  it('still answers the icon alone, for the CLI', () => {
    expect(toolIcon('web_search')).toBe('🌐')
    expect(toolIcon('shell_command')).toBe('⚡')
    expect(toolIcon('gmail_search')).toBe('📧')
    expect(toolIcon('drive_read')).toBe('📂')
    expect(toolIcon('anything')).toBe('🔧')
  })
})

describe('toolBrand', () => {
  it('names the service behind a Drive tool, and nothing for the rest', () => {
    expect(toolBrand('drive_search')).toBe('drive')
    expect(toolBrand('drive_read')).toBe('drive')
    // The email tools share one mail mark, so none of them names a service.
    expect(toolBrand('gmail_search')).toBeNull()
    expect(toolBrand('gmail_read')).toBeNull()
    expect(toolBrand('gmail_modify')).toBeNull()
    expect(toolBrand('mail_labels')).toBeNull()
    expect(toolBrand('web_search')).toBeNull()
    expect(toolBrand('anything')).toBeNull()
  })
})

describe('toolText', () => {
  it('is the line without its icon, for the surface that draws the icon itself', () => {
    expect(toolText('gmail_search', { query: 'is:unread' })).toBe('gmail_search is:unread')
    expect(toolText('read_file')).toBe('read_file')
    expect(toolText('read_file', { path: 'a.txt' }, { markdown: true })).toBe('**read_file** a.txt')
  })
})

describe('a tool from an external server', () => {
  it('reads as its server and its own name, with the plug for an icon', () => {
    expect(toolLine('mcp__github__create_issue', { query: 'leak' })).toBe('🔌 github: create_issue leak')
    expect(toolIcon('mcp__github__create_issue')).toBe('🔌')
  })

  it('is named the same wherever a name is read', () => {
    expect(toolDisplayName('mcp__github__create_issue')).toBe('github: create_issue')
    expect(toolDisplayName('read_file')).toBe('read_file')
    // Markdown emphasis wraps the whole name, not the prefix alone.
    expect(toolText('mcp__notes__append', undefined, { markdown: true })).toBe('**notes: append**')
  })

  it('knows which names came from outside', () => {
    expect(isExternalTool('mcp__github__create_issue')).toBe(true)
    expect(isExternalTool('read_file')).toBe(false)
    expect(isExternalTool('anything')).toBe(false)
  })

  it('splits at the delimiter even when the tool’s own name carries underscores', () => {
    expect(toolDisplayName('mcp__srv__a__b')).toBe('srv: a__b')
  })
})
