import { errorMessage } from '../util/errors.js'
import type { Memory, MemoryScope } from './memory/index.js'
import type { Message, Provider } from './providers/types.js'
import type { PermissionAsker, PermissionPolicy, ToolRegistry } from './tools/index.js'
import type { AgentEvent } from './agent/events.js'
import { runAgent } from './agent/loop.js'
import { buildSystemPrompt, type SurfaceKind } from './agent/system.js'

const SURFACES: SurfaceKind[] = ['cli', 'telegram', 'discord']

function asSurface(gateway: string): SurfaceKind | undefined {
  return (SURFACES as string[]).includes(gateway) ? (gateway as SurfaceKind) : undefined
}

export interface SessionOptions {
  id: string
  scope: MemoryScope
  provider: Provider
  model: string
  system: string
  registry: ToolRegistry
  memory: Memory
  cwd: string
  maxSteps?: number
  temperature?: number
  recallLimit?: number
  permissionPolicy?: PermissionPolicy
}

export interface SendOptions {
  signal?: AbortSignal
  /** The surface's inline confirmation prompt for tools that need it. */
  ask?: PermissionAsker
}

export class Session {
  readonly id: string
  readonly messages: Message[] = []
  private readonly options: SessionOptions

  constructor(options: SessionOptions) {
    this.id = options.id
    this.options = options
  }

  async *send(input: string, opts?: SendOptions): AsyncGenerator<AgentEvent> {
    const {
      provider,
      model,
      system,
      registry,
      memory,
      cwd,
      maxSteps,
      temperature,
      scope,
      permissionPolicy,
    } = this.options
    const signal = opts?.signal

    const tools = registry.specs()
    const recalled = await memory.recall(scope, input, { limit: this.options.recallLimit ?? 5 })
    const systemPrompt = buildSystemPrompt({
      base: system,
      surface: asSurface(scope.gateway),
      cwd,
      provider: provider.id,
      model,
      tools,
      memories: recalled,
    })

    this.messages.push({ role: 'user', content: [{ type: 'text', text: input }] })

    let errored = false

    try {
      for await (const event of runAgent({
        provider,
        model,
        system: systemPrompt,
        tools,
        registry,
        messages: this.messages,
        context: { cwd, signal: signal ?? new AbortController().signal },
        maxSteps,
        temperature,
        signal,
        permission: permissionPolicy ? { policy: permissionPolicy, ask: opts?.ask } : undefined,
      })) {
        if (event.type === 'error') errored = true
        yield event
      }
    } catch (error) {
      errored = true
      yield { type: 'error', message: errorMessage(error) }
    }

    // Remember only what the user said — the assistant's own replies are not
    // durable facts and would pollute recall.
    if (!errored && input.trim()) {
      await memory.remember(scope, [{ text: input, tags: ['user'] }])
    }
  }
}
