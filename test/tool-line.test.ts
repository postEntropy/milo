import { describe, expect, it } from 'vitest'
import { changeCounts, isExternalTool, toolBrand, toolDisplayName, toolDraw, toolIcon, toolInput, toolLine, toolParts, toolResult, toolResultPreview, toolText } from '../src/gateways/tool-line.js'

describe('toolLine', () => {
  it('shows a shell command directly when it has a command, and Shell when it does not', () => {
    expect(toolLine('shell_command', { command: 'docker compose up -d' })).toBe(
      '⚡ docker compose up -d',
    )
    expect(toolLine('shell_command')).toBe('⚡ Shell')
  })

  it('keeps a search in the same shape, with the query', () => {
    expect(toolLine('web_search', { query: 'bun 1.2 release' })).toBe('🌐 Searched web bun 1.2 release')
  })

  it('marks the read tools with their own icon', () => {
    expect(toolLine('list_dir', { path: 'src' })).toBe('📁 Listed src')
    expect(toolLine('glob', { pattern: '**/*.ts' })).toBe('🔎 Found files **/*.ts')
    expect(toolLine('grep', { pattern: 'alpha' })).toBe('🔍 Searched alpha')
  })

  it('gives every email tool the one envelope, and Drive the folder', () => {
    expect(toolLine('gmail_search', { query: 'is:unread' })).toBe('📧 Searched email is:unread')
    expect(toolLine('gmail_modify', { id: 'm1', op: 'trash' })).toBe('📧 Modified email')
    // Who a message is for, not the message itself: a body has no place on a gist.
    expect(toolLine('gmail_draft', { to: 'ana@exemplo', subject: 'Hello', body: 'x' })).toBe(
      '📧 Drafted email ana@exemplo',
    )
    expect(toolLine('gmail_send', { to: 'ana@exemplo', subject: 'Hello', body: 'x' })).toBe(
      '📧 Sent email ana@exemplo',
    )
    expect(toolLine('mail_labels', { action: 'list' })).toBe('📧 Email labels list')
    expect(toolLine('drive_search', { query: 'budget' })).toBe('📂 Searched Drive budget')
  })

  it('names the thing a verb acts on, by its path or its id', () => {
    expect(toolLine('sessions', { action: 'list' })).toBe('🗃 Sessions list')
    expect(toolLine('sessions', { action: 'remove', id: 'merry-badger-52' })).toBe(
      '🗃 Sessions remove merry-badger-52',
    )
    expect(toolLine('routine', { action: 'remove', id: 'calm-otter-7' })).toBe(
      '⏱️ Routine remove calm-otter-7',
    )
  })

  it('shows the rule and list name beside their actions', () => {
    expect(toolLine('instructions', { action: 'add', text: 'Never run reboot without asking.' })).toBe(
      '📜 Instructions add Never run reboot without asking.',
    )
    expect(toolLine('task_lists', { action: 'create', name: 'Release plan' })).toBe(
      '☑️ Task lists create Release plan',
    )
  })

  it('writes a file change the same way, by its path', () => {
    expect(toolLine('write_file', { path: 'src/a.ts', content: 'x' })).toBe('📝 Wrote src/a.ts')
    expect(toolLine('edit_file', { path: 'src/a.ts', old_string: 'a', new_string: 'b' })).toBe(
      '✏️ Edited src/a.ts',
    )
    expect(
      toolLine('apply_patch', {
        patch: '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** Add File: src/b.ts\n+x\n*** End Patch',
      }),
    ).toBe('🧩 Patched src/a.ts (+1 more)')
  })

  it('falls back to the marker for an unknown tool', () => {
    expect(toolLine('read_file', { path: 'src/index.ts' })).toBe('📄 Read src/index.ts')
    expect(toolLine('something_new', { path: 'a' })).toBe('🔧 something_new a')
  })

  it('shows a subtask by its label, never by its prompt', () => {
    expect(toolLine('task', { description: 'survey deps', prompt: 'a long instruction' })).toBe(
      '🤖 Task survey deps',
    )
  })

  it('shows the fact Milo kept, and counts the others rather than dumping the list', () => {
    expect(toolLine('remember', { facts: ['Prefers TypeScript over JavaScript.'] })).toBe(
      '🧠 Remembered Prefers TypeScript over JavaScript.',
    )
    expect(
      toolLine('remember', { facts: ['Prefers TypeScript.', 'Lives in São Paulo.', 'Ships on Fridays.'] }),
    ).toBe('🧠 Remembered Prefers TypeScript. (+2 more)')
  })

  it('names the skill being loaded, the URL being fetched, and commits/browser calls', () => {
    expect(toolLine('read_skill', { name: 'deploy' })).toBe('📘 Read skill deploy')
    expect(toolLine('fetch_url', { url: 'https://example.com/a' })).toBe(
      '🔗 Fetched https://example.com/a',
    )
    expect(toolLine('read_x_post', { url: 'https://x.com/milo/status/1' })).toBe(
      '🔗 Read post https://x.com/milo/status/1',
    )
    expect(toolLine('read_attachment')).toBe('📎 Read attachment')
    expect(toolLine('git_commit', { message: 'fix: typo\n\nmore detail' })).toBe(
      '📌 Committed fix: typo more detail',
    )
    expect(toolLine('browser_open', { url: 'https://example.com' })).toBe(
      '🧭 Opened page https://example.com',
    )
    expect(toolLine('browser_snapshot', { mode: 'text' })).toBe('👁️ Snapshot text')
    expect(toolLine('browser_act', { action: 'press', key: 'Enter' })).toBe('🖱️ Browser press Enter')
  })

  it('starts every line with an emoji, never a typographic glyph', () => {
    const emoji = /\p{Extended_Pictographic}/u
    const names = ['read_file', 'list_dir', 'glob', 'grep', 'fetch_url', 'read_x_post', 'read_attachment', 'write_file', 'edit_file', 'remember', 'recall', 'search_history', 'web_search', 'read_skill', 'task', 'shell_command', 'gmail_search', 'gmail_read', 'gmail_modify', 'gmail_draft', 'gmail_send', 'mail_labels', 'drive_search', 'drive_read', 'panel', 'send_file', 'unknown_tool']

    for (const name of names) {
      const [icon] = toolLine(name, { path: 'a' }).split(' ')
      expect(icon).toBeDefined()
      expect(emoji.test(icon!)).toBe(true)
    }
  })

  it('shows nothing rather than an empty object when no value is useful', () => {
    expect(toolLine('read_file', {})).toBe('📄 Read')
    expect(toolLine('read_file')).toBe('📄 Read')
    expect(toolLine('read_file', { offset: 10 })).toBe('📄 Read')
    expect(toolLine('read_file', 'nonsense')).toBe('📄 Read')
  })

  it('emphasises the name only where the surface renders Markdown', () => {
    expect(toolLine('read_file', { path: 'a.txt' }, { markdown: true })).toBe(
      '📄 **Read** a.txt',
    )
    expect(toolLine('web_search', { query: 'x' }, { markdown: true })).toBe('🌐 **Searched web** x')
    // A shell command with no command still names the tool; with one, it drops the label.
    expect(toolLine('shell_command', undefined, { markdown: true })).toBe('⚡ **Shell**')
    expect(toolLine('shell_command', { command: 'ls' }, { markdown: true })).toBe('⚡ ls')
    expect(toolLine('read_file', { path: 'a.txt' })).toBe('📄 Read a.txt')
  })

  it('flattens and shortens a long command', () => {
    const line = toolLine('shell_command', { command: `echo ${'x'.repeat(200)}\nnext line` })
    expect(line).not.toContain('\n')
    expect(line.endsWith('…')).toBe(true)
    expect(line.length).toBeLessThanOrEqual('⚡ '.length + 120)
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
    expect(toolText('gmail_search', { query: 'is:unread' })).toBe('Searched email is:unread')
    expect(toolText('read_file')).toBe('Read')
    expect(toolText('read_file', { path: 'a.txt' }, { markdown: true })).toBe('**Read** a.txt')
    expect(toolText('shell_command', { command: 'npm test' })).toBe('npm test')
    expect(toolText('shell_command')).toBe('Shell')
  })
})

