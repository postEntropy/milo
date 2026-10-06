import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from 'ink-testing-library'
import type { AgentEvent } from '../src/core/agent/events.js'
import type { DisplayConfig } from '../src/core/config/schema.js'
import type { AgentRuntime } from '../src/core/runtime.js'
import type { PermissionMode } from '../src/core/tools/permission.js'
import type { ReasoningEffort } from '../src/core/providers/types.js'
import type { Item } from '../src/gateways/cli/transcript.js'

// A throwaway home pointed at *before* the chat module loads: every line sent is
// written to the arrow history under it, and a test must not touch ~/.milo.
const home = mkdtempSync(path.join(tmpdir(), 'milo-chat-'))
process.env.MILO_HOME = home

const { ChatScreen } = await import('../src/gateways/cli/screens/chat.js')
const { ModelPicker } = await import('../src/gateways/cli/screens/model-picker.js')

const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms))
const scope = { gateway: 'cli', conversationId: 'test' }
const UP = '\u001b[A'
const DOWN = '\u001b[B'

/** Waits for a side effect (the history file) instead of racing it. */
async function waitUntil(check: () => boolean, timeoutMs = 1500): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (check()) return
    await tick(20)
  }
  throw new Error('timed out waiting for condition')
}

/**
 * The frame that carries `text`.
 *
 * A render lands a tick or more after the events that cause it, and a fixed
 * `tick()` before reading the frame raced it: on Node 20 the frame was still the
 * previous one, which looked like a failure in the code under test and was not.
 */
async function waitForFrame(lastFrame: () => string | undefined, text: string): Promise<string> {
  await waitUntil(() => (lastFrame() ?? '').includes(text))
  return lastFrame() ?? ''
}

function makeRuntime(stream: () => AsyncGenerator<AgentEvent>): AgentRuntime {
  return {
    getSession: () => ({ messages: [], send: () => stream() }),
  } as unknown as AgentRuntime
}

/** A runtime that records what each turn was sent, for the input-history tests. */
function recordingRuntime(sent: string[]): AgentRuntime {
  async function* stream(): AsyncGenerator<AgentEvent> {
    yield { type: 'done', finishReason: 'stop' }
  }
  return {
    getSession: () => ({
      messages: [],
      send: (text: string) => {
        sent.push(text)
        return stream()
      },
    }),
  } as unknown as AgentRuntime
}

async function type(stdin: { write: (data: string) => void }, text: string): Promise<void> {
  stdin.write(text)
  await tick(20)
}

async function submit(stdin: { write: (data: string) => void }, text: string): Promise<void> {
  await type(stdin, text)
  stdin.write('\r')
  await tick()
}

interface RenderOptions {
  mode?: PermissionMode
  onModeChange?: (mode: PermissionMode) => void
  onEffortChange?: (effort: ReasoningEffort) => void
  display?: DisplayConfig
  onDisplayChange?: (patch: Partial<DisplayConfig>) => void
  onOpenModel?: () => void
  onOpenSettings?: () => void
  onSessionChange?: (id: string) => void
}

function Harness({ runtime, options }: { runtime: AgentRuntime; options: RenderOptions }) {
  const [items, setItems] = useState<Item[]>([])
  return (
    <ChatScreen
      runtime={runtime}
      scope={scope}
      mode={options.mode ?? 'ask'}
      onModeChange={options.onModeChange ?? (() => {})}
      onEffortChange={options.onEffortChange ?? (() => {})}
      display={options.display ?? { tools: 'full', thinking: 'on' }}
      onDisplayChange={options.onDisplayChange ?? (() => {})}
      items={items}
      setItems={setItems}
      onOpenModel={options.onOpenModel ?? (() => {})}
      onOpenSettings={options.onOpenSettings ?? (() => {})}
      onExit={() => {}}
      onSessionChange={options.onSessionChange}
    />
  )
}

function renderChat(runtime: AgentRuntime, options: RenderOptions = {}) {
  return render(<Harness runtime={runtime} options={options} />)
}

