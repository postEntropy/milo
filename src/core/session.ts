import { errorMessage } from '../util/errors.js'
import type { SessionsConfig } from './config/schema.js'
import type { Memory, MemoryScope } from './memory/index.js'
import type { Message, Provider } from './providers/types.js'
import type { PermissionAsker, PermissionPolicy, ToolRegistry } from './tools/index.js'
import type { AgentEvent } from './agent/events.js'
import { runAgent } from './agent/loop.js'
import { buildSystemPrompt, type SurfaceKind } from './agent/system.js'
import {
  countTurns,
  estimateTokens,
  planCut,
  summarize,
  type SessionRecord,
  type SessionStats,
  type SessionStore,
} from './sessions/index.js'

const SURFACES: SurfaceKind[] = ['cli', 'telegram', 'discord']

function asSurface(gateway: string): SurfaceKind | undefined {
  return (SURFACES as string[]).includes(gateway) ? (gateway as SurfaceKind) : undefined
}

export interface SessionOptions {
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
  /** The record this session reads from and writes back to. */
  record: SessionRecord
  store: SessionStore
  sessions?: SessionsConfig
}

export interface SendOptions {
  signal?: AbortSignal
  /** The surface's inline confirmation prompt for tools that need it. */
  ask?: PermissionAsker
}

export class Session {
  /** The session's own name (`calm-otter-7`), not the transport address. */
  readonly id: string
  readonly messages: Message[]
  /** Where this session is currently talking to; memory is scoped by it. */
  scope: MemoryScope
  private readonly record: SessionRecord
  private readonly store: SessionStore
  private readonly options: SessionOptions
  private summary: string | undefined

  constructor(options: SessionOptions) {
    this.options = options
    this.record = options.record
    this.store = options.store
    this.id = options.record.id
    this.scope = options.scope
    this.messages = options.record.messages
    this.summary = options.record.summary
  }

  get title(): string | undefined {
    return this.record.title
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
      permissionPolicy,
    } = this.options
    const signal = opts?.signal

    await this.compactIfNeeded(signal)

    const tools = registry.specs()
    const recalled = await memory.recall(this.scope, input, {
      limit: this.options.recallLimit ?? 5,
    })
    const systemPrompt = buildSystemPrompt({
      base: system,
      surface: asSurface(this.scope.gateway),
      cwd,
      provider: provider.id,
      model,
      tools,
      memories: recalled,
      summary: this.summary,
    })

    this.messages.push({ role: 'user', content: [{ type: 'text', text: input }] })
    // Persist the user's message now, so a crash mid-answer does not lose it.
    await this.persist()

    let errored = false

    try {
      for await (const event of runAgent({
        provider,
        model,
        system: systemPrompt,
        tools,
        registry,
        messages: this.messages,
        context: {
          cwd,
          signal: signal ?? new AbortController().signal,
          // Read through `this.scope` at call time: a gateway can rebind the
          // session to another conversation while it is running.
          remember: (items) => memory.remember(this.scope, items),
        },
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
    } finally {
      // Runs even when the consumer aborts, so the partial turn is on disk.
      await this.persist()
    }

    // Remember only what the user said — the assistant's own replies are not
    // durable facts and would pollute recall.
    if (!errored && input.trim()) {
      await memory.remember(this.scope, [{ text: input, tags: ['user'] }])
    }
  }

  /** Forgets the transcript (and any summary) but keeps the session's identity. */
  async clear(): Promise<void> {
    this.messages.length = 0
    this.summary = undefined
    this.record.droppedTokens = undefined
    await this.persist()
  }

  /** Rewrites the timestamp and writes the record back to the store. */
  async persist(): Promise<void> {
    this.record.messages = this.messages
    this.record.summary = this.summary
    this.record.updatedAt = Date.now()
    await this.store.save(this.record)
  }

  stats(): SessionStats {
    return {
      id: this.id,
      title: this.record.title,
      createdAt: this.record.createdAt,
      updatedAt: this.record.updatedAt,
      messages: this.messages.length,
      turns: countTurns(this.messages),
      tokens: estimateTokens(this.messages),
      compacted: this.summary !== undefined,
      droppedTokens: this.record.droppedTokens,
    }
  }

  /**
   * Over the budget: summarize the oldest turns into `summary` and drop them.
   * If the summary call fails, the turns are dropped anyway — a request that
   * fits beats one that is rejected by the provider.
   */
  private async compactIfNeeded(signal?: AbortSignal): Promise<void> {
    const config = this.options.sessions
    if (!config?.compaction) return
    if (estimateTokens(this.messages) <= config.maxInputTokens) return

    const cut = planCut(this.messages, config.keepTurns)
    if (cut <= 0) return

    const dropped = this.messages.slice(0, cut)
    let summary: string | null = null
    try {
      summary = await summarize({
        provider: this.options.provider,
        model: this.options.model,
        previous: this.summary,
        dropped,
        signal,
      })
    } catch {
      summary = null
    }

    if (summary) this.summary = summary
    this.record.droppedTokens = (this.record.droppedTokens ?? 0) + estimateTokens(dropped)
    this.messages.splice(0, cut)
  }
}
