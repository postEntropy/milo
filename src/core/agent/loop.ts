import type { ContentPart, FinishReason, Message, Provider, ToolSpec } from '../providers/types.js'
import type { ToolContext, ToolRegistry } from '../tools/index.js'
import {
  summarizeToolCall,
  type PermissionAsker,
  type PermissionPolicy,
} from '../tools/permission.js'
import type { AgentEvent } from './events.js'

export interface ToolPermission {
  policy: PermissionPolicy
  ask?: PermissionAsker
}

export interface RunAgentOptions {
  provider: Provider
  model: string
  system?: string
  tools: ToolSpec[]
  registry: ToolRegistry
  messages: Message[]
  context: ToolContext
  maxSteps?: number
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
  permission?: ToolPermission
}

const DEFAULT_MAX_STEPS = 25

/**
 * The agent loop. Appends to `options.messages` in place so the caller's
 * conversation history stays in sync. Yields normalized events as they happen.
 */
export async function* runAgent(options: RunAgentOptions): AsyncGenerator<AgentEvent> {
  const { provider, registry, messages, context } = options
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS

  for (let step = 0; step < maxSteps; step += 1) {
    const parts: ContentPart[] = []
    const toolCalls: { id: string; name: string; args: unknown }[] = []
    let text = ''
    let reasoning = ''
    let finish: FinishReason = 'stop'

    for await (const event of provider.stream({
      model: options.model,
      messages,
      system: options.system,
      tools: options.tools.length > 0 ? options.tools : undefined,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      signal: options.signal,
    })) {
      if (event.type === 'text') {
        text += event.delta
        yield { type: 'text-delta', delta: event.delta }
      } else if (event.type === 'reasoning') {
        reasoning += event.delta
        yield { type: 'reasoning-delta', delta: event.delta }
      } else if (event.type === 'tool-call') {
        toolCalls.push({ id: event.id, name: event.name, args: event.args })
      } else if (event.type === 'usage') {
        yield event
      } else if (event.type === 'done') {
        finish = event.finishReason
      }
    }

    // The thought comes first because that is how it arrived; it stays in the
    // transcript for whoever reads it, and no wire sends it back.
    if (reasoning) parts.push({ type: 'reasoning', text: reasoning })
    if (text) parts.push({ type: 'text', text })
    for (const call of toolCalls) {
      parts.push({ type: 'tool-call', id: call.id, name: call.name, args: call.args })
    }
    messages.push({ role: 'assistant', content: parts.length > 0 ? parts : [{ type: 'text', text: '' }] })

    if (toolCalls.length === 0) {
      yield { type: 'done', finishReason: finish }
      return
    }

    for (const call of toolCalls) {
      yield { type: 'tool-start', id: call.id, name: call.name, args: call.args }
      const blocked = await checkPermission(options.permission, registry, call.name, call.args)
      const result = blocked
        ? { content: blocked, isError: true }
        : await registry.execute(call.name, call.args, context)
      yield {
        type: 'tool-end',
        id: call.id,
        name: call.name,
        result: result.content,
        isError: Boolean(result.isError),
      }
      messages.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            id: call.id,
            name: call.name,
            content: result.content,
            isError: result.isError,
          },
        ],
      })
    }
  }

  yield { type: 'error', message: `Stopped after ${maxSteps} steps without a final answer.` }
}

/** Returns a block reason when the call must not run, or null when it may. */
async function checkPermission(
  permission: ToolPermission | undefined,
  registry: ToolRegistry,
  name: string,
  args: unknown,
): Promise<string | null> {
  if (!permission) return null
  const tool = registry.get(name)
  if (!tool) return null

  const decision = await permission.policy.decide(tool, args)
  if (decision === 'allow') return null
  if (decision === 'deny') return `Tool "${name}" is denied by the permission policy.`

  if (!permission.ask) {
    return `Tool "${name}" requires confirmation, but this surface cannot ask the user.`
  }
  const { allowed } = await permission.ask({
    tool: name,
    args,
    summary: summarizeToolCall(args),
  })
  return allowed ? null : `The user denied running "${name}".`
}
