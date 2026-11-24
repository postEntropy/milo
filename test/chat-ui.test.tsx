import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { stripVTControlCharacters as stripAnsi } from 'node:util'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from 'ink-testing-library'
import type { AgentEvent } from '../src/core/agent/events.js'
import { OMARCHY_ACTIVATION_GUIDE, type ComputerManager } from '../src/core/computer/index.js'
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
const scope = { gateway: 'cli', chatId: 'test' }
const UP = '\u001b[A'
const DOWN = '\u001b[B'

/** Waits for a side effect (the history file) instead of racing it. */
async function waitUntil(check: () => boolean, timeoutMs = 4000): Promise<void> {
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

/**
 * The composer's own row: the last line carrying its prompt. The composer sits
 * below the transcript, so a line already echoed above it — the same words sent
 * and shown — is never the one this returns.
 */
function composerRow(frame: string): string {
  return frame.split('\n').filter((line) => line.includes('› ')).at(-1) ?? ''
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
  model?: { provider: string; model: string; effort: ReasoningEffort }
  sessionFolder?: string | null
  maxInputTokens?: number
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
      display={options.display ?? { tools: 'full', thinking: 'expanded' }}
      onDisplayChange={options.onDisplayChange ?? (() => {})}
      items={items}
      setItems={setItems}
      onOpenModel={options.onOpenModel ?? (() => {})}
      onOpenSettings={options.onOpenSettings ?? (() => {})}
      onExit={() => {}}
      onSessionChange={options.onSessionChange}
      model={options.model}
      sessionFolder={options.sessionFolder}
      maxInputTokens={options.maxInputTokens}
    />
  )
}

function renderChat(runtime: AgentRuntime, options: RenderOptions = {}) {
  return render(<Harness runtime={runtime} options={options} />)
}

afterEach(() => cleanup())

