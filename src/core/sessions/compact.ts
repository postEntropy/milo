import type { Message, Provider, ReasoningEffort, ToolResultPart } from '../providers/types.js'
import { errorMessage } from '../../util/errors.js'
import { logDebug, logWarn } from '../../util/log.js'
import { IMAGE_TOKENS } from '../images.js'

/** Rough token estimate. Cheap on purpose: no tokenizer, ~4 chars per token. */
export function estimateTokens(messages: Message[]): number {
  let chars = 0
  let images = 0
  for (const message of messages) {
    for (const part of message.content) {
      switch (part.type) {
        case 'text':
          chars += part.text.length
          break
        case 'tool-result':
          chars += part.content.length
          images += part.images?.length ?? 0
          break
        case 'tool-call':
          chars += part.name.length + safeJson(part.args).length
          break
        case 'reasoning':
          // Kept in the transcript and normally never sent, so it costs nothing —
          // except a signed Anthropic thought, which the wire requires echoed and
          // which therefore rides every later request.
          if (part.signature) chars += part.text.length
          break
        case 'file':
          // A delivered file is on disk, not in the request: the wires skip the
          // part, so it is not charged to the transcript it sits in.
          break
      }
    }
  }
  // Pictures are priced by the pixel, not by their base64 length, and they are
  // the one part of a transcript that can be megabytes without any text in it.
  return Math.ceil(chars / 4) + images * IMAGE_TOKENS
}

/** The same rough estimate for a plain string — a system prompt, say. */
export function estimateText(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Where to cut so the last `keepTurns` user turns survive.
 *
 * The cut always lands on a `user` message. That is what guarantees a tool call
 * is never separated from its result: the loop pushes the assistant's
 * `tool-call` and the matching `tool` result between two user messages.
 * Returns 0 when there is nothing safe to drop.
 */
export function planCut(messages: Message[], keepTurns: number): number {
  if (keepTurns <= 0) return 0
  const userIndexes: number[] = []
  messages.forEach((message, index) => {
    if (message.role === 'user') userIndexes.push(index)
  })
  if (userIndexes.length <= keepTurns) return 0
  return userIndexes[userIndexes.length - keepTurns]!
}

/**
 * Slices a message history to keep only the first `upToTurn` user turns (1-indexed).
 * Each turn begins on a message where `role === 'user'`.
 * If `upToTurn` is undefined or exceeds total turns, returns a shallow copy of `messages`.
 * If `upToTurn <= 0`, returns an empty array.
 */
export function sliceMessagesUpToTurn(messages: Message[], upToTurn?: number): Message[] {
  if (upToTurn === undefined) return messages.slice()
  if (upToTurn <= 0) return []
  const userIndexes: number[] = []
  messages.forEach((msg, idx) => {
    if (msg.role === 'user') userIndexes.push(idx)
  })
  if (upToTurn < userIndexes.length) {
    const cutIdx = userIndexes[upToTurn]!
    return messages.slice(0, cutIdx)
  }
  return messages.slice()
}

/**
 * Where to cut so the transcript that survives fits `budget`, past the floor.
 *
 * `keepTurns` is where the cut prefers to land, and where it lands whenever those
 * turns fit. When they do not — one long turn, or a big tool result inside one —
 * the cut moves back before the floor, a user turn at a time, until what is left
 * fits, keeping as many of them as it can. The most recent user turn is never
 * folded: it is the question being answered, and a request that has lost its own
 * question is not one worth sending.
 *
 * `fixed` is the cost of everything that is not the transcript — the system
 * prompt, the summary, the tool list. Returns 0 when even that last turn plus
 * `fixed` is over `budget`, the one case a summary cannot change: folding cannot
 * make the request smaller than the turn it keeps, so the caller does not buy one.
 */
export function planCutUnderBudget(
  messages: Message[],
  options: { keepTurns: number; budget: number; fixed: number },
): number {
  const userIndexes: number[] = []
  messages.forEach((message, index) => {
    if (message.role === 'user') userIndexes.push(index)
  })
  if (userIndexes.length === 0) return 0

  const room = options.budget - options.fixed
  const floor = Math.min(Math.max(options.keepTurns, 1), userIndexes.length)
  for (let keep = floor; keep >= 1; keep -= 1) {
    const cut = userIndexes[userIndexes.length - keep]!
    if (estimateTokens(messages.slice(cut)) <= room) return cut
  }
  return 0
}

/**
 * How many pictures stay in the transcript. Each one is ~1500 tokens and rides
 * every later request until it is dropped, so a long session of them would
 * otherwise carry every picture to the end — which is exactly the prefill that
 * makes a loop like that slow.
 */
export const KEEP_IMAGES_IN_CONTEXT = 4

/**
 * Forgets the pictures in tool results older than the last `keep`. The tool
 * result keeps saying what happened; only the picture goes, replaced by a line
 * saying it was dropped — a transcript that silently lost a screenshot would
 * read as a tool that returned nothing.
 *
 * Idempotent: the images are removed, so a second pass finds nothing to drop and
 * appends nothing.
 */
export function dropOldImages(messages: Message[], keep = KEEP_IMAGES_IN_CONTEXT): void {
  let seen = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message) continue
    for (const part of message.content) {
      if (part.type !== 'tool-result' || !part.images?.length) continue
      seen += part.images.length
      if (seen <= keep) continue
      delete part.images
      part.content = `${part.content}\n[screenshot dropped to keep the request small]`
    }
  }
}

