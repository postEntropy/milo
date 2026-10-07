import { errorMessage } from '../../util/errors.js'
import { logDebug, logWarn } from '../../util/log.js'
import type { Message, Provider } from '../providers/types.js'

/**
 * How long one extraction may take before it is dropped.
 *
 * Nobody is waiting on this call — it runs once the turn has answered, and only
 * `settle()` at exit waits for it — so the budget is the one the compaction
 * summary gets rather than a tight one. Measured against the real provider, a
 * turn whose question and answer run to tens of thousands of tokens reads back
 * in around nine seconds, and the 8s this used to be killed those extractions
 * every time.
 */
const DEFAULT_DERIVE_TIMEOUT_MS = 20_000

/** Facts kept from one exchange. More than this is a summary, not a memory. */
const MAX_FACTS = 5

const DERIVE_SYSTEM = `You read one exchange and write down what is worth remembering about the person, for a memory that is later recalled by keyword match.

Answer with one fact per line — no numbering, no preamble. Each line is a short standalone sentence, in the language of the exchange, written the way the person would say it about themselves.

Keep only what lasts beyond this exchange and is about the person or their setup: a preference, a convention, a decision, a name, a path, a value, a date.

Leave out: anything already in a file or a repository, anything true only of this one question, anything the assistant said about itself, and anything it merely proposed. If nothing is worth keeping, answer with exactly NONE.`

export interface DeriveOptions {
  provider: Provider
  model: string
  /** The exchange to read — the question and the answer. */
  messages: Message[]
  signal?: AbortSignal
  timeoutMs?: number
}

/**
 * The durable facts of one exchange, as a model reads them: [] when there are
 * none, and [] on any failure.
 *
 * This is the half of a memory service that a store cannot do for itself. What
 * gets kept is a clean sentence about the person rather than the raw turn, so
 * recall matches the fact instead of whatever words the turn happened to use —
 * and a turn that was all questions, code and tool output leaves nothing behind.
 */
export async function deriveFacts(options: DeriveOptions): Promise<string[]> {
  const text = await ask(options)
  if (text === null) return []

  return text
    .split('\n')
    .map((line) => line.replace(/^\s*[-*•]\s*/, '').trim())
    .filter((line) => line.length > 0 && !/^none[.!]?$/i.test(line))
    .slice(0, MAX_FACTS)
}

/**
 * Two attempts, the same way compaction does it: asking for `low` effort keeps
 * an extraction cheap, and a provider that rejects the field still gets asked
 * once without it rather than silently never extracting anything.
 */
async function ask(options: DeriveOptions): Promise<string | null> {
  const hinted = await stream(options, 'low')
  if (hinted.ok) return hinted.text

  // A cut-off call is not the provider refusing the field: the attempt was ended
  // by its own budget, or because the turn was stopped. Asking again would be cut
  // off the same way — and after a stop the listener is spent, so the second call
  // would not even be cancelled — which is why the retry is only for a failure
  // that says something about the request.
  if (hinted.aborted) {
    if (hinted.aborted === 'stopped') logDebug('fact extraction was stopped with the turn')
    else
      logWarn(
        `fact extraction took longer than ${options.timeoutMs ?? DEFAULT_DERIVE_TIMEOUT_MS}ms and was cut off, keeping nothing from this turn`,
      )
    return null
  }

  logWarn(`fact extraction failed with the effort hint, asking again without it: ${hinted.error}`)

  const plain = await stream(options, undefined)
  if (plain.ok) return plain.text
  logWarn(`fact extraction failed, keeping nothing from this turn: ${plain.error}`)
  return null
}

/**
 * One attempt. `aborted` says the attempt was cut off rather than answered or
 * refused — by its own budget (`timeout`), or because the turn it belongs to was
 * stopped (`stopped`) — and neither is a fact about the request worth a retry.
 */
async function stream(
  options: DeriveOptions,
  reasoningEffort: 'low' | undefined,
): Promise<{ ok: true; text: string } | { ok: false; aborted: 'timeout' | 'stopped' | null; error: string }> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  const timer = setTimeout(abort, options.timeoutMs ?? DEFAULT_DERIVE_TIMEOUT_MS)
  options.signal?.addEventListener('abort', abort, { once: true })

  let text = ''
  try {
    for await (const event of options.provider.stream({
      model: options.model,
      system: DERIVE_SYSTEM,
      messages: options.messages,
      ...(reasoningEffort ? { reasoningEffort } : {}),
      signal: controller.signal,
      trace: { purpose: 'derive' },
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