describe('toolParts', () => {
  it('splits a label and its value, and leaves a shell command without a label', () => {
    expect(toolParts('read_file', 'Read a.txt')).toEqual({ label: 'Read', value: 'a.txt' })
    expect(toolParts('read_file', 'Read')).toEqual({ label: 'Read', value: '' })
    expect(toolParts('shell_command', 'npm test')).toEqual({ label: '', value: 'npm test' })
    expect(toolParts('shell_command', 'Shell script.sh')).toEqual({ label: '', value: 'Shell script.sh' })
    expect(toolParts('shell_command', 'Shell')).toEqual({ label: 'Shell', value: '' })
  })
})

describe('toolDraw', () => {
  it('draws the remembered fact at full, and the name alone at name', () => {
    const args = { facts: ['Prefers TypeScript over JavaScript.'] }
    expect(toolDraw('remember', args, 'full')).toEqual({
      name: 'remember',
      text: 'Remembered Prefers TypeScript over JavaScript.',
    })
    expect(toolDraw('remember', args, 'name')).toEqual({ name: 'remember', text: 'Remembered' })
    expect(toolDraw('remember', args, 'off')).toBeNull()
  })
})

describe('toolInput', () => {
  it('formats arguments as clean key/value lines rather than raw JSON, and unwraps shell commands', () => {
    expect(toolInput('shell_command', { command: 'npm test' })).toBe('npm test')
    expect(toolInput('glob', { pattern: '**/.git', path: '/repo', limit: 20 })).toBe(
      'pattern: **/.git\npath: /repo\nlimit: 20',
    )
    expect(toolInput('remember', { facts: ['Uses Linux', 'Speaks Portuguese'] })).toBe(
      'facts: Uses Linux, Speaks Portuguese',
    )
    expect(toolInput('edit_file', { path: 'a.ts', oldText: 'a\nb' })).toBe(
      'path: a.ts\noldText:\n  a\n  b',
    )
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
    expect(toolDisplayName('read_file')).toBe('Read')
    expect(toolDisplayName('shell_command')).toBe('Shell')
    expect(toolDisplayName('unknown_tool')).toBe('unknown_tool')
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