/**
 * How many page snapshots stay in the transcript, verbatim. A snapshot is the
 * page as a list of elements — a few hundred to a few thousand tokens of it —
 * and a browser task looks at the page after every action. Kept, they would ride
 * every later request of the turn: ten clicks, one page's worth of prefill ten
 * times over. That is the dominant cost of the whole feature.
 */
export const KEEP_SNAPSHOTS_IN_CONTEXT = 2

/**
 * Only a result this long is worth trimming. A tool result that is a line —
 * "clicked r7", or an action taken without looking afterwards — says everything
 * it has to say in the line, and rewriting it would lose information to save
 * nothing.
 */
const SNAPSHOT_CHARS = 500

/**
 * Forgets the body of page snapshots older than the last `keep`, keeping the
 * line that says what happened and where. The transcript stops carrying ten
 * copies of the same page's element list while still reading as a sequence of
 * actions someone could follow.
 *
 * Idempotent, in the same way as `dropOldImages`: the first line is still the
 * first line, so a second pass writes what the first one wrote.
 */
export function dropOldSnapshots(messages: Message[], keep = KEEP_SNAPSHOTS_IN_CONTEXT): void {
  if (keep < 0) return
  const snapshots: ToolResultPart[] = []
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type !== 'tool-result' || !isSnapshot(part.name)) continue
      if (part.content.length <= SNAPSHOT_CHARS) continue
      snapshots.push(part)
    }
  }
  for (const part of snapshots.slice(0, Math.max(0, snapshots.length - keep))) {
    const headline = part.content.split('\n', 1)[0] ?? ''
    part.content = `${headline}\n[page snapshot dropped to keep the request small — take a fresh look if you need it]`
  }
}

/** The tools that answer with the page as it is, and whose answers are big. */
function isSnapshot(name: string): boolean {
  return name === 'browser_open' || name === 'browser_snapshot' || name === 'browser_act'
}

export interface SummarizeOptions {
  provider: Provider
  model: string
  /** Overrides the compaction prompt, for a caller that wants another shape. */
  system?: string
  /** Summary of the turns dropped before these, to fold in. */
  previous?: string
  dropped: Message[]
  signal?: AbortSignal
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 20_000

const SUMMARY_SYSTEM = `You compress a conversation so it can continue with less context.
Write a dense summary of the transcript the user provides:
- facts, decisions and preferences that matter later;
- what was asked and what was concluded;
- any open threads or unfinished work.
Keep names, paths, commands and numbers exact. Write plain prose or short bullets,
in the language of the conversation. No preamble.`

/**
 * One model call that turns the dropped turns into a summary. Returns `null` on
 * any failure (or timeout), so the caller can fall back to dropping them plain.
 *
 * Summarizing is mechanical, and a reasoning model asked in its own default
 * voice will think about it: that thinking is seconds added to a turn, whose
 * result nobody ever reads. So the call asks for a low effort — and, because the
 * field is one the provider may not know, asks again without it if that is what
 * failed. Losing every summary to an unknown field is not worth the saving.
 */
export async function summarize(options: SummarizeOptions): Promise<string | null> {
  const transcript = renderTranscript(options.dropped)
  if (!transcript.trim()) return null

  const request = {
    provider: options.provider,
    model: options.model,
    system: options.system ?? SUMMARY_SYSTEM,
    messages: [
      {
        role: 'user' as const,
        content: [{ type: 'text' as const, text: promptFor(options.previous, transcript) }],
      },
    ],
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    signal: options.signal,
  }

  const asked = await call({ ...request, reasoningEffort: 'low' })
  if (asked.ok) return asked.text || null

  // A cut-off call is not the provider refusing the field: the attempt was ended
  // by its own budget, or because the turn asking for the summary was stopped.
  // Asking again is cut off the same way — and after a stop the listener is spent,
  // so the second call would not even be cancelled — which is why the retry is
  // only for a failure that says something about the request.
  if (asked.aborted) {
    if (asked.aborted === 'stopped') logDebug('summary was stopped with the turn')
    else
      logWarn(
        `summary took longer than ${request.timeoutMs}ms and was cut off, dropping the turns plain`,
      )
    return null
  }

  logWarn(`summary failed with the effort hint, asking again without it: ${asked.error}`)

  const plain = await call(request)
  if (plain.ok) return plain.text || null
  logWarn(`summary failed, dropping the turns plain: ${plain.error}`)
  return null
}

interface CallOptions {
  provider: Provider
  model: string
  system: string
  messages: Message[]
  reasoningEffort?: ReasoningEffort
  timeoutMs: number
  signal?: AbortSignal
}

/**
 * One attempt. `aborted` says the attempt was cut off rather than answered or
 * refused — by its own budget (`timeout`), or because the turn it belongs to was
 * stopped (`stopped`) — and neither is a fact about the request worth a retry.
 */
async function call(
  options: CallOptions,
): Promise<
  { ok: true; text: string } | { ok: false; aborted: 'timeout' | 'stopped' | null; error: string }
> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  const timer = setTimeout(abort, options.timeoutMs)
  options.signal?.addEventListener('abort', abort, { once: true })

