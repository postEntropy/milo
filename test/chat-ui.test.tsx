import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from 'ink-testing-library'
import type { AgentEvent } from '../src/core/agent/events'
import type { AgentRuntime } from '../src/core/runtime'
import type { PermissionMode } from '../src/core/tools/permission'
import { ChatScreen } from '../src/gateways/cli/screens/chat'
import { ModelPicker } from '../src/gateways/cli/screens/model-picker'
import type { Item } from '../src/gateways/cli/transcript'

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
  onOpenModel?: () => void
  onOpenSettings?: () => void
}

function Harness({ runtime, options }: { runtime: AgentRuntime; options: RenderOptions }) {
  const [items, setItems] = useState<Item[]>([])
  return (
    <ChatScreen
      runtime={runtime}
      scope={scope}
      mode={options.mode ?? 'ask'}
      onModeChange={options.onModeChange ?? (() => {})}
      items={items}
      setItems={setItems}
      onOpenModel={options.onOpenModel ?? (() => {})}
      onOpenSettings={options.onOpenSettings ?? (() => {})}
      onExit={() => {}}
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
