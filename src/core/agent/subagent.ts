import { closeParagraph } from '../../util/format.js'
import type { Message, Provider, ReasoningEffort } from '../providers/types.js'
import type { SkillSummary } from '../skills/index.js'
import type { ProjectInstructions } from './instructions.js'
import type { RunTrace } from './loop.js'
import type { ToolContext, ToolRegistry, ToolResult } from '../tools/index.js'
import type { BrowserFacts } from '../browser/index.js'
import type { GoogleState } from '../google/state.js'
import type { McpFacts } from '../mcp/servers.js'
import { runAgent, type ToolPermission } from './loop.js'
import { buildSystemPrompt, SUBAGENT_SYSTEM_PROMPT } from './system.js'

export interface SubagentRun {
  provider: Provider
  model: string
  registry: ToolRegistry
  cwd: string
  skills?: SkillSummary[]
  /**
   * The rules of the parent turn's project, already resolved: a subagent works in the
   * same folder, so it keeps the same conventions the parent does. Absent when the
   * turn has no project, or the project carries no instructions.
   */
  instructions?: ProjectInstructions
  /**
   * The live state the setup section carries. A subagent is handed the parent's
   * whole catalog, so the browser, the external servers and the Google grant are
   * tools it can call — and it must be able to read their state the same way the
   * parent does, or "the catalog is the state" leaves it guessing.
   */
  browser?: BrowserFacts | null
  mcp?: McpFacts | null
  google?: GoogleState | null
  signal: AbortSignal
  /**
   * A step of the subtask that may have changed something — a file written, a command
   * run. A subagent works in the folder the parent turn works in, so what it changes is
   * the same folder a watching surface re-reads: without this, a delegated write would
   * leave the screen showing what was there before it.
   */
  onSideEffect?: () => void
  /** The parent turn's policy and prompt, so the subagent's actions ask the same way. */
  permission?: ToolPermission
  maxSteps?: number
  maxTokens?: number
  temperature?: number
  reasoningEffort?: ReasoningEffort
  /** The subtask, exactly as the `task` tool received it. */
  input: { description: string; prompt: string }
  /** The parent's memory, recall, address and delivery, so the subagent's tools still work. */
  context: Pick<ToolContext, 'remember' | 'memories' | 'recall' | 'origin' | 'routine' | 'sendFile'>
  /** Carried through from the parent turn, so the subtask's requests are logged too. */
  trace?: RunTrace
}

/**
 * Runs one delegated subtask to completion and hands back only its report.
 *
 * The isolation is the point: the subagent gets a fresh transcript holding just
 * the instruction, so the tool calls it makes on the way — every read, every
 * search — never enter the parent's context. Only the final text does, which is
 * what keeps a long investigation from crowding out the conversation around it.
 */
export async function runSubagent(options: SubagentRun): Promise<ToolResult> {
  // Everything the parent has, except `task` itself: a subagent cannot delegate
  // again, so delegation stays one level deep instead of a chain that nothing
  // but maxSteps would stop. And except `todo`: the plan exists to be watched by
  // a person, and a subagent has no surface to draw it on. And except `sessions`:
  // pruning the install's conversations is the main turn's act, and the subagent's
  // context carries no session to manage or refuse against.
  const tools = options.registry.specs().filter((tool) => tool.name !== 'task' && tool.name !== 'todo' && tool.name !== 'sessions')
  const system = buildSystemPrompt({
    base: SUBAGENT_SYSTEM_PROMPT,
    cwd: options.cwd,
    provider: options.provider.id,
    model: options.model,
    tools,
    skills: options.skills,
    instructions: options.instructions,
    browser: options.browser ?? null,
    mcp: options.mcp ?? null,
    google: options.google ?? null,
    memories: [],
  })
  const messages: Message[] = [
    { role: 'user', content: [{ type: 'text', text: options.input.prompt }] },
  ]
  const context: ToolContext = {
    cwd: options.cwd,
    signal: options.signal,
    remember: options.context.remember,
    memories: options.context.memories,
    recall: options.context.recall,
    origin: options.context.origin,
    routine: options.context.routine,
    sendFile: options.context.sendFile,
  }

  let text = ''
  let failure: string | null = null
  for await (const event of runAgent({
    provider: options.provider,
    model: options.model,
    system,
    tools,
    registry: options.registry,
    messages,
    context,
    maxSteps: options.maxSteps,
    maxTokens: options.maxTokens,
    temperature: options.temperature,
    reasoningEffort: options.reasoningEffort,
    signal: options.signal,
    permission: options.permission,
    onSideEffect: options.onSideEffect,
    trace: options.trace,
  })) {
    if (event.type === 'text-delta') text += event.delta
    else if (event.type === 'tool-start') {
      text = closeParagraph(text)
    }
    // A subagent has no surface to report to, so a failure has to come back as
    // the result: the parent is the only one who can say it went wrong.
    else if (event.type === 'error') failure = event.message
  }

  const report = text.trim()
  if (report) return { content: report }
  return {
    content: failure
      ? `The subagent could not finish: ${failure}`
      : 'The subagent finished without a report.',
    isError: true,
  }
}
