import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '../src/core/agent/events.js'
import type { DisplayConfig } from '../src/core/config/schema.js'
import type { Session, SendOptions } from '../src/core/session.js'
import type { PermissionRequest } from '../src/core/tools/permission.js'
import { runTurn } from '../src/gateways/runner.js'
import type { ChatSurface } from '../src/gateways/surface.js'

type StreamFn = (options?: SendOptions) => AsyncGenerator<AgentEvent>

function makeHarness(stream: StreamFn, askAnswer = true, display?: DisplayConfig) {
  const edits: string[] = []
  const asks: PermissionRequest[] = []
  /** The transport's working indicator: started how often, stopped how often. */
  const typing = { starts: [] as string[], stops: 0 }

  const surface: ChatSurface = {
    post: async () => 'm1',
    edit: async (_conversationId, _messageId, text) => {
      edits.push(text)
    },
    ask: async (_conversationId, _messageId, request) => {
      asks.push(request)
      return askAnswer
    },
    typing: (conversationId) => {
      typing.starts.push(conversationId)
      return () => {
        typing.stops += 1
      }
    },
  }

  const session = {
    messages: [],
    send: (_text: string, options?: SendOptions) => stream(options),
  } as unknown as Session

  const run = (maxLength = 1000, steering?: string[]) =>
    runTurn({ session, conversationId: 'c1', text: 'hi', surface, maxLength, display, flushMs: 0, steering })

  return { edits, asks, typing, run }
}