afterEach(() => cleanup())

describe('ChatScreen', () => {
  it('shows a thinking indicator before the first token, then the answer', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    async function* stream(): AsyncGenerator<AgentEvent> {
      await gate
      yield { type: 'text-delta', delta: 'Hi there' }
      yield { type: 'done', finishReason: 'stop' }
    }

    const { lastFrame, stdin } = renderChat(makeRuntime(stream))

    await submit(stdin, 'hello')
    expect(lastFrame()).toContain('thinking…')

    release()
    await tick()

    expect(lastFrame()).toContain('Hi there')
    expect(lastFrame()).not.toContain('thinking…')
  })

  it('names the wait for another Milo, and what that Milo wrote', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'waiting' }
      await gate
      yield { type: 'waited', ms: 1200 }
      yield { type: 'rebased', added: 2, removed: 0, compacted: false }
      yield { type: 'text-delta', delta: 'carrying on' }
      yield { type: 'done', finishReason: 'stop' }
    }

    const { lastFrame, stdin } = renderChat(makeRuntime(stream))
    await submit(stdin, 'hello')
    // The wait is named while it lasts, not after: the quiet has to be
    // attributed to the other Milo rather than to the model.
    expect(lastFrame()).toContain('waiting for another Milo')

    release()
    await tick(80)

    const frame = lastFrame() ?? ''
    // Then once, in the transcript, with what it actually cost.
    expect(frame).toContain('waited 1.2s for another Milo')
    // And turns taken elsewhere are on screen, since the answer draws on them.
    expect(frame).toContain('2 new messages')
    expect(frame).toContain('carrying on')
  })

  it('renders a tool line and the final answer', async () => {
    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'reasoning-delta', delta: 'pondering the request' }
      yield { type: 'tool-start', id: 'c1', name: 'read_file', args: { path: 'a.txt' } }
      yield { type: 'tool-end', id: 'c1', name: 'read_file', result: 'ok', isError: false }
      yield { type: 'text-delta', delta: 'all done' }
      yield { type: 'done', finishReason: 'stop' }
    }

    const { lastFrame, stdin } = renderChat(makeRuntime(stream))
    await submit(stdin, 'read a.txt')

    const frame = lastFrame() ?? ''
    expect(frame).toContain('read_file')
    expect(frame).toContain('all done')
  })

  it('keeps a step apart from the one before it, around the tool call', async () => {
    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'text-delta', delta: 'Vou conferir o código.' }
      yield { type: 'tool-start', id: 'c1', name: 'read_file', args: { path: 'yolo.ts' } }
      yield { type: 'tool-end', id: 'c1', name: 'read_file', result: 'ok', isError: false }
      yield { type: 'text-delta', delta: 'Não. Em yolo decide() retorna allow.' }
      yield { type: 'done', finishReason: 'stop' }
    }

    const { lastFrame, stdin } = renderChat(makeRuntime(stream))
    await submit(stdin, 'o yolo confirma?')

    const frame = await waitForFrame(lastFrame, 'Não. Em yolo')
    // Two messages of the same turn, not one sentence glued at the seam.
    expect(frame).not.toContain('código.Não')

    const lines = frame.split('\n').map((line) => line.trim())
    const preamble = lines.findIndex((line) => line.includes('Vou conferir o código.'))
    const tool = lines.findIndex((line) => line.includes('read_file'))
    const answer = lines.findIndex((line) => line.includes('Não. Em yolo'))
    // And said in the order they were said: preamble, the call it announced,
    // then what the call let it answer.
    expect(preamble).toBeGreaterThan(-1)
    expect(preamble).toBeLessThan(tool)
    expect(tool).toBeLessThan(answer)
  })

  it('reports a session that fails to load instead of dropping the turn', async () => {
    const runtime = {
      getSession: async () => {
        throw new Error('disk on fire')
      },
    } as unknown as AgentRuntime

    const { lastFrame, stdin } = renderChat(runtime)
    await submit(stdin, 'hello')
    await tick()

    const frame = lastFrame() ?? ''
    expect(frame).toContain('disk on fire')
    // The prompt comes back: the failure ended the turn, not the session.
    expect(frame).toContain('Type a message')
  })

  it('shows the answer without the markdown markers it rendered', async () => {
    async function* stream(): AsyncGenerator<AgentEvent> {
      yield {
        type: 'text-delta',
        delta: 'Aqui:\n\n```json\n{ "ok": true }\n```\n\nUse `npm test` e **cuidado**.\n',
      }
      yield { type: 'done', finishReason: 'stop' }
    }

    const { lastFrame, stdin } = renderChat(makeRuntime(stream))
    await submit(stdin, 'como testo?')

    const frame = await waitForFrame(lastFrame, 'Use npm test')
    expect(frame).toContain('{ "ok": true }')
    expect(frame).toContain('Use npm test e cuidado.')
    expect(frame).not.toContain('```')
    expect(frame).not.toContain('**')
  })

  it('anchors short content to the bottom of the pane', async () => {
    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'text-delta', delta: 'hi' }
      yield { type: 'done', finishReason: 'stop' }
    }

    const { lastFrame, stdin } = renderChat(makeRuntime(stream))
    await submit(stdin, 'hello')

    const lines = (lastFrame() ?? '').split('\n')
    expect(lines.findIndex((line) => line.includes('› hello'))).toBeGreaterThan(4)
  })

  it('says how long the model thought before the answer started', async () => {
    async function* stream(): AsyncGenerator<AgentEvent> {
      // A slow first token: long enough that the wait is worth reporting.
      await tick(1100)
      yield { type: 'text-delta', delta: 'aqui está' }
      yield { type: 'done', finishReason: 'stop' }
    }

    const { lastFrame, stdin } = renderChat(makeRuntime(stream))
    await submit(stdin, 'pensa aí')
    await tick(1300)

    const frame = lastFrame() ?? ''
    expect(frame).toContain('✻ Thought for')
    expect(frame).toContain('aqui está')
  })

  it('names the compaction in the wait, so it is not read as the model', async () => {
    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'compacted', ms: 2400 }
      await tick(1100)
      yield { type: 'text-delta', delta: 'pronto' }
      yield { type: 'done', finishReason: 'stop' }
    }

    const { lastFrame, stdin } = renderChat(makeRuntime(stream))
    await submit(stdin, 'oi')
    await tick(1300)

    const frame = lastFrame() ?? ''
    expect(frame).toContain('✻ Thought for')
    expect(frame).toContain('2.4s compacting')
  })

  it('keeps reasoning the turn ends on, instead of dropping it', async () => {
    async function* stream(): AsyncGenerator<AgentEvent> {
      // A tool step first, then a thought with nothing after it — the shape a
      // model that answers in the thinking channel produces.
      yield { type: 'reasoning-delta', delta: 'let me look' }
      yield { type: 'tool-start', id: 'c1', name: 'read_file', args: { path: 'a.txt' } }
      yield { type: 'tool-end', id: 'c1', name: 'read_file', result: 'ok', isError: false }
      yield { type: 'reasoning-delta', delta: 'Oi! Em que posso ajudar?' }
      yield { type: 'done', finishReason: 'stop' }
    }

    const { lastFrame, stdin } = renderChat(makeRuntime(stream))
    await submit(stdin, 'oii')

    // It used to be cleared when the turn ended, leaving the ✻ line and the tool
    // line as the whole record of a turn that did say something — and the text
    // was on screen a moment before, which is what makes it look like a bug.
    expect(lastFrame()).toContain('Oi! Em que posso ajudar?')
  })

  it('keeps what a step said, when the turn answered in the thinking', async () => {
    async function* stream(): AsyncGenerator<AgentEvent> {
      // Every step answers in the thinking channel — the shape a provider that
      // fills one field with both produces — and each was too fast to be worth a
      // line, so this used to be dropped and the turn looked empty.
      yield { type: 'reasoning-delta', delta: 'o projeto chama-se milo' }
      yield { type: 'tool-start', id: 'c1', name: 'read_file', args: { path: 'package.json' } }
      yield { type: 'tool-end', id: 'c1', name: 'read_file', result: 'ok', isError: false }
      yield { type: 'reasoning-delta', delta: 'e usa TypeScript' }
      yield { type: 'done', finishReason: 'stop' }
    }

    const { lastFrame, stdin } = renderChat(makeRuntime(stream))
    await submit(stdin, 'o que tem no package.json?')

    const frame = lastFrame() ?? ''
    expect(frame).toContain('o projeto chama-se milo')
    expect(frame).toContain('e usa TypeScript')
  })

  it('keeps the thought when the turn never answered', async () => {
    async function* stream(): AsyncGenerator<AgentEvent> {
      // Slow enough for the wait to be worth a line, and the tool that followed
      // it was the turn's only other content: the thought is what was said, so
      // it has to stay.
      await tick(1100)
      yield { type: 'reasoning-delta', delta: 'o projeto chama-se milo' }
      yield { type: 'tool-start', id: 'c1', name: 'read_file', args: { path: 'package.json' } }
      yield { type: 'tool-end', id: 'c1', name: 'read_file', result: 'ok', isError: false }
      yield { type: 'done', finishReason: 'stop' }
    }

    const { lastFrame, stdin } = renderChat(makeRuntime(stream))
    await submit(stdin, 'o que tem no package.json?')
    await tick(1500)

    const frame = lastFrame() ?? ''
    expect(frame).toContain('✻ Thought for')
    expect(frame).toContain('o projeto chama-se milo')
  })

  it('does not count a bare newline as the answer', async () => {
    async function* stream(): AsyncGenerator<AgentEvent> {
      // The thinking is the whole reply, and the only thing that arrives in the
      // answer channel is a newline — which used to count as an answer and switch
      // off the rule that keeps the thinking visible.
      yield { type: 'reasoning-delta', delta: 'Oi! Em que posso ajudar?' }
      yield { type: 'text-delta', delta: '\n' }
      yield { type: 'done', finishReason: 'stop' }
    }

    const { lastFrame, stdin } = renderChat(makeRuntime(stream))
    await submit(stdin, 'oii')

    expect(lastFrame()).toContain('Oi! Em que posso ajudar?')
  })

  it('says why a turn showed nothing when the display hid it all', async () => {
    async function* stream(): AsyncGenerator<AgentEvent> {
      // The answer itself arrives as reasoning — a provider putting both of its
      // channels in one field — with /thinking off there is nothing to show.
      yield { type: 'reasoning-delta', delta: 'Oi! Em que posso ajudar?' }
      yield { type: 'done', finishReason: 'stop' }
    }

    const { lastFrame, stdin } = renderChat(makeRuntime(stream), {
      display: { tools: 'full', thinking: 'off' },
    })
    await submit(stdin, 'oii')

    const frame = lastFrame() ?? ''
    expect(frame).toContain('no answer came back')
    expect(frame).not.toContain('Em que posso ajudar')
  })

  it('keeps the status line inside a narrow terminal', async () => {
    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'usage', inputTokens: 2, outputTokens: 1 }
      yield { type: 'text-delta', delta: 'oi' }
      yield { type: 'done', finishReason: 'stop' }
    }

    const app = renderChat(makeRuntime(stream))
    // A turn first: the counters it leaves behind are what overflowed the line.
    await submit(app.stdin, 'oi')
    Object.defineProperty(app.stdout, 'columns', { value: 58, configurable: true })
    app.stdout.emit('resize')
    await tick()

    const frame = app.lastFrame() ?? ''
    // The frame is a fixed height, so a line that wraps pushes everything below
    // it down and Ink redraws two frames over each other — which is how the
    // composer ended up showing its placeholder and the typed text at once.
    expect(frame).toContain('Enter send · /help · Ctrl+C')
    expect(frame).not.toContain('PgUp')
    expect(frame.split('\n').some((line) => line.trim() === 'quits')).toBe(false)
  })

  it('stays quiet when the answer starts straight away', async () => {
    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'text-delta', delta: 'na hora' }
      yield { type: 'done', finishReason: 'stop' }
    }

    const { lastFrame, stdin } = renderChat(makeRuntime(stream))
    await submit(stdin, 'oi')

    expect(lastFrame()).toContain('na hora')
    expect(lastFrame()).not.toContain('Thought for')
  })

  it('asks for confirmation before a side-effecting tool and honors denial', async () => {
    async function* stream(
      _text: string,
      opts: {
        ask: (request: { tool: string; args: unknown; summary: string }) => Promise<{ allowed: boolean }>
      },
    ): AsyncGenerator<AgentEvent> {
      const result = await opts.ask({
        tool: 'shell_command',
        args: { command: 'rm -rf build' },
        summary: 'rm -rf build',
      })
      yield { type: 'text-delta', delta: result.allowed ? 'ran it' : 'not allowed' }
      yield { type: 'done', finishReason: 'stop' }
    }

    const runtime = {
      getSession: () => ({
        messages: [],
        send: (text: string, opts: unknown) => stream(text, opts as never),
      }),
    } as unknown as AgentRuntime

    const { lastFrame, stdin } = renderChat(runtime)
    await submit(stdin, 'run it')
    expect(lastFrame()).toContain('shell_command')
    expect(lastFrame()).toContain('rm -rf build')

    stdin.write('n')
    await tick()

    expect(lastFrame()).toContain('not allowed')
  })

  it('echoes a command into the transcript like any other line typed', async () => {
    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'done', finishReason: 'stop' }
    }

    const { lastFrame, stdin } = renderChat(makeRuntime(stream))
    // A command with a one-line answer, so the echo is still on screen: a longer
    // one scrolls it out of the window, which is the transcript working.
    await submit(stdin, '/effort')
    await tick()

    expect(lastFrame()).toContain('› /effort')
  })

  it('changes the reasoning effort, and reports it when asked for nothing', async () => {
    const efforts: ReasoningEffort[] = []
    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'done', finishReason: 'stop' }
    }

    const { lastFrame, stdin } = renderChat(makeRuntime(stream), {
      onEffortChange: (effort) => efforts.push(effort),
    })

    await submit(stdin, '/effort')
    // No argument reports rather than cycling: there is no single "next" value.
    expect(efforts).toEqual([])
    expect(lastFrame()).toContain('Use /effort low|medium|high')
    // A runtime that has no effort of its own still reports Milo's default.
    expect(lastFrame()).toContain('Reasoning effort: medium')

    await submit(stdin, '/effort low')
    // `default` is Milo's own value, which is medium.
    await submit(stdin, '/effort default')

    expect(efforts).toEqual(['low', 'medium'])
  })

  it('walks back through what was sent with the arrows', async () => {
    const sent: string[] = []
    const { lastFrame, stdin } = renderChat(recordingRuntime(sent))

    await submit(stdin, 'primeira')
    await submit(stdin, 'segunda')

    // Into the composer — the bordered line, not the echo of the same words
    // left in the transcript above it.
    stdin.write(UP)
    await tick()
    expect(lastFrame()).toContain('│ › segunda')

    stdin.write(UP)
    await tick()
    expect(lastFrame()).toContain('│ › primeira')

    // Enter sends whatever the arrow put there.
    stdin.write('\r')
    await tick()
    expect(sent).toEqual(['primeira', 'segunda', 'primeira'])
  })

  it('hands the draft back when the arrows come down again', async () => {
    const sent: string[] = []
    const { lastFrame, stdin } = renderChat(recordingRuntime(sent))

    await submit(stdin, 'guardada')
    await type(stdin, 'rascunho')

    stdin.write(UP)
    await tick()
    expect(lastFrame()).toContain('│ › guardada')

    stdin.write(DOWN)
    await tick()
    expect(lastFrame()).toContain('│ › rascunho')

    stdin.write('\r')
    await tick()
    expect(sent).toEqual(['guardada', 'rascunho'])
  })

  it('leaves a recalled line editable, with the cursor after it', async () => {
    const sent: string[] = []
    const { stdin } = renderChat(recordingRuntime(sent))

    await submit(stdin, 'ola mundo')
    stdin.write(UP)
    await tick()
    await type(stdin, '!')
    stdin.write('\r')
    await tick()

    expect(sent).toEqual(['ola mundo', 'ola mundo!'])
  })

  it('remembers what was sent after a restart', async () => {
    const sent: string[] = []
    const first = renderChat(recordingRuntime(sent))
    await submit(first.stdin, 'sobrevive ao reinicio')
    cleanup()

    // The write is off the turn's critical path, so wait for it rather than
    // racing the remount against a file that may not be on disk yet.
    const file = path.join(home, 'input-history.json')
    await waitUntil(() => {
      try {
        return (JSON.parse(readFileSync(file, 'utf8')) as string[]).includes('sobrevive ao reinicio')
      } catch {
        return false
      }
    })

    const second = renderChat(recordingRuntime(sent))
    second.stdin.write(UP)
    await tick()

    expect(second.lastFrame()).toContain('│ › sobrevive ao reinicio')
  })

  it('scrolls the transcript on a wheel tick, which reaches it as an alt+arrow', async () => {
    // A tall answer, so the transcript has somewhere to scroll to.
    async function* stream(): AsyncGenerator<AgentEvent> {
      const lines = Array.from({ length: 60 }, (_, index) => `linha ${index}`)
      yield { type: 'text-delta', delta: lines.join('\n') }
      yield { type: 'done', finishReason: 'stop' }
    }

    const { stdin, lastFrame } = renderChat(makeRuntime(() => stream()))
    await submit(stdin, 'uma pergunta qualquer')

    // What `mouse.ts` hands Ink for one tick of the wheel.
    stdin.write('\u001b[1;3A')
    await tick()
    stdin.write('\u001b[1;3A')
    await tick()

    const frame = lastFrame() ?? ''
    expect(frame).toContain('▲ scrolled')
    // And it is not the history: the composer stays as it was, empty.
    expect(frame).not.toContain('│ › uma pergunta')
  })

  it('opens the model picker via /model and the settings hub via /setup', async () => {
    let openedModel = false
    let openedSettings = false
    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'done', finishReason: 'stop' }
    }

    const { stdin } = renderChat(makeRuntime(stream), {
      onOpenModel: () => {
        openedModel = true
      },
      onOpenSettings: () => {
        openedSettings = true
      },
    })

    await submit(stdin, '/model')
    await submit(stdin, '/setup')

    expect(openedModel).toBe(true)
    expect(openedSettings).toBe(true)
  })

  it('toggles yolo mode via /yolo and via /mode <mode>', async () => {
    const modes: PermissionMode[] = []
    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'done', finishReason: 'stop' }
    }

    const { stdin } = renderChat(makeRuntime(stream), {
      mode: 'ask',
      onModeChange: (mode) => modes.push(mode),
    })

    await submit(stdin, '/yolo')
    await submit(stdin, '/mode auto')

    expect(modes).toEqual(['yolo', 'auto'])
  })

  it('hands /tools and /thinking to the shell instead of keeping them local', async () => {
    const patches: Partial<DisplayConfig>[] = []
    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'done', finishReason: 'stop' }
    }

    const { stdin } = renderChat(makeRuntime(stream), {
      onDisplayChange: (patch) => patches.push(patch),
    })

    await submit(stdin, '/tools name')
    await submit(stdin, '/tools nonsense')
    await submit(stdin, '/thinking off')

    expect(patches).toEqual([{ tools: 'name' }, { thinking: 'off' }])
  })

  it('hides tool lines and reasoning when the display settings say so', async () => {
    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'reasoning-delta', delta: 'pensando alto\n' }
      yield { type: 'tool-start', id: 'c1', name: 'shell_command', args: { command: 'ls -la' } }
      yield { type: 'tool-end', id: 'c1', name: 'shell_command', result: 'ok', isError: false }
      yield { type: 'text-delta', delta: 'feito' }
      yield { type: 'done', finishReason: 'stop' }
    }

    const { lastFrame, stdin } = renderChat(makeRuntime(stream), {
      display: { tools: 'off', thinking: 'off' },
    })
    await submit(stdin, 'roda isso')

    const frame = lastFrame() ?? ''
    expect(frame).toContain('feito')
    expect(frame).not.toContain('shell_command')
    expect(frame).not.toContain('pensando alto')
  })

  it('keeps a failure visible even with tools off', async () => {
    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'tool-start', id: 'c1', name: 'shell_command', args: { command: 'nope' } }
      yield { type: 'tool-end', id: 'c1', name: 'shell_command', result: 'bad', isError: true }
      yield { type: 'done', finishReason: 'stop' }
    }

    const { lastFrame, stdin } = renderChat(makeRuntime(stream), {
      display: { tools: 'off', thinking: 'on' },
    })
    await submit(stdin, 'roda isso')

    expect(lastFrame()).toContain('shell_command')
  })

  it('shows a stopped turn as stopped, not as an error', async () => {
    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'text-delta', delta: 'half an ans' }
      yield { type: 'aborted' }
    }

    const { lastFrame, stdin } = renderChat(makeRuntime(stream))
    await submit(stdin, 'roda isso')

    const frame = lastFrame() ?? ''
    expect(frame).toContain('stopped.')
    expect(frame).not.toContain('error:')
    expect(frame).toContain('half an ans')
  })

  it('starts, lists and switches sessions via the slash commands', async () => {
    const changes: string[] = []
    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'done', finishReason: 'stop' }
    }

    const current = {
      id: 'calm-otter-7',
      messages: [],
      send: () => stream(),
      clear: async () => undefined,
      stats: () => ({
        id: 'calm-otter-7',
        createdAt: 0,
        updatedAt: 0,
        messages: 2,
        turns: 1,
        tokens: 42,
        compacted: false,
      }),
    }
    const runtime = {
      getSession: async () => current,
      newSession: async (_scope: unknown, title?: string) => ({ id: 'brave-wolf-2', title }),
      listSessions: async () => [
        { id: 'calm-otter-7', createdAt: 0, updatedAt: 0, messageCount: 2, preview: 'hi' },
      ],
      resumeSession: async (_scope: unknown, id: string) =>
        id === 'calm-otter-7' ? current : null,
    } as unknown as AgentRuntime

    const { lastFrame, stdin } = renderChat(runtime, {
      onSessionChange: (id) => changes.push(id),
    })

    await submit(stdin, '/new my project')
    await tick()
    expect(lastFrame()).toContain('brave-wolf-2')

    await submit(stdin, '/sessions')
    await tick()
    expect(lastFrame()).toContain('calm-otter-7')

    await submit(stdin, '/sessions nope')
    await tick()
    expect(lastFrame()).toContain('Invalid page: "nope". Use /sessions 1..1')

    await submit(stdin, '/stats')
    await tick()
    expect(lastFrame()).toContain('~42 tokens')

    await submit(stdin, '/resume calm-otter-7')
    await tick()
    expect(lastFrame()).toContain('Switched to session calm-otter-7')

    await submit(stdin, '/resume nope-nope-9')
    await tick()
    expect(lastFrame()).toContain('No session')

    expect(changes).toEqual(['brave-wolf-2', 'calm-otter-7'])
  })
})

