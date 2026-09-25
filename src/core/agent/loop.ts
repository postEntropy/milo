import { saveImage } from '../images.js'
import { dropOldSnapshots } from '../sessions/compact.js'
import type {
  ContentPart,
  FinishReason,
  ImageRef,
  Message,
  Provider,
  ReasoningEffort,
  ToolSpec,
} from '../providers/types.js'
import type { ToolContext, ToolImage, ToolRegistry } from '../tools/index.js'
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
  reasoningEffort?: ReasoningEffort
  signal?: AbortSignal
  permission?: ToolPermission
  /**
   * Messages handed in while this turn is already running. Taken up as user
   * turns at a step boundary — the one point where the transcript is not
   * between a tool call and its result — so a correction reaches the model
   * without a second turn racing the first over the same transcript.
   *
   * The array belongs to the caller, which is what makes it safe to empty: the
   * turn drains it in place, and whatever is still in it when the turn ends was
   * never seen and can be run as its own turn.
   */
  steering?: string[]
  /**
   * How many page snapshots a request may still carry. Compaction runs between
   * turns, but a turn makes up to `maxSteps` requests, and a browser task looks
   * at the page after every action — so without this the transcript grows a
   * snapshot per step and every request after the first pays for all of them.
   */
  keepSnapshots?: number
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
    // A message sent while this turn was running joins it here, at the one point
    // where the transcript is not halfway through a tool call.
    for (const steer of take(options.steering)) {
      messages.push({ role: 'user', content: [{ type: 'text', text: steer }] })
      yield { type: 'steer', text: steer }
    }

    const parts: ContentPart[] = []
    const toolCalls: { id: string; name: string; args: unknown }[] = []
    let text = ''
    let reasoning = ''
    let finish: FinishReason = 'stop'

    // Before every request, not once a turn: what makes a page snapshot expensive
    // is that it is sent again on every step that follows it.
    dropOldSnapshots(messages, options.keepSnapshots)

    for await (const event of provider.stream({
      model: options.model,
      messages,
      system: options.system,
      tools: options.tools.length > 0 ? options.tools : undefined,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      reasoningEffort: options.reasoningEffort,
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

    // No tool calls and nothing new to answer means the turn is over. A
    // correction that landed while this step was streaming keeps it going
    // instead: it is picked up at the top of the next step.
    if (toolCalls.length === 0 && (options.steering?.length ?? 0) === 0) {
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
      const images = await persistImages(result.images)
      messages.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            id: call.id,
            name: call.name,
            content: result.content,
            isError: result.isError,
            ...(images.length > 0 ? { images } : {}),
          },
        ],
      })
    }
  }

  yield { type: 'error', message: `Stopped after ${maxSteps} steps without a final answer.` }
}

/** Empties the queue and hands back what was in it. */
function take(queue: string[] | undefined): string[] {
  return queue ? queue.splice(0, queue.length) : []
}

/**
 * Puts the pictures a tool returned on disk and hands back references to them.
 * A picture that cannot be written is dropped rather than referenced: a
 * reference that resolves to nothing would be a result claiming to show
 * something it does not have.
 */
async function persistImages(images: ToolImage[] | undefined): Promise<ImageRef[]> {
  if (!images || images.length === 0) return []
  const saved: ImageRef[] = []
  for (const image of images) {
    const ref = await saveImage(image)
    if (ref) saved.push(ref)
  }
  return saved
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