  let text = ''
  try {
    for await (const event of options.provider.stream({
      model: options.model,
      system: options.system,
      messages: options.messages,
      reasoningEffort: options.reasoningEffort,
      signal: controller.signal,
    })) {
      if (event.type === 'text') text += event.delta
    }
    return { ok: true, text }
  } catch (error) {
    const aborted = !controller.signal.aborted
      ? null
      : options.signal?.aborted
        ? 'stopped'
        : 'timeout'
    return { ok: false, aborted, error: errorMessage(error) }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
  }
}

const DIGEST_SYSTEM = `You write a short recap of a conversation so it can be found again later.
Answer with 3 to 5 terse bullet points covering:
- what the conversation was about;
- the decisions, preferences or conventions it settled;
- the paths, commands, names and numbers that came up;
- anything left open.
Write in the language of the conversation, in the third person. Bullets only, no preamble.`

/**
 * A recap summarizes a whole session, so it gets at least the budget a
 * compaction summary of a few turns gets. It used to get less, which is
 * backwards: nobody waits on a recap — it is written when a session is switched
 * away from — and the transcript handed to it is the largest of any of these
 * calls, so it was the one being cut off.
 */
const DEFAULT_DIGEST_TIMEOUT_MS = 20_000

export interface DigestOptions {
  provider: Provider
  model: string
  messages: Message[]
  /** The turns compaction already folded away, when there are any. */
  summary?: string
  signal?: AbortSignal
  timeoutMs?: number
}

/**
 * A short recap of a whole session, for the `/sessions` list and for finding it
 * again. The same model call as compaction, with a prompt that asks for bullets
 * instead of prose — null on any failure, so the caller can skip it quietly.
 */
export async function digest(options: DigestOptions): Promise<string | null> {
  return summarize({
    provider: options.provider,
    model: options.model,
    system: DIGEST_SYSTEM,
    previous: options.summary,
    dropped: options.messages,
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? DEFAULT_DIGEST_TIMEOUT_MS,
  })
}

function promptFor(previous: string | undefined, transcript: string): string {
  const parts: string[] = []
  if (previous?.trim()) {
    parts.push(`Summary so far:\n${previous.trim()}`)
  }
  parts.push(`New turns to fold in:\n\n${transcript}`)
  parts.push('Write the updated summary.')
  return parts.join('\n\n')
}

function renderTranscript(messages: Message[]): string {
  const lines: string[] = []
  for (const message of messages) {
    const text = message.content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
      .trim()
    if (text) {
      const speaker = message.role === 'user' ? 'User' : message.role === 'assistant' ? 'Assistant' : message.role
      lines.push(`${speaker}: ${text}`)
    }
    for (const part of message.content) {
      if (part.type === 'tool-call') {
        lines.push(`Tool call: ${part.name}(${safeJson(part.args)})`)
      } else if (part.type === 'tool-result') {
        const pictures = part.images?.length ? ` [+${part.images.length} screenshot]` : ''
        lines.push(`Tool result (${part.name}): ${truncate(part.content, 600)}${pictures}`)
      }
    }
  }
  return lines.join('\n')
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

function safeJson(value: unknown): string {
  if (value === undefined) return ''
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return String(value)
  }
}
