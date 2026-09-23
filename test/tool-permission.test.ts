import { beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { AgentEvent } from '../src/core/agent/events.js'
import { runAgent } from '../src/core/agent/loop.js'
import type { ChatRequest, Provider, StreamEvent } from '../src/core/providers/types.js'
import { DefaultPermissionPolicy, type PermissionAsker } from '../src/core/tools/permission.js'
import { builtinTools } from '../src/core/tools/index.js'
import { ToolRegistry } from '../src/core/tools/registry.js'
import type { Tool } from '../src/core/tools/types.js'

class OneShotProvider implements Provider {
  readonly id = 'one-shot'
  async *stream(_req: ChatRequest): AsyncGenerator<StreamEvent> {
    yield { type: 'tool-call', id: 'c1', name: 'shell_command', args: { command: 'echo hi' } }
    yield { type: 'done', finishReason: 'tool_calls' }
  }
}

const executed: string[] = []

const shellTool: Tool<{ command: string }> = {
  name: 'shell_command',
  description: '',
  schema: z.object({ command: z.string() }),
  readOnly: false,
  async execute(args) {
    executed.push(args.command)
    return { content: 'ran' }
  },
}

beforeEach(() => {
  executed.length = 0
})

async function run(permission?: { policy: DefaultPermissionPolicy; ask?: PermissionAsker }) {
  const registry = new ToolRegistry([shellTool])
  const events: AgentEvent[] = []
  for await (const event of runAgent({
    provider: new OneShotProvider(),
    model: 'm',
    tools: registry.specs(),
    registry,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
    context: { cwd: process.cwd(), signal: new AbortController().signal },
    maxSteps: 1,
    permission,
  })) {
    events.push(event)
  }
  return events
}

const resultOf = (events: AgentEvent[]) =>
  events.find((event): event is Extract<AgentEvent, { type: 'tool-end' }> => event.type === 'tool-end')

describe('tool permission gating', () => {
  it('classifies every builtin tool, which is what decides a prompt', () => {
    const readOnly = Object.fromEntries(
      builtinTools.map((tool) => [tool.name, tool.readOnly ?? false]),
    )

    expect(readOnly).toEqual({
      read_file: true,
      list_dir: true,
      glob: true,
      grep: true,
      fetch_url: true,
      write_file: false,
      edit_file: false,
      remember: false,
      search_history: true,
      shell_command: false,
    })
  })

  it('never asks for a tool whose side effect is Milo\'s own state', () => {
    const internal = builtinTools.filter((tool) => tool.internal).map((tool) => tool.name)

    expect(internal).toEqual(['remember'])
  })

  it('runs the tool when allowed', async () => {
    const events = await run({
      policy: new DefaultPermissionPolicy(),
      ask: async () => ({ allowed: true }),
    })
    expect(executed).toEqual(['echo hi'])
    expect(resultOf(events)).toMatchObject({ isError: false, result: 'ran' })
  })

  it('does not run the tool when the user denies', async () => {
    const events = await run({
      policy: new DefaultPermissionPolicy(),
      ask: async () => ({ allowed: false }),
    })
    expect(executed).toEqual([])
    expect(resultOf(events)?.isError).toBe(true)
    expect(resultOf(events)?.result).toContain('denied')
  })

  it('fails closed when no asker is available', async () => {
    const events = await run({ policy: new DefaultPermissionPolicy() })
    expect(executed).toEqual([])
    expect(resultOf(events)?.result).toContain('cannot ask')
  })

  it('honors a deny policy', async () => {
    const events = await run({ policy: new DefaultPermissionPolicy({ deny: ['shell_command'] }) })
    expect(executed).toEqual([])
    expect(resultOf(events)?.result).toContain('denied by the permission policy')
  })

  it('runs without gating when no policy is configured', async () => {
    await run(undefined)
    expect(executed).toEqual(['echo hi'])
  })
})
