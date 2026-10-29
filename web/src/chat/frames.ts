import type { AgentEvent, TranscriptPart } from '@protocol'
import { drawsToolFailure, toolText } from '../../../src/gateways/tool-line.ts'
import type { ChatMessage } from './message.js'
import { withWidget } from './parts.js'

/**
 * One event of a turn folded into the message it belongs to.
 *
 * The wide screen and the spotlight draw the same turn, so they fold it the same
 * way — there is one implementation of what a tool line, a widget or a failed
 * call does to the message, not one per screen.
 *
 * A text or reasoning token is the caller's: both screens gather deltas into a
 * batch and draw them once per frame, so this leaves the message alone for them.
 */
export function applyEvent(message: ChatMessage, event: AgentEvent, says?: string): ChatMessage {
  if (event.type === 'tool-start') {
    // Reasoning deltas do not end a wait — they are what fills it. A tool
    // call is an output of its own, and the wait before it was thinking.
    const waited = message.waitingSince ? Date.now() - message.waitingSince : 0
    return { ...message, parts: [...message.parts, { kind: 'tool', tool: { name: event.name, text: toolText(event.name, event.args), state: 'running' } }], waitingSince: undefined, ...thoughtMsFor(waited, message) }
  }
  if (event.type === 'tool-end') {
    // The result is in: the model is thinking again about what to do with it.
    // The call that just ended is the one still marked running, which is how the
    // line knows to stop saying it is underway — no second source of truth for
    // what is running, and no name matched against names that repeat.
    // The result rides the same part, for the detail under the line; the server
    // sends it empty below the `full` level, so an empty one draws nothing.
    const result = event.result ? { result: event.result } : {}
    const change = event.change && event.change.length > 0 ? { change: event.change } : {}
    let running = -1
    for (let index = message.parts.length - 1; index >= 0; index -= 1) {
      const part = message.parts[index]
      if (part?.kind === 'tool' && part.tool.state === 'running') { running = index; break }
    }
    const parts: TranscriptPart[] = running === -1
      // A call whose own line is not drawn — the plan, a widget — still has a
      // failure worth saying, unless it is a tool that is not one any more.
      // Nothing goes wrong in silence.
      ? event.isError && (event.drawFailure ?? drawsToolFailure(event.name))
        ? [...message.parts, { kind: 'tool', tool: { name: event.name, text: toolText(event.name), state: 'failed', ...result, ...change } }]
        : message.parts
      : message.parts.map((part, index): TranscriptPart => index === running && part.kind === 'tool'
        ? { ...part, tool: { ...part.tool, state: event.isError ? 'failed' : 'done', ...result, ...change } }
        : part)
    return { ...message, parts, waitingSince: Date.now() }
  }
  if (event.type === 'todo') return event.items.length > 0
    ? { ...message, parts: [...message.parts, { kind: 'todo', items: event.items }] }
    : message
  if (event.type === 'verification') {
    return { ...message, parts: [...message.parts, { kind: 'verification', ok: event.ok, text: event.text }] }
  }
  if (event.type === 'ui') {
    // A widget arrives as the model writes it: each draft takes the place of the
    // one before it, and the closed block takes the place of the last draft.
    const part: TranscriptPart = { kind: 'ui', render: event.render, ...(event.draft ? { draft: true } : {}) }
    return { ...message, parts: withWidget(message.parts, part) }
  }
  // The words are the daemon's: `says` is what the turn's row shows about the step,
  // written in one place and not once per surface. A step with nothing to say about
  // the row — a finished turn, a tool line — leaves the line that is already there.
  if (event.type === 'error' || event.type === 'aborted') {
    // A call left marked running never heard back from, whether the turn failed or was
    // stopped: it stops saying it is underway, and the row says why.
    return { ...message, parts: settled(message.parts), ...(says ? { status: says } : {}) }
  }
  if (event.type === 'usage') return { ...message, tokens: { input: event.inputTokens, output: event.outputTokens } }
  if (says) return { ...message, status: says }
  return message
}

/**
 * The number a wait leaves behind on the message. The first one worth reporting
 * wins: it belongs to the tool call or the answer it led to, and it sits above
 * both, so a later wait replacing it would rewrite what the reader already read.
 * Under a second there is nothing to report — the terminal's own threshold.
 */
export function thoughtMsFor(waited: number, message: ChatMessage): { thoughtMs?: number } {
  if (message.thoughtMs !== undefined || waited < 1000) return {}
  return { thoughtMs: waited }
}

/**
 * A call left marked running when the turn ended — a stop, an error, a dropped
 * connection — never heard back from. The line stops saying it is underway rather
 * than guessing how it went, which is the same thing a call read back from disk
 * with no result beside it says: nothing.
 */
export function settled(parts: TranscriptPart[]): TranscriptPart[] {
  return parts.map((part) => part.kind === 'tool' && part.tool.state === 'running'
    ? { ...part, tool: { ...part.tool, state: undefined } }
    : part)
}