describe('runTurn', () => {
  it('streams text into the message, ending with the full answer', async () => {
    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'text-delta', delta: 'Hello' }
      yield { type: 'text-delta', delta: ' world' }
      yield { type: 'done', finishReason: 'stop' }
    }

    const harness = makeHarness(stream)
    await harness.run()
    expect(harness.edits.at(-1)).toBe('Hello world')
  })

  it('keeps the transport’s working indicator on for the turn, and off after it', async () => {
    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'text-delta', delta: 'Hello' }
      yield { type: 'done', finishReason: 'stop' }
    }

    const harness = makeHarness(stream)
    await harness.run()

    // The wait before the first token is the longest part of a turn: a bare '…'
    // says nothing about whether anything is happening.
    expect(harness.typing.starts).toEqual(['c1'])
    expect(harness.typing.stops).toBe(1)
  })

  it('stops the indicator even when the turn fails', async () => {
    // biome-ignore lint/correctness/useYield: a turn that dies before yielding anything is the case being tested
    async function* stream(): AsyncGenerator<AgentEvent> {
      throw new Error('provider died')
    }

    const harness = makeHarness(stream)
    await harness.run()

    // A turn that ended badly is still a turn that ended: an indicator left
    // running says the bot is working at something long over.
    expect(harness.typing.starts).toEqual(['c1'])
    expect(harness.typing.stops).toBe(1)
    expect(harness.edits.at(-1)).toContain('[error] provider died')
  })

  it('says when it waited for another Milo, and what that Milo wrote', async () => {
    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'waiting' }
      yield { type: 'waited', ms: 1200 }
      yield { type: 'rebased', added: 1, compacted: false }
      yield { type: 'text-delta', delta: 'answer' }
      yield { type: 'done', finishReason: 'stop' }
    }

    const harness = makeHarness(stream)
    await harness.run()
    // Both on screen: the wait, so the quiet is attributed to the other Milo,
    // and the turns it wrote, since the answer draws on them. The end of the
    // wait adds nothing — a chat surface has no status line, and the line it
    // already has says where the time went.
    expect(harness.edits.at(-1)).toBe(
      '⏳ another Milo is using this session — waiting for it to finish\n\n' +
        '↺ another Milo has used this session: 1 new message\n\n' +
        'answer',
    )
  })

  it('says when the turns it cannot see were summarized away, not only added to', async () => {
    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'rebased', added: 0, compacted: true }
      yield { type: 'text-delta', delta: 'answer' }
      yield { type: 'done', finishReason: 'stop' }
    }

    const harness = makeHarness(stream)
    await harness.run()
    // Nothing was added and there is still something to say: turns the screen
    // showed are gone from the context, and that is not something to hide.
    expect(harness.edits.at(-1)).toBe(
      '↺ another Milo has used this session: the earlier turns are summarized\n\nanswer',
    )
  })

  it('appends tool activity as lines', async () => {
    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'tool-start', id: '1', name: 'read_file', args: {} }
      yield { type: 'tool-end', id: '1', name: 'read_file', result: 'ok', isError: false }
      yield { type: 'text-delta', delta: 'done' }
      yield { type: 'done', finishReason: 'stop' }
    }

    const harness = makeHarness(stream)
    await harness.run()
    // The names are bold on a chat surface, so a name does not read as the
    // first word of the arguments beside it.
    expect(harness.edits.at(-1)).toBe('> 📄 **read_file**\n\ndone')
  })

  it('keeps a run of tool lines in one quote, without letting them reflow', async () => {
    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'tool-start', id: '1', name: 'read_file', args: {} }
      yield { type: 'tool-end', id: '1', name: 'read_file', result: 'ok', isError: false }
      yield { type: 'tool-start', id: '2', name: 'web_search', args: {} }
      yield { type: 'tool-end', id: '2', name: 'web_search', result: 'ok', isError: false }
      yield { type: 'text-delta', delta: 'answer' }
      yield { type: 'done', finishReason: 'stop' }
    }

    const harness = makeHarness(stream)
    await harness.run()
    // One quote for the burst, and the lines kept apart inside it by a hard
    // break (two spaces before the newline): a plain newline in a paragraph is a
    // soft break, and the second tool line would reflow into the first sentence.
    expect(harness.edits.at(-1)).toBe('> 📄 **read_file**  \n> 🌐 **web_search**\n\nanswer')
  })

  it('opens a new block for tools after the prose', async () => {
    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'tool-start', id: '1', name: 'read_file', args: {} }
      yield { type: 'tool-end', id: '1', name: 'read_file', result: 'ok', isError: false }
      yield { type: 'text-delta', delta: 'achei' }
      yield { type: 'tool-start', id: '2', name: 'shell_command', args: {} }
      yield { type: 'tool-end', id: '2', name: 'shell_command', result: 'ok', isError: false }
      yield { type: 'text-delta', delta: 'pronto' }
      yield { type: 'done', finishReason: 'stop' }
    }

    const harness = makeHarness(stream)
    await harness.run()
    expect(harness.edits.at(-1)).toBe(
      '> 📄 **read_file**\n\nachei\n\n> ⚡ **shell_command**\n\npronto',
    )
  })

  it('shows a shell command as a fenced block, with the name outside it', async () => {
    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'tool-start', id: '1', name: 'shell_command', args: { command: 'echo hi' } }
      yield { type: 'tool-end', id: '1', name: 'shell_command', result: 'hi', isError: false }
      yield { type: 'text-delta', delta: 'pronto' }
      yield { type: 'done', finishReason: 'stop' }
    }

    const harness = makeHarness(stream)
    await harness.run()
    // The label is not inside the fence, so it is still emphasised — which is one
    // of the two things that took the block away the first time it was here.
    expect(harness.edits.at(-1)).toBe('⚡ **shell_command**\n\n```shell\necho hi\n```\n\npronto')
  })

  it('puts the command in whole, not the 120-character gist', async () => {
    const long = `echo ${'x'.repeat(200)}`
    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'tool-start', id: '1', name: 'shell_command', args: { command: long } }
      yield { type: 'tool-end', id: '1', name: 'shell_command', result: 'ok', isError: false }
      yield { type: 'done', finishReason: 'stop' }
    }

    const harness = makeHarness(stream)
    await harness.run()
    // The other one: a block whose contents were cut off is a block that lies
    // about what it is for.
    expect(harness.edits.at(-1)).toBe(`⚡ **shell_command**\n\n\`\`\`shell\n${long}\n\`\`\``)
  })

  it('gives each of two shell commands its own block', async () => {
    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'tool-start', id: '1', name: 'shell_command', args: { command: 'ls' } }
      yield { type: 'tool-end', id: '1', name: 'shell_command', result: 'ok', isError: false }
      yield { type: 'tool-start', id: '2', name: 'shell_command', args: { command: 'pwd' } }
      yield { type: 'tool-end', id: '2', name: 'shell_command', result: 'ok', isError: false }
      yield { type: 'text-delta', delta: 'pronto' }
      yield { type: 'done', finishReason: 'stop' }
    }

    const harness = makeHarness(stream)
    await harness.run()
    // A fence is a block of its own, so it ends the run of tool lines rather than
    // joining it — the next call opens a quote (or a block) of its own.
    expect(harness.edits.at(-1)).toBe(
      '⚡ **shell_command**\n\n```shell\nls\n```\n\n⚡ **shell_command**\n\n```shell\npwd\n```\n\npronto',
    )
  })

  it('ends on the tool line itself when the turn ends right after it', async () => {
    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'tool-start', id: '1', name: 'shell_command', args: { command: 'ls' } }
      yield { type: 'tool-end', id: '1', name: 'shell_command', result: 'ok', isError: false }
      yield { type: 'done', finishReason: 'stop' }
    }

    const harness = makeHarness(stream)
    await harness.run()
    expect(harness.edits.at(-1)).toBe('⚡ **shell_command**\n\n```shell\nls\n```')
  })

  it('separates tool lines from prose with a blank line, not a soft break', async () => {
    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'text-delta', delta: 'Vou rodar' }
      yield { type: 'tool-start', id: '1', name: 'shell_command', args: {} }
      yield { type: 'tool-end', id: '1', name: 'shell_command', result: 'ok', isError: false }
      yield { type: 'text-delta', delta: 'Rodou.' }
      yield { type: 'done', finishReason: 'stop' }
    }

    const harness = makeHarness(stream)
    await harness.run()
    expect(harness.edits.at(-1)).toBe('Vou rodar\n\n> ⚡ **shell_command**\n\nRodou.')
  })

  it('gives web_search the globe instead of the marker', async () => {
    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'tool-start', id: '1', name: 'web_search', args: {} }
      yield { type: 'tool-end', id: '1', name: 'web_search', result: 'ok', isError: false }
      yield { type: 'text-delta', delta: 'found' }
      yield { type: 'done', finishReason: 'stop' }
    }

    const harness = makeHarness(stream)
    await harness.run()
    expect(harness.edits.at(-1)).toBe('> 🌐 **web_search**\n\nfound')
  })

  it('marks a failed tool', async () => {
    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'tool-start', id: '1', name: 'shell_command', args: {} }
      yield { type: 'tool-end', id: '1', name: 'shell_command', result: 'nope', isError: true }
      yield { type: 'done', finishReason: 'stop' }
    }

    const harness = makeHarness(stream)
    await harness.run()
    // The name is emphasised here too: a failure line is one of these lines, and
    // it is drawn the same way whichever tool failed.
    expect(harness.edits.at(-1)).toContain('❌ **shell_command** failed')
  })

  it('routes permission requests to the surface and reflects the answer', async () => {
    async function* stream(options?: SendOptions): AsyncGenerator<AgentEvent> {
      const result = await options!.ask!({
        tool: 'shell_command',
        args: { command: 'rm -rf build' },
        summary: 'rm -rf build',
      })
      yield { type: 'text-delta', delta: result.allowed ? 'ran it' : 'denied' }
      yield { type: 'done', finishReason: 'stop' }
    }

    const harness = makeHarness(stream, false)
    await harness.run()

    expect(harness.asks).toHaveLength(1)
    expect(harness.asks[0]?.tool).toBe('shell_command')
    expect(harness.edits.at(-1)).toBe('denied')
  })

  it('hands the steering inbox to the session, for the next step boundary', async () => {
    let seen: string[] | undefined
    async function* stream(options?: SendOptions): AsyncGenerator<AgentEvent> {
      seen = options?.steering
      yield { type: 'text-delta', delta: 'ok' }
      yield { type: 'done', finishReason: 'stop' }
    }

    const steering = ['wait, use b.txt']
    await makeHarness(stream).run(1000, steering)

    // The very array, not a copy: what is left in it when the turn ends is what
    // the caller runs as the next turn.
    expect(seen).toBe(steering)
  })

  it('surfaces errors from the stream', async () => {
    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'error', message: 'boom' }
    }
    const harness = makeHarness(stream)
    await harness.run()
    expect(harness.edits.at(-1)).toContain('[error] boom')
  })

  it('truncates long output', async () => {
    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'text-delta', delta: 'x'.repeat(50) }
    }
    const harness = makeHarness(stream)
    await harness.run(10)

    const last = harness.edits.at(-1) ?? ''
    expect(last.length).toBeLessThanOrEqual(10)
    expect(last.endsWith('…')).toBe(true)
  })

  it('says why a turn showed nothing when the level hid it all', async () => {
    async function* stream(): AsyncGenerator<AgentEvent> {
      // The answer arrives as reasoning — a provider filling one field with both
      // channels — and `off` keeps none of it.
      yield { type: 'reasoning-delta', delta: 'Oi! Em que posso ajudar?' }
      yield { type: 'done', finishReason: 'stop' }
    }

    const harness = makeHarness(stream, true, { tools: 'full', thinking: 'off' })
    await harness.run()

    const last = harness.edits.at(-1) ?? ''
    expect(last).toContain('no answer came back')
    expect(last).not.toContain('Em que posso ajudar')
  })

  it('does not count a bare newline as the answer', async () => {
    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'reasoning-delta', delta: 'Oi! Em que posso ajudar?' }
      yield { type: 'text-delta', delta: '\n' }
      yield { type: 'done', finishReason: 'stop' }
    }

    const harness = makeHarness(stream, true, { tools: 'full', thinking: 'off' })
    await harness.run()

    // With the level hiding the thinking, a newline would otherwise be the whole
    // turn and the note would never be written.
    expect(harness.edits.at(-1)).toContain('no answer came back')
  })

  it('says (no response) when the model produced nothing at all', async () => {
    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'done', finishReason: 'stop' }
    }
    const harness = makeHarness(stream)
    await harness.run()
    expect(harness.edits.at(-1)).toBe('(no response)')
  })
})