describe('ChatScreen — queue and steer', () => {
  /** A runtime whose first turn blocks, so a test can type while it runs. */
  function gatedRuntime() {
    const sent: { text: string; steering?: string[] }[] = []
    const newSessions: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    async function* stream(
      text: string,
      options?: { steering?: string[] },
    ): AsyncGenerator<AgentEvent> {
      sent.push({ text, steering: options?.steering })
      // Only the first turn waits, so anything queued behind it runs at once.
      if (sent.length === 1) await gate
      yield { type: 'text-delta', delta: `answer to ${text}` }
      yield { type: 'done', finishReason: 'stop' }
    }

    const runtime = {
      getSession: () => ({
        messages: [],
        send: (text: string, options?: { steering?: string[] }) => stream(text, options),
      }),
      newSession: async (_scope: unknown, title?: string) => {
        newSessions.push(title ?? '')
        return { id: 'other-1' }
      },
    } as unknown as AgentRuntime

    return { runtime, sent, newSessions, release }
  }

  it('keeps the composer while a turn runs, and queues what is typed behind it', async () => {
    const { runtime, sent, release } = gatedRuntime()
    const { lastFrame, stdin } = renderChat(runtime)

    await submit(stdin, 'first')
    // A turn running is no reason to take the composer away.
    expect(lastFrame()).toContain('Queue a message')

    await submit(stdin, 'second')
    expect(lastFrame()).toContain('1 queued ·')
    // Still one turn: the second message waits its turn.
    expect(sent.map((turn) => turn.text)).toEqual(['first'])

    release()
    await tick()

    expect(sent.map((turn) => turn.text)).toEqual(['first', 'second'])
    expect(lastFrame()).toContain('answer to second')
  })

  it('hands a Ctrl+Enter message to the turn in flight', async () => {
    const { runtime, sent, release } = gatedRuntime()
    const { stdin } = renderChat(runtime)

    await submit(stdin, 'first')
    await type(stdin, 'no, use b.txt')
    // Ctrl+Enter, as the kitty keyboard protocol reports it.
    stdin.write('\x1b[13;5u')
    await tick()

    expect(sent).toHaveLength(1)
    expect(sent[0]?.steering).toEqual(['no, use b.txt'])

    release()
    await tick()
  })

  it('reads alt+enter as a steer too, for terminals without the protocol', async () => {
    const { runtime, sent, release } = gatedRuntime()
    const { stdin } = renderChat(runtime)

    await submit(stdin, 'first')
    await type(stdin, 'actually, check the tests')
    stdin.write('\x1b\r')
    await tick()

    expect(sent).toHaveLength(1)
    expect(sent[0]?.steering).toEqual(['actually, check the tests'])

    release()
    await tick()
  })

  it('refuses a command that would rebind the session mid-turn', async () => {
    const { runtime, newSessions, release } = gatedRuntime()
    const { lastFrame, stdin } = renderChat(runtime)

    await submit(stdin, 'first')
    await submit(stdin, '/new other')
    await tick()

    expect(lastFrame()).toContain("Can't /new")
    expect(newSessions).toEqual([])

    release()
    await tick()
  })

  it('drops what was queued when Ctrl+C stops the turn, and says how much', async () => {
    const { runtime, sent, release } = gatedRuntime()
    const { lastFrame, stdin } = renderChat(runtime)

    await submit(stdin, 'first')
    await submit(stdin, 'second')
    expect(lastFrame()).toContain('1 queued ·')

    stdin.write('\u0003')
    await tick()
    expect(lastFrame()).not.toContain('1 queued ·')

    // The turn the stub was holding ends; the queued message must not run.
    release()
    await tick()

    expect(sent.map((turn) => turn.text)).toEqual(['first'])
    expect(lastFrame()).toContain('1 queued message dropped')
    expect(lastFrame()).not.toContain('thinking…')
  })
})

describe('ModelPicker', () => {
  it('lists the providers', () => {
    const { lastFrame } = render(<ModelPicker onDone={() => {}} onCancel={() => {}} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('Command Code')
    expect(frame).toContain('Ollama')
    expect(frame).toContain('first-run setup')
  })

  it('cancels on Ctrl+C', async () => {
    let cancelled = false
    const { stdin } = render(
      <ModelPicker
        onDone={() => {}}
        onCancel={() => {
          cancelled = true
        }}
      />,
    )
    stdin.write('\u0003')
    await tick()
    expect(cancelled).toBe(true)
  })
})
