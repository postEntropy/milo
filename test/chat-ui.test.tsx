import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from 'ink-testing-library'
import type { AgentEvent } from '../src/core/agent/events.js'
import type { DisplayConfig } from '../src/core/config/schema.js'
import type { AgentRuntime } from '../src/core/runtime.js'
import type { PermissionMode } from '../src/core/tools/permission.js'
import { ChatScreen } from '../src/gateways/cli/screens/chat.js'
import { ModelPicker } from '../src/gateways/cli/screens/model-picker.js'
import type { Item } from '../src/gateways/cli/transcript.js'

const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms))
const scope = { gateway: 'cli', conversationId: 'test' }

function makeRuntime(stream: () => AsyncGenerator<AgentEvent>): AgentRuntime {
  return {
    getSession: () => ({ messages: [], send: () => stream() }),
  } as unknown as AgentRuntime
}

async function submit(stdin: { write: (data: string) => void }, text: string): Promise<void> {
  stdin.write(text)
  await tick(20)
  stdin.write('\r')
  await tick()
}

interface RenderOptions {
  mode?: PermissionMode
  onModeChange?: (mode: PermissionMode) => void
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
      display={options.display ?? { tools: 'full', thinking: true }}
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

    const frame = lastFrame() ?? ''
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

    expect(patches).toEqual([{ tools: 'name' }, { thinking: false }])
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
      display: { tools: 'off', thinking: false },
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
      display: { tools: 'off', thinking: true },
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
