import { describe, expect, it } from 'vitest'
import { changeCounts, isExternalTool, toolBrand, toolDisplayName, toolDraw, toolIcon, toolLine, toolResult, toolResultPreview, toolText } from '../src/gateways/tool-line.js'

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
    // Who a message is for, not the message itself: a body has no place on a gist.
    expect(toolLine('gmail_draft', { to: 'ana@exemplo', subject: 'Hello', body: 'x' })).toBe(
      '📧 gmail_draft ana@exemplo',
    )
    expect(toolLine('gmail_send', { to: 'ana@exemplo', subject: 'Hello', body: 'x' })).toBe(
      '📧 gmail_send ana@exemplo',
    )
    expect(toolLine('mail_labels', { action: 'list' })).toBe('📧 mail_labels list')
    expect(toolLine('drive_search', { query: 'budget' })).toBe('📂 drive_search budget')
  })

  it('names the thing a verb acts on, by its path or its id', () => {
    expect(toolLine('sessions', { action: 'list' })).toBe('🗃 sessions list')
    expect(toolLine('sessions', { action: 'remove', id: 'merry-badger-52' })).toBe(
      '🗃 sessions remove merry-badger-52',
    )
    expect(toolLine('routine', { action: 'remove', id: 'calm-otter-7' })).toBe(
      '⏱️ routine remove calm-otter-7',
    )
  })

  it('shows the rule and list name beside their actions', () => {
    expect(toolLine('instructions', { action: 'add', text: 'Never run reboot without asking.' })).toBe(
      '📜 instructions add Never run reboot without asking.',
    )
    expect(toolLine('task_lists', { action: 'create', name: 'Release plan' })).toBe(
      '☑️ task_lists create Release plan',
    )
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

  it('shows the fact Milo kept, and counts the others rather than dumping the list', () => {
    expect(toolLine('remember', { facts: ['Prefers TypeScript over JavaScript.'] })).toBe(
      '🧠 remember Prefers TypeScript over JavaScript.',
    )
    expect(
      toolLine('remember', { facts: ['Prefers TypeScript.', 'Lives in São Paulo.', 'Ships on Fridays.'] }),
    ).toBe('🧠 remember Prefers TypeScript. (+2 more)')
  })

  it('names the skill being loaded and the URL being fetched', () => {
    expect(toolLine('read_skill', { name: 'deploy' })).toBe('📘 read_skill deploy')
    expect(toolLine('fetch_url', { url: 'https://example.com/a' })).toBe(
      '🔗 fetch_url https://example.com/a',
    )
  })

  it('starts every line with an emoji, never a typographic glyph', () => {
    const emoji = /\p{Extended_Pictographic}/u
    const names = ['read_file', 'list_dir', 'glob', 'grep', 'fetch_url', 'write_file', 'edit_file', 'remember', 'recall', 'search_history', 'web_search', 'read_skill', 'task', 'shell_command', 'gmail_search', 'gmail_read', 'gmail_modify', 'gmail_draft', 'gmail_send', 'mail_labels', 'drive_search', 'drive_read', 'unknown_tool']

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

describe('toolDraw', () => {
  it('draws the remembered fact at full, and the name alone at name', () => {
    const args = { facts: ['Prefers TypeScript over JavaScript.'] }
    expect(toolDraw('remember', args, 'full')).toEqual({
      name: 'remember',
      text: 'remember Prefers TypeScript over JavaScript.',
    })
    expect(toolDraw('remember', args, 'name')).toEqual({ name: 'remember', text: 'remember' })
    expect(toolDraw('remember', args, 'off')).toBeNull()
  })
})

describe('toolResult', () => {
  it('hands back what came with no trailing whitespace, and nothing for an empty one', () => {
    expect(toolResult('ok\n')).toBe('ok')
    expect(toolResult('a\nb')).toBe('a\nb')
    expect(toolResult('   ')).toBe('')
    expect(toolResult('')).toBe('')
  })

  it('caps a long result with an ellipsis, the whole of it left to the raw copy', () => {
    const capped = toolResult('x'.repeat(5000))
    expect(capped.length).toBe(4000)
    expect(capped.endsWith('…')).toBe(true)
    // A result at the ceiling is not cut.
    expect(toolResult('y'.repeat(4000))).toBe('y'.repeat(4000))
  })
})

describe('toolResultPreview', () => {
  it('skips the exit line a shell command leads with, showing what it printed', () => {
    expect(toolResultPreview('exit 0\nbuilt 3 packages')).toBe('built 3 packages')
    // A non-zero exit is skipped the same way: the tool line already says the failure.
    expect(toolResultPreview('exit 1\ncommand not found: foo')).toBe('command not found: foo')
  })

  it('leaves every other result as its own first line', () => {
    expect(toolResultPreview('a\nb')).toBe('a')
    expect(toolResultPreview('single line')).toBe('single line')
  })

  it('is empty when the exit line was all there was to say', () => {
    expect(toolResultPreview('exit 0')).toBe('')
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

  it('counts a change in one line, and says nothing when nothing moved', () => {
    const file = (additions: number, deletions: number) => ({ path: 'a.ts', additions, deletions, lines: [] })
    expect(changeCounts([file(3, 1)])).toBe('+3 −1')
    expect(changeCounts([file(0, 2)])).toBe('−2')
    expect(changeCounts([file(4, 0)])).toBe('+4')
    expect(changeCounts([file(0, 0)])).toBe('')
    expect(changeCounts(undefined)).toBe('')
    expect(changeCounts([file(1, 1), file(2, 3)])).toBe('+3 −4')
  })
})
