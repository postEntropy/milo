import { describe, expect, it } from 'vitest'
import { toHtml, toPlain } from '../src/gateways/telegram/html.js'
import {
  TelegramMessenger,
  isNotModified,
  type TelegramSender,
} from '../src/gateways/telegram/messenger.js'

interface Behaviour {
  htmlFails?: boolean
  editHtmlFails?: boolean
  editPlainFails?: boolean
}

function fakeSender(behaviour: Behaviour = {}) {
  const calls: string[] = []
  const sent: string[] = []
  const sender: TelegramSender = {
    sendHtml: async (_chat, html) => {
      calls.push('sendHtml')
      sent.push(html)
      if (behaviour.htmlFails) throw new Error("Bad Request: can't parse entities")
      return 11
    },
    sendPlain: async (_chat, text) => {
      calls.push('sendPlain')
      sent.push(text)
      return 22
    },
    editHtml: async (_chat, _id, html) => {
      calls.push('editHtml')
      sent.push(html)
      if (behaviour.editHtmlFails) throw new Error("Bad Request: can't parse entities")
    },
    editPlain: async (_chat, _id, text) => {
      calls.push('editPlain')
      sent.push(text)
      if (behaviour.editPlainFails) throw new Error('message is not modified')
    },
  }
  return { sender, calls, sent }
}

describe('toHtml', () => {
  it('draws a shell command as a fenced block carrying its language', () => {
    // The whole point: the language is what makes Telegram draw the client's own
    // code block, which a rich message did not.
    expect(toHtml('⚡ **shell_command**\n\n```shell\nls -la\n```')).toBe(
      '⚡ <b>shell_command</b>\n\n<pre><code class="language-shell">ls -la</code></pre>',
    )
  })

  it('keeps the command as it was written, quoting and all', () => {
    expect(toHtml('```shell\necho "--- health ---" && curl a?b=1&c=2\n```')).toBe(
      '<pre><code class="language-shell">echo "--- health ---" &amp;&amp; curl a?b=1&amp;c=2</code></pre>',
    )
  })

  it('closes a block whose fence the message limit cut off', () => {
    // A long turn is clamped by characters, so the closing fence can be gone.
    expect(toHtml('```shell\nnpm test\n… (trimmed) …\nthe end')).toBe(
      '<pre><code class="language-shell">npm test\n… (trimmed) …\nthe end</code></pre>',
    )
  })

  it('draws a bare fence as a block without a language', () => {
    expect(toHtml('```\nplain\n```')).toBe('<pre>plain</pre>')
  })

  it('joins a run of tool lines into one quotation', () => {
    expect(toHtml('> 📄 **read_file** a.txt  \n> 🔍 **grep** alpha')).toBe(
      '<blockquote>📄 <b>read_file</b> a.txt\n🔍 <b>grep</b> alpha</blockquote>',
    )
  })

  it('renders inline code, bold and a link', () => {
    expect(toHtml('veja **isso** e `npm test` em [aqui](https://t.me/a?x=1)')).toBe(
      'veja <b>isso</b> e <code>npm test</code> em <a href="https://t.me/a?x=1">aqui</a>',
    )
  })

  it('escapes markup the model wrote as text', () => {
    expect(toHtml('o valor < 5 && a > b')).toBe('o valor &lt; 5 &amp;&amp; a &gt; b')
  })

  it('turns a heading into a bold line, which is the closest thing HTML mode has', () => {
    expect(toHtml('## Resumo\nfeito')).toBe('<b>Resumo</b>\nfeito')
  })
})

describe('toPlain', () => {
  it('drops the markup and keeps the words and the code', () => {
    expect(toPlain('⚡ **shell_command**\n\n```shell\nls -la\n```\n\n> 📄 **read_file** a')).toBe(
      '⚡ shell_command\n\nls -la\n\n📄 read_file a',
    )
  })
})

describe('TelegramMessenger', () => {
  it('posts the rendered HTML when the API accepts it', async () => {
    const { sender, calls, sent } = fakeSender()
    const id = await new TelegramMessenger(sender).post('1', '⚡ **shell_command**')

    expect(id).toBe(11)
    expect(calls).toEqual(['sendHtml'])
    expect(sent).toEqual(['⚡ <b>shell_command</b>'])
  })

  it('falls back to plain text, without the markup, when the API refuses the HTML', async () => {
    const { sender, calls, sent } = fakeSender({ htmlFails: true })
    const id = await new TelegramMessenger(sender).post('1', '⚡ **shell_command**')

    expect(id).toBe(22)
    expect(calls).toEqual(['sendHtml', 'sendPlain'])
    // Never the raw Markdown: what the person gets is the words, not the fences.
    expect(sent.at(-1)).toBe('⚡ shell_command')
  })

  it('stays plain for the rest of the message after a failure', async () => {
    const { sender, calls } = fakeSender({ htmlFails: true })
    const messenger = new TelegramMessenger(sender)
    await messenger.post('1', 'a')
    await messenger.edit('1', 22, 'b')

    expect(calls).toEqual(['sendHtml', 'sendPlain', 'editPlain'])
    expect(messenger.usingHtml).toBe(false)
  })

  it('edits as HTML while it works', async () => {
    const { sender, calls } = fakeSender()
    const messenger = new TelegramMessenger(sender)
    await messenger.edit('1', 11, 'a')
    await messenger.edit('1', 11, 'b')

    expect(calls).toEqual(['editHtml', 'editHtml'])
    expect(messenger.usingHtml).toBe(true)
  })

  it('degrades to plain edits when an HTML edit fails, and stays there', async () => {
    const { sender, calls } = fakeSender({ editHtmlFails: true })
    const messenger = new TelegramMessenger(sender)
    await messenger.edit('1', 11, 'a')
    await messenger.edit('1', 11, 'b')

    expect(calls).toEqual(['editHtml', 'editPlain', 'editPlain'])
    expect(messenger.usingHtml).toBe(false)
  })

  it('lets an edit failure surface so the caller can swallow it', async () => {
    const { sender } = fakeSender({ editHtmlFails: true, editPlainFails: true })
    await expect(new TelegramMessenger(sender).edit('1', 11, 'a')).rejects.toThrow(/not modified/)
  })
})

describe('isNotModified', () => {
  it('recognises the benign edit error', () => {
    expect(isNotModified({ description: 'Bad Request: message is not modified' })).toBe(true)
  })

  it('ignores anything else', () => {
    expect(isNotModified(new Error('cannot parse entities'))).toBe(false)
    expect(isNotModified(undefined)).toBe(false)
  })
})
