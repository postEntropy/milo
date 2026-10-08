import { saveImage } from '../images.js'
import { thinkingBudgetFor } from '../providers/thinking.js'
import { dropOldSnapshots } from '../sessions/compact.js'
import type {
  ContentPart,
  FinishReason,
  ImageRef,
  Message,
  Provider,
  ReasoningEffort,
  ToolSpec,
  TraceTag,
} from '../providers/types.js'
import type { TraceWriter } from '../traces.js'
import type { ToolContext, ToolImage, ToolRegistry, ToolResult } from '../tools/index.js'
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

/**
 * What a run tells the execution log: where to write, and what the run is.
 * Threaded from the session (the chat turn) into any subtask it delegates.
 */
export interface RunTrace {
  traces: TraceWriter
  purpose?: string
  surface?: string
  session?: string
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
  /**
   * Where the execution log is written and what this run is. Every model request
   * is timed by the provider wrapper, which reads the tag this run puts on it;
   * the tool calls are timed here, where a call begins and ends. Absent means
   * nothing is logged and no tag is set.
   */
  trace?: RunTrace
}

const DEFAULT_MAX_STEPS = 75

/**
 * What the model is told when the steps run out.
 *
 * A ceiling that ends in an error and nothing to read throws the turn away: the
 * transcript is already full of what was found. One last request — with the tools
 * taken away, so there is nothing left to call — turns the cliff into a report,
 * which is the difference between reading what Milo got and reading that Milo
 * stopped. Digging itself is untouched: the ceiling is still the ceiling, and
 * only what happens at it changes.
 */
const OUT_OF_STEPS = [
  'You have run out of steps for this turn.',
  'Answer now, in the language of the conversation, with what you have:',
  'what you found, what you could not get to, and what you would try next.',
  'This is the last request of the turn — do not call tools.',
].join(' ')

/**
 * The agent loop. Appends to `options.messages` in place so the caller's
 * conversation history stays in sync. Yields normalized events as they happen.
 */
