import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '../src/core/agent/events'
import type { Session, SendOptions } from '../src/core/session'
import type { PermissionRequest } from '../src/core/tools/permission'
import { runTurn } from '../src/gateways/runner'
import type { ChatSurface } from '../src/gateways/surface'

type StreamFn = (options?: SendOptions) => AsyncGenerator<AgentEvent>

function makeHarness(stream: StreamFn, askAnswer = true) {
  const edits: string[] = []
  const asks: PermissionRequest[] = []

  const surface: ChatSurface = {
    post: async () => 'm1',
    edit: async (_conversationId, _messageId, text) => {
      edits.push(text)
    },
    ask: async (_conversationId, _messageId, request) => {
      asks.push(request)
      return askAnswer
    },
  }

  const session = {
    messages: [],
    send: (_text: string, options?: SendOptions) => stream(options),
  } as unknown as Session

  const run = (maxLength = 1000) =>
    runTurn({ session, conversationId: 'c1', text: 'hi', surface, maxLength, flushMs: 0 })

  return { edits, asks, run }
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

  it('appends tool activity as lines', async () => {
    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'tool-start', id: '1', name: 'read_file', args: {} }
      yield { type: 'tool-end', id: '1', name: 'read_file', result: 'ok', isError: false }
      yield { type: 'text-delta', delta: 'done' }
      yield { type: 'done', finishReason: 'stop' }
    }

    const harness = makeHarness(stream)
    await harness.run()
    expect(harness.edits.at(-1)).toBe('> 📄 read_file\n\ndone')
  })

  it('keeps consecutive tool calls inside one quote block', async () => {
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
    // Only the first line carries `>`: repeating it inside the block makes
    // Telegram render the marker as literal text.
    expect(harness.edits.at(-1)).toBe('> 📄 read_file\n🌐 web_search\n\nanswer')
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
    expect(harness.edits.at(-1)).toBe('> 📄 read_file\n\nachei\n\n```\n⚡ shell_command\n```\n\npronto')
  })

  it('shows a shell command as a code block with the command itself', async () => {
    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'tool-start', id: '1', name: 'shell_command', args: { command: 'echo hi' } }
      yield { type: 'tool-end', id: '1', name: 'shell_command', result: 'hi', isError: false }
      yield { type: 'text-delta', delta: 'pronto' }
      yield { type: 'done', finishReason: 'stop' }
    }

    const harness = makeHarness(stream)
    await harness.run()
    expect(harness.edits.at(-1)).toBe('```\n⚡ shell_command echo hi\n```\n\npronto')
  })

  it('keeps consecutive shell commands in one code block', async () => {
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
    expect(harness.edits.at(-1)).toBe('```\n⚡ shell_command ls\n⚡ shell_command pwd\n```\n\npronto')
  })

  it('closes an open code block even when the turn ends right after it', async () => {
    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'tool-start', id: '1', name: 'shell_command', args: { command: 'ls' } }
      yield { type: 'tool-end', id: '1', name: 'shell_command', result: 'ok', isError: false }
      yield { type: 'done', finishReason: 'stop' }
    }

    const harness = makeHarness(stream)
    await harness.run()
    expect(harness.edits.at(-1)).toBe('```\n⚡ shell_command ls\n```')
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
    expect(harness.edits.at(-1)).toBe('Vou rodar\n\n```\n⚡ shell_command\n```\n\nRodou.')
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
    expect(harness.edits.at(-1)).toBe('> 🌐 web_search\n\nfound')
  })

  it('marks a failed tool', async () => {
    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'tool-start', id: '1', name: 'shell_command', args: {} }
      yield { type: 'tool-end', id: '1', name: 'shell_command', result: 'nope', isError: true }
      yield { type: 'done', finishReason: 'stop' }
    }

    const harness = makeHarness(stream)
    await harness.run()
    expect(harness.edits.at(-1)).toContain('❌ shell_command failed')
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

  it('says (no response) when nothing was produced', async () => {
    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'done', finishReason: 'stop' }
    }
    const harness = makeHarness(stream)
    await harness.run()
    expect(harness.edits.at(-1)).toBe('(no response)')
  })
})
