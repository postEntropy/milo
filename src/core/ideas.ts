import { errorMessage } from '../util/errors.js'
import { logWarn } from '../util/log.js'
import type { Provider } from './providers/types.js'

/**
 * How long the home's idea generation may take before it is dropped.
 *
 * Nobody is waiting on this: the welcome screen is drawn from the standing four
 * the moment it appears, and the ideas arrive only to replace them. It is a small
 * request — four short lines — so the budget is short, and a call that overruns
 * leaves the standing four exactly where they were.
 */
const DEFAULT_IDEAS_TIMEOUT_MS = 10_000

/** The most ideas the welcome screen has room for. */
const MAX_IDEAS = 4

/** How many notes are read as grounding. Beyond this the list only adds noise. */
const GROUNDING_NOTES = 40

const IDEAS_SYSTEM = `You suggest what a person might want to do next with their coding assistant, from what is known about them.

Write up to four ideas, one per line, each in the form:
Title | the message the person would send

A title is a few words at most — "Investigate the deploy failure", "Tidy the memory list". After the pipe comes the sentence the assistant will receive: specific and short, in the language of the person's own work.

Ground every idea in the notes and the recent session titles you are given, and in nothing else. Never invent a file, a project or a fact that is not there. If nothing is worth offering, answer with exactly NONE. No preamble, no numbering, no blank lines.`

/** One card the welcome screen may draw from a generated idea. */
export interface Idea {
  title: string
  prompt: string
}

export interface IdeaInput {
  provider: Provider
  model: string
  /** What Milo keeps about the person, newest first. */
  notes: string[]
  /** The most recent sessions that spoke, newest first. */
  sessions: { title?: string; preview?: string; recap?: string }[]
  signal?: AbortSignal
  timeoutMs?: number
}

/**
 * Up to four ideas for the home, as a model reads them from what Milo knows: []
 * when there is nothing worth offering, and [] on any failure.
 *
 * The one-shot counterpart of `deriveFacts`, and it fails the same quiet way. It
 * runs behind a screen that is already drawn, so a slow, refused or broken call
 * costs the standing four nothing.
 */
export async function deriveIdeas(input: IdeaInput): Promise<Idea[]> {
  const text = await ask(input)
  if (text === null) return []
  const ideas = parseIdeas(text)
  // A model that answered with prose instead of the asked-for lines is a failure
  // worth seeing — the standing four stay, but not without saying why.
  if (ideas.length === 0 && text.trim() && !/^none[.!]?$/i.test(text.trim())) {
    logWarn('the home-ideas answer held no usable lines; the standing four stay')
  }
  return ideas
}

/** The model's lines as cards, dropping anything not written in the shape asked for. */
function parseIdeas(text: string): Idea[] {
  const ideas: Idea[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.replace(/^\s*[-*•]\s*/, '').trim()
    if (!trimmed || /^none[.!]?$/i.test(trimmed)) continue
    const pipe = trimmed.indexOf('|')
    if (pipe === -1) continue
    const title = trimmed.slice(0, pipe).trim()
    const prompt = trimmed.slice(pipe + 1).trim()
    if (!title || !prompt) continue
    ideas.push({ title, prompt })
    if (ideas.length >= MAX_IDEAS) break
  }
  return ideas
}

/**
 * Two attempts, the same way fact extraction does it: asking for `low` effort
 * keeps the call cheap, and a provider that rejects the field still gets asked
 * once without it rather than silently never offering ideas. A call cut off by
 * its own budget is not retried — it would be cut off the same way.
 */
async function ask(input: IdeaInput): Promise<string | null> {
  const hinted = await stream(input, 'low')
  if (hinted.ok) return hinted.text

  if (hinted.aborted) {
    if (hinted.aborted === 'timeout') {
      logWarn(`home ideas took longer than ${input.timeoutMs ?? DEFAULT_IDEAS_TIMEOUT_MS}ms and were dropped`)
    }
    return null
  }

  logWarn(`home ideas failed with the effort hint, asking again without it: ${hinted.error}`)
  const plain = await stream(input, undefined)
  if (plain.ok) return plain.text
  logWarn(`could not derive home ideas: ${plain.error}`)
  return null
}

/**
 * One attempt. `aborted` says the attempt was cut off rather than answered or
 * refused — by its own budget (`timeout`), or because the turn it belongs to was
 * stopped (`stopped`) — and neither is a fact about the request worth a retry.
 */
async function stream(
  input: IdeaInput,
  reasoningEffort: 'low' | undefined,
): Promise<{ ok: true; text: string } | { ok: false; aborted: 'timeout' | 'stopped' | null; error: string }> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  const timer = setTimeout(abort, input.timeoutMs ?? DEFAULT_IDEAS_TIMEOUT_MS)
  input.signal?.addEventListener('abort', abort, { once: true })

  let text = ''
  try {
    for await (const event of input.provider.stream({
      model: input.model,
      system: IDEAS_SYSTEM,
      messages: [{ role: 'user', content: [{ type: 'text', text: groundingText(input) }] }],
      ...(reasoningEffort ? { reasoningEffort } : {}),
      signal: controller.signal,
    })) {
      if (event.type === 'text') text += event.delta
    }
    return { ok: true, text }
  } catch (error) {
    const aborted = !controller.signal.aborted
      ? null
      : input.signal?.aborted
        ? 'stopped'
        : 'timeout'
    return { ok: false, aborted, error: errorMessage(error) }
  } finally {
    clearTimeout(timer)
    input.signal?.removeEventListener('abort', abort)
  }
}

/** What the model is given to ground the ideas in: the notes, then the sessions. */
function groundingText(input: IdeaInput): string {
  const notes = input.notes.slice(0, GROUNDING_NOTES)
  const lines: string[] = []
  if (notes.length > 0) lines.push('What is known about the person:', ...notes.map((note) => `- ${note}`))
  const titles = input.sessions
    .map((session) => (session.title || session.preview || session.recap || '').trim())
    .filter((title) => title.length > 0)
  if (titles.length > 0) lines.push('', 'Recent sessions:', ...titles.map((title) => `- ${title}`))
  return lines.join('\n')
}