export async function* runAgent(options: RunAgentOptions): AsyncGenerator<AgentEvent> {
  const { provider, registry, messages, context } = options
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS
  // Stamped on every request this run makes, so the provider wrapper's line names
  // the purpose and the surface instead of guessing at them.
  const tag: TraceTag | undefined = options.trace
    ? {
        purpose: options.trace.purpose ?? 'chat',
        ...(options.trace.surface ? { surface: options.trace.surface } : {}),
        ...(options.trace.session ? { session: options.trace.session } : {}),
      }
    : undefined

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
    let signature = ''
    let finish: FinishReason = 'stop'

    // Before every request, not once a turn: what makes a page snapshot expensive
    // is that it is sent again on every step that follows it.
    dropOldSnapshots(messages, options.keepSnapshots)

    try {
      for await (const event of provider.stream({
        model: options.model,
        messages,
        system: options.system,
        tools: options.tools.length > 0 ? options.tools : undefined,
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        reasoningEffort: options.reasoningEffort,
        // Read off the effort, so the two wires mean the same thing by it: OpenAI
        // takes the level, Anthropic takes a token budget. Absent effort means
        // neither asks to think.
        thinkingBudget: options.reasoningEffort ? thinkingBudgetFor(options.reasoningEffort) : undefined,
        signal: options.signal,
        ...(tag ? { trace: tag } : {}),
      })) {
        if (event.type === 'text') {
          text += event.delta
          yield { type: 'text-delta', delta: event.delta }
        } else if (event.type === 'reasoning') {
          reasoning += event.delta
          yield { type: 'reasoning-delta', delta: event.delta }
        } else if (event.type === 'reasoning-signature') {
          signature = event.signature
        } else if (event.type === 'tool-call') {
          toolCalls.push({ id: event.id, name: event.name, args: event.args })
        } else if (event.type === 'usage') {
          yield event
        } else if (event.type === 'done') {
          finish = event.finishReason
        }
      }
    } catch (error) {
      // The stream died after the surface had already drawn part of it. What was
      // shown goes into the transcript before the failure is reported: the next
      // request must not be missing words the person has just read. A tool call
      // that half-arrived is left out — a call without its result is a request the
      // Anthropic wire refuses — and the turn ends in the error either way.
      const shown: ContentPart[] = []
      if (reasoning) {
        shown.push({ type: 'reasoning', text: reasoning, ...(signature ? { signature } : {}) })
      }
      if (text) shown.push({ type: 'text', text })
      if (shown.length > 0) messages.push({ role: 'assistant', content: shown })
      throw error
    }

    // The thought comes first because that is how it arrived; it stays in the
    // transcript for whoever reads it. The Anthropic wire signs it and requires
    // it echoed on the next request, so the signature rides along when there is
    // one; without it the part is dropped on the way out, as before.
    if (reasoning) {
      parts.push({ type: 'reasoning', text: reasoning, ...(signature ? { signature } : {}) })
    }
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

    for (let index = 0; index < toolCalls.length; ) {
      // A run of calls that hold no shared state is started together, then read
      // back in the order the model made them: the events stay exactly as a
      // serial run's would — a start and its end for each call, in order — so
      // every surface draws the same thing, while the wall time is the longest
      // call rather than the sum of all of them. Anything else runs one at a
      // time, which is what keeps an interactive confirmation from racing itself
      // and two calls into one browser session from interleaving.
      const run = toolCalls.slice(index, concurrentRunEnd(toolCalls, registry, index))
      index += run.length
      // A run that overlaps starts all its calls here, so the span is measured
      // from this line rather than from where each result is read back.
      const runStarted = Date.now()
      const pending =
        run.length > 1 ? run.map((call) => executeCall(options.permission, registry, call, context)) : null

      for (let at = 0; at < run.length; at += 1) {
        const call = run[at]
        const startedAt = pending ? runStarted : Date.now()
        yield { type: 'tool-start', id: call.id, name: call.name, args: call.args }
        const result = pending ? await pending[at] : await executeCall(options.permission, registry, call, context)
        yield {
          type: 'tool-end',
          id: call.id,
          name: call.name,
          result: result.content,
          isError: Boolean(result.isError),
        }
        options.trace?.traces.record({
          at: new Date().toISOString(),
          event: 'tool.call',
          ok: !result.isError,
          ms: Date.now() - startedAt,
          purpose: tag?.purpose ?? 'chat',
          tool: call.name,
          ...(tag?.surface ? { surface: tag.surface } : {}),
          ...(tag?.session ? { session: tag.session } : {}),
        })
        // The plan is drawn by the surfaces and nothing the model needs told
        // back, so it rides as its own event rather than into the transcript.
        if (result.todos) yield { type: 'todo', items: result.todos }
        // The panel is the same shape of display state: the web gateway resolves
        // the request into a view, and none of it goes back to the model.
        if (result.panel) yield { type: 'panel', request: result.panel }
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
  }

  // Out of steps with the tools still in hand. The instruction rides on the
  // system prompt rather than on a user message, so the transcript is not left
  // carrying a sentence nobody said.
  let closing = ''
  for await (const event of provider.stream({
    model: options.model,
    messages,
    system: options.system ? `${options.system}\n\n${OUT_OF_STEPS}` : OUT_OF_STEPS,
    tools: undefined,
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    reasoningEffort: options.reasoningEffort,
    thinkingBudget: options.reasoningEffort ? thinkingBudgetFor(options.reasoningEffort) : undefined,
    signal: options.signal,
    ...(tag ? { trace: tag } : {}),
  })) {
    if (event.type === 'text') {
      closing += event.delta
      yield { type: 'text-delta', delta: event.delta }
    } else if (event.type === 'reasoning') {
      yield { type: 'reasoning-delta', delta: event.delta }
    }
  }
  if (closing) messages.push({ role: 'assistant', content: [{ type: 'text', text: closing }] })

  yield {
    type: 'error',
    message: closing
      ? `Stopped after ${maxSteps} steps — it answered with what it had.`
      : `Stopped after ${maxSteps} steps without a final answer.`,
  }
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

/** Runs one call: the permission decision first, then the tool if it is allowed. */
async function executeCall(
  permission: ToolPermission | undefined,
  registry: ToolRegistry,
  call: { id: string; name: string; args: unknown },
  context: ToolContext,
): Promise<ToolResult> {
  const blocked = await checkPermission(permission, registry, call.name, call.args)
  return blocked ? { content: blocked, isError: true } : registry.execute(call.name, call.args, context)
}

/**
 * How far a run of calls that may overlap reaches from `start`.
 *
 * A tool opts in (`readOnly` *and* `concurrent`), so a tool that reads but holds
 * shared state — the browser's own session — stays serial, as does anything
 * with a side effect. A run of one is the ordinary serial case.
 */
function concurrentRunEnd(
  toolCalls: { name: string }[],
  registry: ToolRegistry,
  start: number,
): number {
  if (!canOverlap(registry, toolCalls[start].name)) return start + 1
  let end = start + 1
  while (end < toolCalls.length && canOverlap(registry, toolCalls[end].name)) end += 1
  return end
}

function canOverlap(registry: ToolRegistry, name: string): boolean {
  const tool = registry.get(name)
  return Boolean(tool?.readOnly && tool.concurrent)
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
