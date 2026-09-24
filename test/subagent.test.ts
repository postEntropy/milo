import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { runSubagent, type SubagentRun } from '../src/core/agent/subagent.js'
import type { ChatRequest, Provider, StreamEvent } from '../src/core/providers/types.js'
import { DefaultPermissionPolicy } from '../src/core/tools/permission.js'
import { ToolRegistry } from '../src/core/tools/registry.js'
import { taskTool } from '../src/core/tools/task.js'
import type { Tool, ToolContext } from '../src/core/tools/types.js'

class ScriptedProvider implements Provider {
  readonly id = 'scripted'
  calls = 0
  last?: ChatRequest

  constructor(private readonly scripts: StreamEvent[][]) {}

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    this.last = req
    const script = this.scripts[this.calls] ?? [{ type: 'done', finishReason: 'stop' }]
    this.calls += 1
    for (const event of script) yield event
  }
}

const fakeRead: Tool<{ path: string }> = {
  name: 'fake_read',
  description: 'fake read',
  schema: z.object({ path: z.string() }),
  readOnly: true,
  async execute(args) {
    return { content: `FILE:${args.path}` }
  },
}

/** Side-effecting on purpose, so the policy has something to ask about. */
const fakeWrite: Tool<{ path: string }> = {
  name: 'fake_write',
  description: 'fake write',
  schema: z.object({ path: z.string() }),
  async execute(args) {
    return { content: `WROTE:${args.path}` }
  },
}

const ctx = (): ToolContext => ({ cwd: process.cwd(), signal: new AbortController().signal })

describe('task tool', () => {
  it('fails cleanly on a context that cannot delegate', async () => {
    const result = await taskTool.execute({ description: 'd', prompt: 'p' }, ctx())

    expect(result.isError).toBe(true)
    expect(result.content).toContain('Subagents are not available')
  })

  it('hands the subtask to the context', async () => {
    const seen: { description: string; prompt: string }[] = []
    const context: ToolContext = {
      ...ctx(),
      task: async (input) => {
        seen.push(input)
        return { content: 'the report' }
      },
    }

    const result = await taskTool.execute({ description: 'survey deps', prompt: 'list them' }, context)

    expect(seen).toEqual([{ description: 'survey deps', prompt: 'list them' }])
    expect(result.content).toBe('the report')
  })

  it('is offered, but the description tells the model to delegate only on request', async () => {
    // The description is the whole mechanism: the model reads it in the tool
    // list every turn, so this is what keeps it from delegating on its own.
    expect(taskTool.description).toContain('only when the user has explicitly asked')
    expect(taskTool.description).toContain('do not delegate on your own initiative')
  })

  it('never asks on its own, but deny still blocks it', async () => {
    expect(taskTool.delegates).toBe(true)
    expect(await new DefaultPermissionPolicy().decide(taskTool, { description: 'd', prompt: 'p' })).toBe(
      'allow',
    )
    // The prompt for the write it leads to is the one that matters; a plain
    // side-effecting tool must still ask.
    expect(await new DefaultPermissionPolicy().decide(fakeWrite, { path: 'x' })).toBe('ask')
    expect(
      await new DefaultPermissionPolicy({ deny: ['task'] }).decide(taskTool, {}),
    ).toBe('deny')
  })
})

describe('runSubagent', () => {
  function run(over: Partial<SubagentRun>): Promise<{ content: string; isError?: boolean }> {
    const registry = over.registry ?? new ToolRegistry([fakeRead])
    return runSubagent({
      provider: new ScriptedProvider([
        [
          { type: 'text', delta: 'the report' },
          { type: 'done', finishReason: 'stop' },
        ],
      ]),
      model: 'm',
      registry,
      cwd: process.cwd(),
      signal: new AbortController().signal,
      input: { description: 'd', prompt: 'do the thing' },
      context: {},
      ...over,
    })
  }

  it('runs its own loop and returns only the final report', async () => {
    const result = await run({})

    expect(result.isError).toBeFalsy()
    expect(result.content).toBe('the report')
  })

  it('does not offer `task` to the subagent — delegation is one level deep', async () => {
    const provider = new ScriptedProvider([
      [
        { type: 'text', delta: 'ok' },
        { type: 'done', finishReason: 'stop' },
      ],
    ])

    await run({ provider, registry: new ToolRegistry([taskTool, fakeRead]) })

    const names = provider.last?.tools?.map((tool) => tool.name) ?? []
    expect(names).toContain('fake_read')
    expect(names).not.toContain('task')
  })

  it('gives the subagent its own system prompt: no surface, no memories', async () => {
    const provider = new ScriptedProvider([
      [
        { type: 'text', delta: 'ok' },
        { type: 'done', finishReason: 'stop' },
      ],
    ])

    await run({ provider, input: { description: 'd', prompt: 'do the thing' } })

    const system = provider.last?.system ?? ''
    expect(system).toContain('You are a subagent')
    expect(system).toContain('## Available tools')
    expect(system).not.toContain('You are talking through')
    expect(system).not.toContain('<memories>')
    // The instruction is the subagent's one user turn.
    expect(provider.last?.messages[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'do the thing' }],
    })
  })

  it("puts the subagent's confirmations to the parent's ask", async () => {
    const provider = new ScriptedProvider([
      [
        { type: 'tool-call', id: 'c1', name: 'fake_write', args: { path: 'x' } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'text', delta: 'done' },
        { type: 'done', finishReason: 'stop' },
      ],
    ])
    const asked: string[] = []

    const result = await run({
      provider,
      registry: new ToolRegistry([fakeWrite]),
      permission: {
        policy: new DefaultPermissionPolicy({ mode: 'ask' }),
        ask: async (request) => {
          asked.push(request.tool)
          return { allowed: true }
        },
      },
    })

    expect(asked).toEqual(['fake_write'])
    expect(result.content).toBe('done')
  })

  it('reports an error when the subagent runs out of steps without an answer', async () => {
    const provider = new ScriptedProvider([
      [
        { type: 'tool-call', id: 'c1', name: 'fake_read', args: { path: 'a' } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
    ])

    const result = await run({ provider, maxSteps: 1 })

    expect(result.isError).toBe(true)
    expect(result.content).toContain('could not finish')
  })
})