describe('ChatScreen', () => {
  it('shows waiting before output, transitions to thinking only when signaled, then shows the answer', async () => {
    let releaseFirst!: () => void
    let releaseSecond!: () => void
    const beforeFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const whileThinking = new Promise<void>((resolve) => {
      releaseSecond = resolve
    })

    async function* stream(): AsyncGenerator<AgentEvent> {
      await beforeFirst
      yield { type: 'reasoning-start' }
      await whileThinking
      yield { type: 'reasoning-end', ms: 1200 }
      yield { type: 'text-delta', delta: 'Hi there' }
      yield { type: 'done', finishReason: 'stop' }
    }

    const { lastFrame, stdin } = renderChat(makeRuntime(stream))

    await submit(stdin, 'hello')
    expect(lastFrame()).toContain('…')
    expect(lastFrame()).not.toContain('thinking…')

    releaseFirst()
    await tick()
    expect(lastFrame()).toContain('thinking…')

    releaseSecond()
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
    expect(frame).toContain('Read a.txt')
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
    const tool = lines.findIndex((line) => line.includes('Read yolo.ts'))
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

  it('shows waiting, then thinking during a streamed reasoning block, preserves content, and never invents Thought for from client clock', async () => {
    let releaseWait!: () => void
    let releaseThink!: () => void
    const waitGate = new Promise<void>((resolve) => { releaseWait = resolve })
    const thinkGate = new Promise<void>((resolve) => { releaseThink = resolve })

    async function* fullFlow(): AsyncGenerator<AgentEvent> {
      yield { type: 'response-waiting' }
      await waitGate
      yield { type: 'reasoning-start' }
      yield { type: 'reasoning-delta', delta: 'checking options carefully' }
      await thinkGate
      yield { type: 'reasoning-end' }
      yield { type: 'text-delta', delta: 'pronto' }
      yield { type: 'done', finishReason: 'stop' }
    }

    const { lastFrame, stdin } = renderChat(makeRuntime(fullFlow))
    await submit(stdin, 'pensa aí')
    expect(lastFrame()).toContain('…')
    expect(lastFrame()).not.toContain('thinking…')

    releaseWait()
    await tick()
    expect(lastFrame()).toContain('thinking…')
    expect(lastFrame()).toContain('checking options carefully')

    await tick(1100)
    releaseThink()
    const frame = await waitForFrame(lastFrame, 'pronto')
    expect(frame).toContain('checking options carefully')
    expect(frame).toContain('pronto')
    expect(frame).not.toContain('✻ Thought for')
  })

  it('names the fold while it runs, and what it saved once it is over', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'compacting' }
      await gate
      yield { type: 'compacted', ms: 2400, folded: 3, tokens: 4200, summarized: true }
      yield { type: 'text-delta', delta: 'pronto' }
      yield { type: 'done', finishReason: 'stop' }
    }

    const { lastFrame, stdin } = renderChat(makeRuntime(stream))
    await submit(stdin, 'oi')
    // The band is what says a wait is a wait, and here it says which one: without
    // it the fold's seconds read as the model being slow.
    await waitForFrame(lastFrame, 'folding the oldest turns into the summary')

    release()
    await tick(120)

    const frame = lastFrame() ?? ''
    // Then once, in the transcript, with what the fold came to and what it was worth.
    expect(frame).toContain('🗜 Compacted: 3 turns (~4200 tokens)')
    expect(frame).toContain('folded into the summary in 2.4s')
    expect(frame).toContain('pronto')
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
      yield { type: 'reasoning-start' }
      yield { type: 'reasoning-delta', delta: 'o projeto chama-se milo' }
      yield { type: 'reasoning-end', ms: 1400 }
      yield { type: 'tool-start', id: 'c1', name: 'read_file', args: { path: 'package.json' } }
      yield { type: 'tool-end', id: 'c1', name: 'read_file', result: 'ok', isError: false }
      yield { type: 'done', finishReason: 'stop' }
    }

    const { lastFrame, stdin } = renderChat(makeRuntime(stream))
    await submit(stdin, 'o que tem no package.json?')
    await tick()

    const frame = lastFrame() ?? ''
    expect(frame).toContain('✻ Thought for 1.4s')
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
      // channels in one field — with /thinking collapsed there is nothing to show.
      yield { type: 'reasoning-delta', delta: 'Oi! Em que posso ajudar?' }
      yield { type: 'done', finishReason: 'stop' }
    }

    const { lastFrame, stdin } = renderChat(makeRuntime(stream), {
      display: { tools: 'full', thinking: 'collapsed' },
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
    // The shortcut legend is off the surface now, and the frame is a fixed height:
    // a status line that wrapped would push everything below it down and Ink would
    // redraw two frames over each other — the way the composer once showed its
    // placeholder and the typed text at once.
    expect(frame).not.toContain('Enter send')
    expect(frame).not.toContain('PgUp')
    // The counters share the status row, not a wrapped second one.
    expect(frame.split('\n').some((line) => line.includes('tok'))).toBe(true)
    expect(frame.split('\n').some((line) => line.trim() === 'tok')).toBe(false)
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
    expect(lastFrame()).toContain('Allow shell command')
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

    // Into the composer — the row below the transcript, not the echo of the same
    // words left in the transcript above it.
    stdin.write(UP)
    await tick()
    expect(composerRow(lastFrame() ?? '')).toContain('› segunda')

    stdin.write(UP)
    await tick()
    expect(composerRow(lastFrame() ?? '')).toContain('› primeira')

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
    expect(composerRow(lastFrame() ?? '')).toContain('› guardada')

    stdin.write(DOWN)
    await tick()
    expect(composerRow(lastFrame() ?? '')).toContain('› rascunho')

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

    expect(composerRow(second.lastFrame() ?? '')).toContain('› sobrevive ao reinicio')
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
    expect(composerRow(frame)).not.toContain('uma pergunta')
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
    await submit(stdin, '/thinking collapsed')

    expect(patches).toEqual([{ tools: 'name' }, { thinking: 'collapsed' }])
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
      display: { tools: 'off', thinking: 'collapsed' },
    })
    await submit(stdin, 'roda isso')

    const frame = lastFrame() ?? ''
    expect(frame).toContain('feito')
    expect(frame).not.toContain('ls -la')
    expect(frame).not.toContain('Shell')
    expect(frame).not.toContain('pensando alto')
  })

  it('keeps a failure visible even with tools off', async () => {
    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'tool-start', id: 'c1', name: 'shell_command', args: { command: 'nope' } }
      yield { type: 'tool-end', id: 'c1', name: 'shell_command', result: 'bad', isError: true }
      yield { type: 'done', finishReason: 'stop' }
    }

    const { lastFrame, stdin } = renderChat(makeRuntime(stream), {
      display: { tools: 'off', thinking: 'expanded' },
    })
    await submit(stdin, 'roda isso')

    expect(lastFrame()).toContain('nope')
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

  it('hydrates stored messages when switching sessions via /resume and /fork', async () => {
    async function* emptyStream(): AsyncGenerator<AgentEvent> {
      yield { type: 'done', finishReason: 'stop' }
    }

    const resumedSession = {
      id: 'calm-otter-7',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'old question' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'old answer' }] },
      ],
      send: () => emptyStream(),
      clear: async () => undefined,
      stats: () => ({
        id: 'calm-otter-7',
        createdAt: 0,
        updatedAt: 0,
        messages: 2,
        turns: 1,
        tokens: 18,
        compacted: false,
      }),
    }

    const forkedSession = {
      id: 'bold-lynx-3',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'branched question' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'branched answer' }] },
      ],
      send: () => emptyStream(),
      clear: async () => undefined,
      stats: () => ({
        id: 'bold-lynx-3',
        createdAt: 0,
        updatedAt: 0,
        messages: 2,
        turns: 1,
        tokens: 18,
        compacted: false,
      }),
    }

    const runtime = {
      getSession: async () => resumedSession,
      resumeSession: async (_scope: unknown, id: string) =>
        id === 'calm-otter-7' ? resumedSession : null,
      forkSession: async () => forkedSession,
    } as unknown as AgentRuntime

    const { lastFrame, stdin } = renderChat(runtime)

    await submit(stdin, '/resume calm-otter-7')
    await waitForFrame(lastFrame, 'old answer')
    expect(lastFrame()).toContain('old question')
    expect(lastFrame()).toContain('Switched to session calm-otter-7')

    await submit(stdin, '/fork')
    await waitForFrame(lastFrame, 'branched answer')
    expect(lastFrame()).toContain('branched question')
    expect(lastFrame()).toContain('Branched into new session: bold-lynx-3')
  })

  it('delegates /folder, /status, and /export through the shared command handler', async () => {
    async function* emptyStream(): AsyncGenerator<AgentEvent> {
      yield { type: 'done', finishReason: 'stop' }
    }

    const session: {
      id: string
      messages: never[]
      project: { ok: true; project: { path: string } } | undefined
      send: () => AsyncGenerator<AgentEvent>
      clear: () => Promise<void>
      stats: () => {
        id: string
        createdAt: number
        updatedAt: number
        messages: number
        turns: number
        tokens: number
        compacted: boolean
      }
    } = {
      id: 'calm-otter-7',
      messages: [],
      project: undefined,
      send: () => emptyStream(),
      clear: async () => undefined,
      stats: () => ({
        id: 'calm-otter-7',
        createdAt: 0,
        updatedAt: 0,
        messages: 0,
        turns: 0,
        tokens: 10,
        compacted: false,
      }),
    }

    const runtime = {
      getSession: async () => session,
      setSessionFolder: async (_id: string, folder: string | null) => {
        session.project = folder ? { ok: true, project: { path: folder } } : undefined
      },
    } as unknown as AgentRuntime

    const { lastFrame, stdin } = renderChat(runtime)

    await submit(stdin, '/folder /tmp/workspace-alpha')
    await waitForFrame(lastFrame, 'Session folder: /tmp/workspace-alpha.')
    expect(lastFrame()).toContain('folder workspace-alpha')

    await submit(stdin, '/status')
    await waitForFrame(lastFrame, 'Permission mode: ask')

    await submit(stdin, '/export xml')
    await waitForFrame(lastFrame, 'Export as what?')
  })

  it('toggles expanded tool details on Ctrl+O', async () => {
    async function* stream(): AsyncGenerator<AgentEvent> {
      yield {
        type: 'tool-start',
        id: 'tool-1',
        name: 'read_file',
        args: { path: 'src/index.ts' },
      }
      yield {
        type: 'tool-end',
        id: 'tool-1',
        name: 'read_file',
        result: 'secret tool output line',
        isError: false,
      }
      yield { type: 'done', finishReason: 'stop' }
    }

    const runtime = {
      getSession: async () => ({ messages: [], send: () => stream() }),
    } as unknown as AgentRuntime

    const { lastFrame, stdin } = renderChat(runtime)

    await submit(stdin, 'inspect index')
    await waitForFrame(lastFrame, 'Read src/index.ts')
    expect(lastFrame()).not.toContain('secret tool output line')

    stdin.write('\u000f')
    await waitForFrame(lastFrame, 'secret tool output line')

    stdin.write('\u000f')
    await waitUntil(() => !(lastFrame() ?? '').includes('secret tool output line'))
  })

  it('copies the last assistant reply on Ctrl+Y and toggles mouse tracking on Ctrl+M', async () => {
    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'text-delta', delta: 'copyable reply text' }
      yield { type: 'done', finishReason: 'stop' }
    }

    const runtime = {
      getSession: async () => ({ messages: [], send: () => stream() }),
    } as unknown as AgentRuntime

    const writes: string[] = []
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    }) as typeof process.stdout.write)

    try {
      const { lastFrame, stdin } = renderChat(runtime)

      await submit(stdin, 'hello')
      await waitForFrame(lastFrame, 'copyable reply text')

      stdin.write('\u0019')
      await waitForFrame(lastFrame, 'Copied last reply')
      const expectedOsc52 = `\u001b]52;c;${Buffer.from('copyable reply text', 'utf8').toString('base64')}\u0007`
      expect(writes.some((entry) => entry.includes(expectedOsc52))).toBe(true)

      stdin.write('\u001b[109;5u')
      await waitForFrame(lastFrame, 'mouse off')

      stdin.write('\u001b[109;5u')
      await waitUntil(() => !(lastFrame() ?? '').includes('mouse off'))
    } finally {
      writeSpy.mockRestore()
    }
  })

  it('renders steer, ui (replacing drafts), and panel events', async () => {
    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'steer', text: 'check tests too' }
      yield {
        type: 'ui',
        draft: true,
        render: { title: 'Draft Card', tree: { kind: 'text', text: 'draft body' } },
      }
      yield {
        type: 'ui',
        draft: false,
        render: { title: 'Final Card', tree: { kind: 'text', text: 'final body' } },
      }
      yield { type: 'panel', request: { path: 'src/app.ts' } }
      yield { type: 'done', finishReason: 'stop' }
    }

    const runtime = {
      getSession: async () => ({ messages: [], send: () => stream() }),
    } as unknown as AgentRuntime

    const { lastFrame, stdin } = renderChat(runtime)

    await submit(stdin, 'build widget')
    await waitForFrame(lastFrame, 'Final Card')
    const frame = lastFrame() ?? ''
    expect(frame).toContain('check tests too')
    expect(frame).toContain('final body')
    expect(frame).not.toContain('Draft Card')
    expect(frame).toContain('src/app.ts')
  })

  it('opens the session picker on Ctrl+S and the folder picker on bare /folder', async () => {
    async function* emptyStream(): AsyncGenerator<AgentEvent> {
      yield { type: 'done', finishReason: 'stop' }
    }

    const sessionTwo = {
      id: 'swift-fox-9',
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'from swift fox' }] }],
      send: () => emptyStream(),
      clear: async () => undefined,
      stats: () => ({
        id: 'swift-fox-9',
        createdAt: 0,
        updatedAt: 0,
        messages: 1,
        turns: 1,
        tokens: 10,
        compacted: false,
      }),
    }

    const runtime = {
      getSession: async () => sessionTwo,
      listSessions: async () => [
        { id: 'swift-fox-9', createdAt: 0, updatedAt: 0, messageCount: 1, preview: 'fox session' },
      ],
      resumeSession: async (_scope: unknown, id: string) => (id === 'swift-fox-9' ? sessionTwo : null),
    } as unknown as AgentRuntime

    const { lastFrame, stdin } = renderChat(runtime)

    stdin.write('\u0013')
    await waitForFrame(lastFrame, 'fox session')

    stdin.write('\r')
    await waitForFrame(lastFrame, 'from swift fox')
    expect(lastFrame()).toContain('Switched to session swift-fox-9')

    await submit(stdin, '/folder')
    await waitForFrame(lastFrame, 'Clear folder (default directory)')

    stdin.write('\u001b')
    await waitUntil(() => !(lastFrame() ?? '').includes('Enter select'))
  })

  it('supports multiline Shift+Enter input in the composer', async () => {
    const sent: string[] = []
    async function* emptyStream(): AsyncGenerator<AgentEvent> {
      yield { type: 'done', finishReason: 'stop' }
    }

    const runtime = {
      getSession: async () => ({
        messages: [],
        send: (text: string) => {
          sent.push(text)
          return emptyStream()
        },
      }),
    } as unknown as AgentRuntime

    const { stdin } = renderChat(runtime)

    stdin.write('first line')
    await tick(20)
    stdin.write('\u001b[13;2u')
    await tick(20)
    stdin.write('second line')
    await tick(20)
    stdin.write('\r')
    await waitUntil(() => sent.length === 1)

    expect(sent[0]).toBe('first line\nsecond line')
  })

  it('renders the empty-state hero with two-tone mark, model, folder, and hints, collapsing on tiny viewports', async () => {
    async function* emptyStream(): AsyncGenerator<AgentEvent> {
      yield { type: 'done', finishReason: 'stop' }
    }

    const app = renderChat(makeRuntime(emptyStream), {
      model: { provider: 'commandcode', model: 'claude-sonnet-4', effort: 'medium' },
      sessionFolder: '/tmp/my-workspace',
    })

    const fullFrame = stripAnsi(app.lastFrame() ?? '')
    expect(fullFrame).toContain('▄▄█████▄')
    expect(fullFrame).toContain('▄██████▀')
    expect(fullFrame).toContain('▀█████▀')
    expect(fullFrame).toContain('MILO')
    expect(fullFrame).toContain('claude-sonnet-4')
    expect(fullFrame).toContain('my-workspace')
    expect(fullFrame).toContain('Enter send')
    expect(fullFrame).toContain('/help')
    expect(fullFrame).not.toContain('● Ready')
    expect(fullFrame).not.toMatch(/[─╭╰╮╯│]/)

    // Collapses cleanly on short viewports (chatHeight < 8)
    Object.defineProperty(app.stdout, 'columns', { value: 60, configurable: true })
    Object.defineProperty(app.stdout, 'rows', { value: 11, configurable: true })
    app.stdout.emit('resize')
    await tick()

    const shortFrame = stripAnsi(app.lastFrame() ?? '')
    expect(shortFrame).toContain('MILO · ready')
    expect(shortFrame).toContain('Ask Milo anything · /help')
    expect(shortFrame).not.toContain('▄▄█████▄')
    expect(shortFrame.split('\n').length).toBeLessThanOrEqual(11)
    expect(shortFrame).not.toMatch(/[─╭╰╮╯│]/)

    // Collapses cleanly on narrow viewports (columns < 44)
    Object.defineProperty(app.stdout, 'columns', { value: 38, configurable: true })
    Object.defineProperty(app.stdout, 'rows', { value: 24, configurable: true })
    app.stdout.emit('resize')
    await tick()

    const narrowFrame = stripAnsi(app.lastFrame() ?? '')
    expect(narrowFrame).toContain('MILO · ready')
    expect(narrowFrame).not.toContain('▄▄█████▄')
    expect(narrowFrame).not.toMatch(/[─╭╰╮╯│]/)
  })

  it('draws a proportional right-edge scrollbar when content overflows and moves the thumb on scroll', async () => {
    async function* stream(): AsyncGenerator<AgentEvent> {
      const lines = Array.from({ length: 60 }, (_, index) => `line ${index}`)
      yield { type: 'text-delta', delta: lines.join('\n') }
      yield { type: 'done', finishReason: 'stop' }
    }

    const { stdin, lastFrame } = renderChat(makeRuntime(() => stream()))
    // Before overflow: no scrollbar
    expect(stripAnsi(lastFrame() ?? '')).not.toMatch(/[┃┆]/)

    await submit(stdin, 'show many lines')
    await waitForFrame(lastFrame, 'line 59')

    const atBottom = stripAnsi(lastFrame() ?? '')
    expect(atBottom).toContain('┃')
    expect(atBottom).toContain('┆')
    expect(atBottom).not.toMatch(/[─╭╰╮╯│]/)

    const bottomRows = atBottom.split('\n')
    const bottomThumbRow = bottomRows.findIndex((row) => row.trimEnd().endsWith('┃'))
    const bottomTrackRow = bottomRows.findIndex((row) => row.trimEnd().endsWith('┆'))
    expect(bottomTrackRow).toBeGreaterThan(-1)
    expect(bottomThumbRow).toBeGreaterThan(bottomTrackRow)

    // Scroll up toward the top of the transcript
    for (let i = 0; i < 6; i += 1) {
      stdin.write('\u001b[1;3A')
      await tick(10)
    }
    await tick()

    const scrolledFrame = stripAnsi(lastFrame() ?? '')
    const scrolledRows = scrolledFrame.split('\n')
    const scrolledThumbRow = scrolledRows.findIndex((row) => row.trimEnd().endsWith('┃'))
    expect(scrolledThumbRow).toBeGreaterThan(-1)
    expect(scrolledThumbRow).toBeLessThan(bottomThumbRow)
    expect(scrolledFrame).not.toMatch(/[─╭╰╮╯│]/)
  })

  it('renders the context meter with budget, folder label, and mode badges', async () => {
    let usageTokens = 12_000
    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'usage', inputTokens: usageTokens, outputTokens: 10 }
      yield { type: 'text-delta', delta: 'ok' }
      yield { type: 'done', finishReason: 'stop' }
    }

    const { lastFrame, stdin } = renderChat(makeRuntime(() => stream()), {
      mode: 'yolo',
      model: { provider: 'commandcode', model: 'claude-sonnet-4', effort: 'medium' },
      sessionFolder: '/tmp/alpha-repo',
      maxInputTokens: 200_000,
    })

    const initial = lastFrame() ?? ''
    const plainInitial = stripAnsi(initial)
    expect(plainInitial).not.toContain('● Ready')
    expect(plainInitial).toContain('Unrestricted')
    expect(plainInitial).toContain('folder alpha-repo')
    if (initial.includes('\u001b[')) {
      // danger (#DA392F) on Unrestricted, secondary (#508080) on alpha-repo
      expect(initial).toContain('\u001b[38;2;218;57;47mUnrestricted')
      expect(initial).toContain('\u001b[38;2;80;128;128malpha-repo')
    }

    await submit(stdin, 'first')
    const lowUsage = await waitForFrame(lastFrame, '◔ 12k/200k tok')
    if (lowUsage.includes('\u001b[')) {
      const statusRow = lowUsage.split('\n').find((row) => row.includes('◔ 12k/200k tok')) ?? ''
      expect(statusRow).toContain('\u001b[38;2;125;115;115m')
      expect(statusRow).not.toContain('\u001b[38;2;151;108;12m')
      expect(statusRow).not.toContain('\u001b[38;2;218;57;47m')
    }

    usageTokens = 150_000
    await submit(stdin, 'second')
    const warnUsage = await waitForFrame(lastFrame, '◔ 150k/200k tok')
    if (warnUsage.includes('\u001b[')) {
      expect(warnUsage).toContain('\u001b[38;2;151;108;12m◔ 150k/200k tok')
    }

    usageTokens = 185_000
    await submit(stdin, 'third')
    const highUsage = await waitForFrame(lastFrame, '◔ 185k/200k tok')
    if (highUsage.includes('\u001b[')) {
      expect(highUsage).toContain('\u001b[38;2;218;57;47m◔ 185k/200k tok')
    }
  })

  it('returns from tool execution to subtle ellipsis waiting instead of thinking…', async () => {
    let releaseAfterTool!: () => void
    const afterTool = new Promise<void>((resolve) => { releaseAfterTool = resolve })

    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'tool-start', id: 'c1', name: 'read_file', args: { path: 'a.ts' } }
      yield { type: 'tool-end', id: 'c1', name: 'read_file', result: 'ok', isError: false }
      await afterTool
      yield { type: 'text-delta', delta: 'Read it.' }
      yield { type: 'done', finishReason: 'stop' }
    }

    const { lastFrame, stdin } = renderChat(makeRuntime(stream))
    await submit(stdin, 'read a.ts')
    expect(lastFrame()).toContain('…')
    expect(lastFrame()).not.toContain('thinking…')

    releaseAfterTool()
    await waitForFrame(lastFrame, 'Read it.')
  })

  it('shows unmeasured reasoning text without inventing a Thought for duration when closed on text', async () => {
    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'reasoning-delta', delta: 'considering trade-offs' }
      yield { type: 'text-delta', delta: 'Use option B.' }
      yield { type: 'done', finishReason: 'stop' }
    }

    const { lastFrame, stdin } = renderChat(makeRuntime(stream))
    await submit(stdin, 'compare')
    const frame = await waitForFrame(lastFrame, 'Use option B.')
    expect(frame).toContain('considering trade-offs')
    expect(frame).not.toContain('✻ Thought for')
  })

  it('keeps replayed post-hoc reasoning in the transcript without showing thinking… or Thought for', async () => {
    let release!: () => void
    const hold = new Promise<void>((resolve) => { release = resolve })

    async function* stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'response-waiting' }
      yield { type: 'reasoning-delta', delta: 'post-hoc summary', replayed: true }
      await hold
      yield { type: 'text-delta', delta: 'Final line.' }
      yield { type: 'done', finishReason: 'stop' }
    }

    const { lastFrame, stdin } = renderChat(makeRuntime(stream))
    await submit(stdin, 'summarize')
    await tick()
    expect(lastFrame()).toContain('…')
    expect(lastFrame()).not.toContain('thinking…')

    release()
    const frame = await waitForFrame(lastFrame, 'Final line.')
    expect(frame).toContain('post-hoc summary')
    expect(frame).not.toContain('✻ Thought for')
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
    expect(lastFrame()).toContain('· 1 queued')
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
    expect(lastFrame()).toContain('· 1 queued')

    stdin.write('\u0003')
    await tick()
    expect(lastFrame()).not.toContain('· 1 queued')

    // The turn the stub was holding ends; the queued message must not run.
    release()
    await tick()

    expect(sent.map((turn) => turn.text)).toEqual(['first'])
    expect(lastFrame()).toContain('1 queued message dropped')
    expect(lastFrame()).not.toContain('thinking…')
  })

  it('starts a new session and sends the core setup help prompt on /computer setup', async () => {
    const sent: Array<{ sessionId: string; text: string }> = []
    let activeSession = {
      id: 'initial-1',
      messages: [],
      send: (text: string) => {
        sent.push({ sessionId: 'initial-1', text })
        async function* stream(): AsyncGenerator<AgentEvent> {
          yield { type: 'done', finishReason: 'stop' }
        }
        return stream()
      },
    }
    const status = {
      available: true,
      platform: 'linux' as const,
      sdkVersion: '0.56.4',
      displayServer: 'wayland+xwayland' as const,
      waylandEnabled: true,
      atspiAvailable: true,
      screenCaptureAvailable: true,
      inputModes: {
        accessibility: true,
        windowScopedPointer: false,
        xsendEvent: false,
        hyprlandPlugin: false,
      },
      hyprlandPluginState: 'installed_not_loaded' as const,
      limitations: ['Hyprland Cua plugin is installed but not loaded in the compositor.'],
      summary: 'Ready (Hyprland plugin installed, not loaded)',
    }
    const runtime = {
      computer: {
        probe: async () => status,
      } as unknown as ComputerManager,
      getSession: async () => activeSession,
      newSession: async () => {
        activeSession = {
          id: 'setup-2',
          messages: [],
          send: (text: string) => {
            sent.push({ sessionId: 'setup-2', text })
            async function* stream(): AsyncGenerator<AgentEvent> {
              yield { type: 'text-delta', delta: 'Checking host state.' }
              yield { type: 'done', finishReason: 'stop' }
            }
            return stream()
          },
        }
        return activeSession
      },
    } as unknown as AgentRuntime

    const switched: string[] = []
    const { lastFrame, stdin } = renderChat(runtime, {
      onSessionChange: (id) => switched.push(id),
    })
    await submit(stdin, '/computer setup')

    await waitUntil(() => sent.length === 1 && (lastFrame() ?? '').includes('Checking host state.'))
    expect(switched).toEqual(['setup-2'])
    expect(sent[0]?.sessionId).toBe('setup-2')
    expect(sent[0]?.text).toContain('installed_not_loaded')
    expect(sent[0]?.text).toContain(OMARCHY_ACTIVATION_GUIDE)
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
