import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { AgentEvent } from '../src/core/agent/events.js'
import { runAgent } from '../src/core/agent/loop.js'
import { CrewStore } from '../src/core/crew.js'
import type { ChatRequest, Provider, StreamEvent } from '../src/core/providers/types.js'
import { DefaultPermissionPolicy, type PermissionAsker, type PermissionRequest } from '../src/core/tools/permission.js'
import { crewTool } from '../src/core/tools/crew.js'
import { builtinTools, sessionsTool } from '../src/core/tools/index.js'
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
      read_attachment: true,
      view_image: true,
      list_dir: true,
      glob: true,
      grep: true,
      fetch_url: true,
      git: true,
      git_commit: false,
      write_file: false,
      edit_file: false,
      apply_patch: false,
      format: false,
      memories: false,
      remember: false,
      instructions: false,
      recall: true,
      sessions: false,
      search_history: true,
      read_x_post: true,
      routine: false,
      send_file: false,
      panel: false,
      task: false,
      crew: false,
      delegated_work: false,
      todo: false,
      task_lists: false,
      shell_command: false,
    })
  })

  it('marks the delegating tool, which speaks for the subagent rather than itself', () => {
    const delegates = builtinTools.filter((tool) => tool.delegates).map((tool) => tool.name)

    expect(delegates).toEqual(['task'])
  })

  it('never asks for a tool whose side effect is Milo\'s own state', () => {
    const internal = builtinTools.filter((tool) => tool.internal).map((tool) => tool.name)

    expect(internal).toEqual(['remember', 'panel', 'crew', 'todo', 'task_lists'])
  })

  it('asks before a session is removed, but not before the list is read', () => {
    // The danger is in the arguments, not the name: a reader is not a deleter.
    expect(sessionsTool.asksWhen?.({ action: 'list' })).toBe(false)
    expect(sessionsTool.asksWhen?.({})).toBe(false)
    expect(sessionsTool.asksWhen?.({ action: 'remove', id: 'calm-otter-7' })).toBe(true)
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

  it('asks before removing a Crew bot in ask and auto modes, deletes without asking in yolo, and respects running-to-completed transitions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'milo-crew-perm-'))
    try {
      const crew = new CrewStore(join(dir, 'crew.json'))
      const first = await crew.start({ name: 'Scout', mission: 'Read', model: 'm', sessionId: 's' })
      await crew.finish(first.bot.id, first.assignment.id, 'completed', 'Done')

      const invokeTool = async (
        tool: Tool<never>,
        args: Record<string, unknown>,
        permission?: { policy: DefaultPermissionPolicy; ask?: PermissionAsker },
        store: CrewStore = crew,
      ) => {
        const registry = new ToolRegistry([tool])
        const events: AgentEvent[] = []
        const provider: Provider = {
          id: 'crew-one-shot',
          async *stream() {
            yield { type: 'tool-call', id: 'c1', name: tool.name, args }
            yield { type: 'done', finishReason: 'tool_calls' }
          },
        }
        for await (const event of runAgent({
          provider,
          model: 'm',
          tools: registry.specs(),
          registry,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
          context: { cwd: process.cwd(), signal: new AbortController().signal, crew: store },
          maxSteps: 1,
          permission,
        })) {
          events.push(event)
        }
        return resultOf(events)
      }

      const prompts: PermissionRequest[] = []
      const askAllow: PermissionAsker = async (req) => {
        prompts.push(req)
        return { allowed: true }
      }
      const askDeny: PermissionAsker = async (req) => {
        prompts.push(req)
        return { allowed: false }
      }

      // Non-remove crew actions remain unprompted in Ask and Auto.
      expect((await invokeTool(crewTool as Tool<never>, { action: 'list' }, { policy: new DefaultPermissionPolicy(), ask: askDeny }))?.isError).toBe(false)
      expect((await invokeTool(crewTool as Tool<never>, { action: 'rename', id: first.bot.id, name: 'Sage' }, { policy: new DefaultPermissionPolicy(), ask: askDeny }))?.isError).toBe(false)
      expect(prompts).toEqual([])
      expect(crew.list()[0]?.name).toBe('Sage')

      // Missing id returns error directly without prompting.
      const missing = await invokeTool(crewTool as Tool<never>, { action: 'remove', id: 'missing' }, { policy: new DefaultPermissionPolicy(), ask: askDeny })
      expect(missing?.isError).toBe(true)
      expect(missing?.result).toContain('No bot has that id.')
      expect(prompts).toEqual([])

      // Ask mode: always confirms even when policy allows `crew`, and preserves bot if unaskable or denied.
      const unaskableAsk = await invokeTool(crewTool as Tool<never>, { action: 'remove', id: first.bot.id }, { policy: new DefaultPermissionPolicy({ mode: 'ask', allow: ['crew'] }) })
      expect(unaskableAsk?.isError).toBe(true)
      expect(unaskableAsk?.result).toContain('cannot ask')
      expect(crew.list()).toHaveLength(1)

      const deniedAsk = await invokeTool(crewTool as Tool<never>, { action: 'remove', id: first.bot.id }, { policy: new DefaultPermissionPolicy({ mode: 'ask', allow: ['crew'] }), ask: askDeny })
      expect(deniedAsk?.isError).toBe(true)
      expect(deniedAsk?.result).toContain('denied')
      expect(prompts).toHaveLength(1)
      expect(prompts[0]).toMatchObject({
        tool: 'crew',
        summary: `Remove bot Sage (${first.bot.id}) and its assignment history (1 assignment)`,
      })
      expect(crew.list()).toHaveLength(1)

      // Auto mode: always confirms even when reviewer & allow-list permit it, and preserves bot if unaskable or denied.
      const autoPolicy = new DefaultPermissionPolicy({ mode: 'auto', allow: ['crew'], reviewer: { review: async () => 0 } })
      const unaskableAuto = await invokeTool(crewTool as Tool<never>, { action: 'remove', id: first.bot.id }, { policy: autoPolicy })
      expect(unaskableAuto?.isError).toBe(true)
      expect(unaskableAuto?.result).toContain('cannot ask')
      expect(crew.list()).toHaveLength(1)

      const deniedAuto = await invokeTool(crewTool as Tool<never>, { action: 'remove', id: first.bot.id }, { policy: autoPolicy, ask: askDeny })
      expect(deniedAuto?.isError).toBe(true)
      expect(deniedAuto?.result).toContain('denied')
      expect(prompts).toHaveLength(2)
      expect(crew.list()).toHaveLength(1)

      const allowedAuto = await invokeTool(crewTool as Tool<never>, { action: 'remove', id: first.bot.id }, { policy: autoPolicy, ask: askAllow })
      expect(allowedAuto?.isError).toBe(false)
      expect(allowedAuto?.result).toBe(`Removed bot Sage (${first.bot.id}).`)
      expect(crew.list()).toEqual([])

      // Unrestricted (yolo) mode: deletes crew remove without asking, even without an asker.
      const yoloBot = await crew.start({ name: 'Atlas', mission: 'Audit', model: 'm', sessionId: 's' })
      await crew.finish(yoloBot.bot.id, yoloBot.assignment.id, 'completed', 'Done')
      const promptsBeforeYolo = prompts.length
      const removedYolo = await invokeTool(crewTool as Tool<never>, { action: 'remove', id: yoloBot.bot.id }, { policy: new DefaultPermissionPolicy({ mode: 'yolo' }) })
      expect(removedYolo?.isError).toBe(false)
      expect(removedYolo?.result).toBe(`Removed bot Atlas (${yoloBot.bot.id}).`)
      expect(prompts).toHaveLength(promptsBeforeYolo)
      expect(crew.list()).toEqual([])

      // Other tools with requiresConfirmation still require confirmation in yolo mode.
      let guardedExecuted = false
      const guardedTool: Tool<Record<string, never>> = {
        name: 'guarded_action',
        description: '',
        schema: z.object({}),
        requiresConfirmation: () => true,
        async execute() { guardedExecuted = true; return { content: 'ok' } },
      }
      const guardedYolo = await invokeTool(guardedTool as Tool<never>, {}, { policy: new DefaultPermissionPolicy({ mode: 'yolo' }) })
      expect(guardedYolo?.isError).toBe(true)
      expect(guardedYolo?.result).toContain('cannot ask')
      expect(guardedExecuted).toBe(false)

      // Transition from running -> completed, plus race where bot finishes right after initial list().
      const active = await crew.start({ name: 'Runner', mission: 'Build', model: 'm', sessionId: 's' })
      const raceStore = Object.create(crew) as CrewStore
      let finishPromise: Promise<unknown> | undefined
      raceStore.list = () => {
        const snapshot = crew.list()
        if (!finishPromise) {
          finishPromise = crew.finish(active.bot.id, active.assignment.id, 'completed', 'Finished mid-flight')
        }
        return snapshot
      }
      const promptsBeforeRunning = prompts.length
      const whileRunningAsk = await invokeTool(crewTool as Tool<never>, { action: 'remove', id: active.bot.id }, { policy: new DefaultPermissionPolicy({ mode: 'ask' }), ask: askAllow }, raceStore)
      expect(whileRunningAsk?.isError).toBe(true)
      expect(whileRunningAsk?.result).toContain('still working')
      expect(prompts).toHaveLength(promptsBeforeRunning)

      await finishPromise
      expect(crew.list()[0]?.assignments[0]?.state).toBe('completed')

      const deniedAfterFinish = await invokeTool(crewTool as Tool<never>, { action: 'remove', id: active.bot.id }, { policy: new DefaultPermissionPolicy({ mode: 'ask' }), ask: askDeny })
      expect(deniedAfterFinish?.isError).toBe(true)
      expect(deniedAfterFinish?.result).toContain('denied')
      expect(crew.list()).toHaveLength(1)

      const allowedAfterFinish = await invokeTool(crewTool as Tool<never>, { action: 'remove', id: active.bot.id }, { policy: new DefaultPermissionPolicy({ mode: 'ask' }), ask: askAllow })
      expect(allowedAfterFinish?.isError).toBe(false)
      expect(crew.list()).toEqual([])

      // Running bot is also refused in yolo until completed, then deleted without asking once completed.
      const activeYolo = await crew.start({ name: 'Runner2', mission: 'Build', model: 'm', sessionId: 's' })
      const whileRunningYolo = await invokeTool(crewTool as Tool<never>, { action: 'remove', id: activeYolo.bot.id }, { policy: new DefaultPermissionPolicy({ mode: 'yolo' }) })
      expect(whileRunningYolo?.isError).toBe(true)
      expect(whileRunningYolo?.result).toContain('still working')
      expect(crew.list()).toHaveLength(1)

      await crew.finish(activeYolo.bot.id, activeYolo.assignment.id, 'completed', 'Done')
      const removedAfterFinishYolo = await invokeTool(crewTool as Tool<never>, { action: 'remove', id: activeYolo.bot.id }, { policy: new DefaultPermissionPolicy({ mode: 'yolo' }) })
      expect(removedAfterFinishYolo?.isError).toBe(false)
      expect(crew.list()).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
