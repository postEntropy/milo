import { errorMessage } from '../util/errors.js'
import type { SessionsConfig } from './config/schema.js'
import type { HistoryEntry, HistoryWriter } from './history.js'
import { scopeKey, type Memory, type MemoryScope } from './memory/index.js'
import type { Message, Provider } from './providers/types.js'
import type { PermissionAsker, PermissionPolicy, ToolRegistry } from './tools/index.js'
import type { AgentEvent } from './agent/events.js'
import { runAgent } from './agent/loop.js'
import { buildSystemPrompt, type SurfaceKind, type SystemPromptInput } from './agent/system.js'
import {
  countTurns,
  digest,
  estimateText,
  estimateTokens,
  MemoryRecapStore,
  planCut,
  rankSessions,
  summarize,
  withRecaps,
  type RecapStore,
  type SessionRecord,
  type SessionStats,
  type SessionStore,
  type SessionSummary,
} from './sessions/index.js'

const SURFACES: SurfaceKind[] = ['cli', 'telegram', 'discord']

function asSurface(gateway: string): SurfaceKind | undefined {
  return (SURFACES as string[]).includes(gateway) ? (gateway as SurfaceKind) : undefined
}

/**
 * Whether the error means "the caller stopped us". A cancelled fetch rejects
 * with an `AbortError`, but the signal is checked too: a provider is free to
 * fail in its own way once the request is already gone.
 */
function isAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  return error instanceof Error && error.name === 'AbortError'
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
  maxTokens?: number
  temperature?: number
  recallLimit?: number
  permissionPolicy?: PermissionPolicy
  /** The record this session reads from and writes back to. */
  record: SessionRecord
  store: SessionStore
  /** Where this session's recap is kept, out of its transcript. */
  recaps?: RecapStore
  sessions?: SessionsConfig
  /** Where a turn is written down for later recall. Absent: nothing is logged. */
  history?: HistoryWriter
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
  private readonly recaps: RecapStore
  private readonly options: SessionOptions
  private summary: string | undefined
  /** Size of the last system prompt sent, which the transcript count omits. */
  private lastSystemTokens: number | undefined

  constructor(options: SessionOptions) {
    this.options = options
    this.record = options.record
    this.store = options.store
    this.recaps = options.recaps ?? new MemoryRecapStore()
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
      maxTokens,
      temperature,
      permissionPolicy,
    } = this.options
    const signal = opts?.signal

    // What this turn leaves in the log: the question, every tool it ran, and
    // what it answered — with the reasoning that got there.
    const entries: HistoryEntry[] = []
    const note = (entry: Omit<HistoryEntry, 'at' | 'session' | 'scope'>) => {
      entries.push({
        at: new Date().toISOString(),
        session: this.id,
        scope: scopeKey(this.scope),
        ...entry,
      })
    }
    let answer = ''
    let reasoning = ''
    let running: { name: string; args: unknown } | null = null

    const tools = registry.specs()
    const recalled = await memory.recall(this.scope, input, {
      limit: this.options.recallLimit ?? 5,
    })
    const prompt = {
      base: system,
      surface: asSurface(this.scope.gateway),
      cwd,
      provider: provider.id,
      model,
      tools,
      memories: recalled,
    }

    // Measured against the request that will actually be sent: the tool list,
    // the recalled memories and the running summary ride along with every turn,
    // and leaving them out of the count let the request go over budget.
    await this.compactIfNeeded(prompt, signal)

    const systemPrompt = buildSystemPrompt({ ...prompt, summary: this.summary })
    this.lastSystemTokens = estimateText(systemPrompt)

    this.messages.push({ role: 'user', content: [{ type: 'text', text: input }] })
    note({ kind: 'user', text: input })
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
          recall: (query, options) => this.recallSessions(query, options),
        },
        maxSteps,
        maxTokens,
        temperature,
        signal,
        permission: permissionPolicy ? { policy: permissionPolicy, ask: opts?.ask } : undefined,
      })) {
        if (event.type === 'error') errored = true
        else if (event.type === 'text-delta') answer += event.delta
        else if (event.type === 'reasoning-delta') reasoning += event.delta
        else if (event.type === 'tool-start') running = { name: event.name, args: event.args }
        else if (event.type === 'tool-end') {
          note({
            kind: 'tool',
            tool: {
              name: event.name,
              args: running?.args ?? {},
              result: event.result,
              isError: event.isError,
            },
          })
          running = null
        }
        yield event
      }
    } catch (error) {
      // A stop is not a failure: reporting `AbortError` to the user turns their
      // own Ctrl+C into a red error line, and the abort is the expected end of
      // a stream the caller cancelled.
      if (isAbort(error, signal)) {
        errored = true
        yield { type: 'aborted' }
      } else {
        errored = true
        yield { type: 'error', message: errorMessage(error) }
      }
    } finally {
      // Runs even when the consumer aborts, so the partial turn is on disk.
      await this.persist()
      // A turn that was stopped still said something worth finding later.
      if (answer || reasoning) note({ kind: 'assistant', text: answer, reasoning })
      this.options.history?.append(entries)
    }

    // Remember only what the user said — the assistant's own replies are not
    // durable facts and would pollute recall. A turn that failed or was stopped
    // is skipped as well: it never got as far as an answer.
    if (!errored && input.trim()) {
      await memory.remember(this.scope, [{ text: input, tags: ['user'] }])
    }
  }

  /** Forgets the transcript (and any summary) but keeps the session's identity. */
  async clear(): Promise<void> {
    this.messages.length = 0
    this.summary = undefined
    this.record.droppedTokens = undefined
    await this.recaps.remove(this.id) // the recap describes what just went away
    await this.persist()
  }

  /**
   * A short recap of the whole session, written when it is switched away from,
   * and kept out of the transcript so it cannot be overwritten by a turn — nor
   * overwrite one. It records which version of the transcript it describes, so a
   * turn landing while it is being written needs no reconciliation: the recap is
   * simply no longer a match, and the next one will be.
   */
  async recap(): Promise<void> {
    if (this.messages.length === 0) return
    const seenAt = this.record.updatedAt
    const existing = await this.recaps.read(this.id)
    if (existing?.sourceUpdatedAt === seenAt) return

    const text = await digest({
      provider: this.options.provider,
      model: this.options.model,
      messages: this.messages,
      summary: this.summary,
    })
    if (!text) return

    await this.recaps.write({ session: this.id, text, sourceUpdatedAt: seenAt, at: Date.now() })
  }

  /** Rewrites the timestamp and writes the record back to the store. */
  async persist(): Promise<void> {
    this.record.messages = this.messages
    this.record.summary = this.summary
    // Strictly increasing: a recap names the transcript version it was written
    // from, and two writes inside the same millisecond would otherwise look
    // like one — leaving a recap that misses a turn forever marked current.
    this.record.updatedAt = Math.max(Date.now(), this.record.updatedAt + 1)
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
      systemTokens: this.lastSystemTokens,
      compacted: this.summary !== undefined,
      droppedTokens: this.record.droppedTokens,
    }
  }

  /**
   * The sessions a question is about, best first. This is the map — which
   * conversation — while `search_history` is the territory: the exact turns.
   */
  async recallSessions(query: string, opts?: { limit?: number }): Promise<SessionSummary[]> {
    const sessions = await withRecaps(await this.store.list(), this.recaps)
    return rankSessions(sessions, query, opts?.limit ?? 5)
  }

  /**
   * Over the budget: summarize the oldest turns into `summary` and drop them.
   * If the summary call fails, the turns are dropped anyway — a request that
   * fits beats one that is rejected by the provider.
   */
  private async compactIfNeeded(
    prompt: Omit<SystemPromptInput, 'summary'>,
    signal?: AbortSignal,
  ): Promise<void> {
    const config = this.options.sessions
    if (!config?.compaction) return

    const used = () =>
      estimateTokens(this.messages) +
      estimateText(buildSystemPrompt({ ...prompt, summary: this.summary }))
    if (used() <= config.maxInputTokens) return

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
