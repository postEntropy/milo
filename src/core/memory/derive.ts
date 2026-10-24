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

Answer with one fact per line — no numbering, no preamble. Each line is the fact, a TAB, then the exact words from the person's message that say it: \`usa o Neovim\tmeu editor e o Neovim\`.

A fact exists only because the person's own message says it. The assistant's answer is context for reading that message, never a source: a claim that appears only in the answer is not a fact about the person. A line whose second half is not a verbatim fragment of the person's message is discarded, so do not write it.

Each fact is a short standalone sentence, in the language of the exchange, written the way the person would say it about themselves.

Keep only a durable fact about the person or their setup: a preference, a convention, a decision, a name, a path, or how something of theirs works for good. It has to still be true next month, and it has to be about them.

Leave out, always:
- anything the assistant said, offered, asked or proposed — the fact is about the person, never about you;
- a question of any kind;
- a want, a plan or a proposal about the work at hand ("I want…", "let's…", "we could…") — it is not a fact yet;
- trivia with no lasting use ("I have Steam installed", "I use a terminal");
- a measurement, a version, a count or any number read off this run — it changes; keep the durable thing it was about, never the reading of the day;
- anything already in a file, a repository or a document;
- anything true only of this one question.

When in doubt, leave it out — an empty answer beats noise. If nothing is worth keeping, answer with exactly NONE.`

export interface DeriveOptions {
  provider: Provider
  model: string
  /** The person's own words: the only text a fact may stand on. */
  person: string
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
    .map((line) => stoodOn(line, options.person))
    .filter((fact): fact is string => fact !== null)
    .slice(0, MAX_FACTS)
}

const TAB = '\t'

/**
 * A line as the system asks for it — the fact, a tab, the person's words — and
 * only its fact, when the words are really theirs.
 *
 * The prompt already forbids writing down what the assistant said, and a cheap
 * model ignored it once: a fact invented out of the answer reached the store and
 * was recalled as something the person had said. The rule is checked here
 * instead of trusted, and a line that cannot point at the person's own message
 * is dropped rather than saved.
 */
function stoodOn(line: string, person: string): string | null {
  const at = line.indexOf(TAB)
  if (at <= 0) return null
  const fact = line.slice(0, at).trim()
  const quote = unquote(line.slice(at + 1)).trim()
  if (!fact || !quote) return null
  return saidBy(person, quote) ? fact : null
}

/** The quote the way a model copies it: wrapped in quotes, as often as not. */
function unquote(text: string): string {
  return text.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
}

/**
 * Whether the person's message contains the quote, accents, case, punctuation
 * and spacing aside — faithful enough to catch a misquote, strict enough that
 * words the person never said cannot stand on it.
 */
function saidBy(person: string, quote: string): boolean {
  const said = fold(person)
  const held = fold(quote)
  return held.length > 0 && said.includes(held)
}

function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
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