describe('runTurn — display settings', () => {
  async function* withCommand(): AsyncGenerator<AgentEvent> {
    yield { type: 'tool-start', id: '1', name: 'shell_command', args: { command: 'echo hi' } }
    yield { type: 'tool-end', id: '1', name: 'shell_command', result: 'hi', isError: false }
    yield { type: 'text-delta', delta: 'pronto' }
    yield { type: 'done', finishReason: 'stop' }
  }

  it('shows only the tool name when asked for names', async () => {
    const harness = makeHarness(withCommand, true, { tools: 'name', thinking: 'on' })
    await harness.run()
    expect(harness.edits.at(-1)).toBe('> ⚡ **shell_command**\n\npronto')
  })

  it('keeps tool activity out entirely when off', async () => {
    const harness = makeHarness(withCommand, true, { tools: 'off', thinking: 'on' })
    await harness.run()
    expect(harness.edits.at(-1)).toBe('pronto')
  })

  it('reports a failure even with tools off', async () => {
    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'tool-start', id: '1', name: 'shell_command', args: { command: 'nope' } }
      yield { type: 'tool-end', id: '1', name: 'shell_command', result: 'bad', isError: true }
      yield { type: 'done', finishReason: 'stop' }
    }

    const harness = makeHarness(stream, true, { tools: 'off', thinking: 'on' })
    await harness.run()
    expect(harness.edits.at(-1)).toBe('> ❌ **shell_command** failed')
  })

  it('shows the first line of the reasoning as one line', async () => {
    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'reasoning-delta', delta: 'Preciso conferir o\n' }
      yield { type: 'reasoning-delta', delta: 'segundo   parágrafo\n' }
      yield { type: 'text-delta', delta: 'pronto' }
      yield { type: 'done', finishReason: 'stop' }
    }

    const harness = makeHarness(stream)
    await harness.run()
    expect(harness.edits.at(-1)).toBe('> 💭 Preciso conferir o\n\npronto')
  })

  it('drops the reasoning when thinking is off', async () => {
    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'reasoning-delta', delta: 'algo que não deve aparecer\n' }
      yield { type: 'text-delta', delta: 'pronto' }
      yield { type: 'done', finishReason: 'stop' }
    }

    const harness = makeHarness(stream, true, { tools: 'full', thinking: 'off' })
    await harness.run()
    expect(harness.edits.at(-1)).toBe('pronto')
  })

  it('keeps a long thought to one truncated line', async () => {
    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'reasoning-delta', delta: 'x'.repeat(500) }
      yield { type: 'done', finishReason: 'stop' }
    }

    const harness = makeHarness(stream)
    await harness.run()

    const last = harness.edits.at(-1) ?? ''
    expect(last.startsWith('> 💭 ')).toBe(true)
    expect(last).toContain('…')
    expect(last.split('\n')).toHaveLength(1)
  })

  it('does not let a thought merge into the tool block around it', async () => {
    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'reasoning-delta', delta: 'first thought\n' }
      yield { type: 'tool-start', id: '1', name: 'web_search', args: { query: 'preços' } }
      yield { type: 'tool-end', id: '1', name: 'web_search', result: 'ok', isError: false }
      yield { type: 'reasoning-delta', delta: 'second thought\n' }
      yield { type: 'tool-start', id: '2', name: 'web_search', args: { query: 'modelos' } }
      yield { type: 'tool-end', id: '2', name: 'web_search', result: 'ok', isError: false }
      yield { type: 'text-delta', delta: 'pronto' }
      yield { type: 'done', finishReason: 'stop' }
    }

    const harness = makeHarness(stream)
    await harness.run()

    // Each thought is its own quote block. Merged into the tool block, a thought
    // reads as the tail of the previous call's arguments — the screenshot that
    // started this.
    expect(harness.edits.at(-1)).toBe(
      [
        '> 💭 first thought',
        '',
        '> 🌐 **web_search** preços',
        '',
        '> 💭 second thought',
        '',
        '> 🌐 **web_search** modelos',
        '',
        'pronto',
      ].join('\n'),
    )
  })

  it('ends the run of tool lines at a shell block, and opens a quote again after it', async () => {
    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'tool-start', id: '1', name: 'web_search', args: { query: 'a' } }
      yield { type: 'tool-end', id: '1', name: 'web_search', result: 'ok', isError: false }
      yield { type: 'tool-start', id: '2', name: 'shell_command', args: { command: 'ls' } }
      yield { type: 'tool-end', id: '2', name: 'shell_command', result: 'ok', isError: false }
      yield { type: 'tool-start', id: '3', name: 'read_file', args: { path: 'a.txt' } }
      yield { type: 'tool-end', id: '3', name: 'read_file', result: 'ok', isError: false }
      yield { type: 'done', finishReason: 'stop' }
    }

    const harness = makeHarness(stream)
    await harness.run()
    // A fence is a block of its own, so it cannot be a line inside the quote: the
    // calls before it keep their quote, and the one after opens its own rather
    // than pretending to continue a paragraph the block ended.
    expect(harness.edits.at(-1)).toBe(
      [
        '> 🌐 **web_search** a',
        '',
        '⚡ **shell_command**',
        '',
        '```shell',
        'ls',
        '```',
        '',
        '> 📄 **read_file** a.txt',
      ].join('\n'),
    )
  })

  it('says a stopped turn was stopped rather than reporting an error', async () => {
    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'text-delta', delta: 'half an ans' }
      yield { type: 'aborted' }
    }

    const harness = makeHarness(stream)
    await harness.run()

    const last = harness.edits.at(-1) ?? ''
    expect(last).toContain('🛑 stopped')
    expect(last).not.toContain('[error]')
    // The partial answer is still worth keeping.
    expect(last).toContain('half an ans')
  })

  it('warns that an answer was cut off at the output limit', async () => {
    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'text-delta', delta: 'the answer starts and then' }
      yield { type: 'done', finishReason: 'length' }
    }

    const harness = makeHarness(stream)
    await harness.run()

    const last = harness.edits.at(-1) ?? ''
    expect(last).toContain('the answer starts and then')
    expect(last).toContain('output limit')
  })

  it('says nothing extra when the answer finished on its own', async () => {
    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'text-delta', delta: 'complete' }
      yield { type: 'done', finishReason: 'stop' }
    }

    const harness = makeHarness(stream)
    await harness.run()
    expect(harness.edits.at(-1)).toBe('complete')
  })

  it('keeps the end of a turn that outgrew the message limit', async () => {
    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'tool-start', id: '1', name: 'shell_command', args: { command: 'npm test' } }
      yield { type: 'tool-end', id: '1', name: 'shell_command', result: 'ok', isError: false }
      yield { type: 'text-delta', delta: `${'A'.repeat(200)}THE-ANSWER-IS-AT-THE-END` }
      yield { type: 'done', finishReason: 'stop' }
    }

    // A limit the turn blows past, with the tool log taking the front of it.
    const harness = makeHarness(stream)
    await harness.run(200)

    const last = harness.edits.at(-1) ?? ''
    expect(last.length).toBeLessThanOrEqual(200)
    expect(last).toContain('trimmed to fit')
    expect(last.endsWith('THE-ANSWER-IS-AT-THE-END')).toBe(true)
  })
})
