import type { AgentEvent, TranscriptPart, TurnWaitState } from '@protocol'
import { finalThoughtMs, reduceTurnWaitState } from '../../../src/gateways/web/protocol.ts'
import { drawsToolFailure, toolText } from '../../../src/gateways/tool-line.ts'
import type { ChatMessage } from './message.js'
import { appendDeltas, withWidget, type PendingDelta } from './parts.js'

function waitStateOf(message: ChatMessage): TurnWaitState {
  return {
    phase: message.waitPhase ?? 'waiting-response',
    ...(message.thoughtMs !== undefined ? { thoughtMs: message.thoughtMs } : {}),
    ...(message.hasUnobservedReasoning ? { hasUnobservedReasoning: true } : {}),
  }
}

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
  const nextWait = reduceTurnWaitState(waitStateOf(message), event)

  if (event.type === 'tool-start') {
    return {
      ...message,
      parts: [...message.parts, { kind: 'tool', tool: { name: event.name, text: toolText(event.name, event.args), state: 'running', callId: event.id, ...(event.input ? { input: event.input } : {}) } }],
      status: undefined,
      waitPhase: nextWait.phase,
      thoughtMs: nextWait.thoughtMs,
      ...(nextWait.hasUnobservedReasoning ? { hasUnobservedReasoning: true } : {}),
    }
  }
  if (event.type === 'tool-end') {
    // The call that just ended is the one still marked running, which is how the
    // line knows to stop saying it is underway — no second source of truth for
    // what is running, and no name matched against names that repeat.
    // The result rides the same part, for the detail under the line; the server
    // sends it empty below the `full` level, so an empty one draws nothing.
    const result = event.result ? { result: event.result } : {}
    const change = event.change && event.change.length > 0 ? { change: event.change } : {}
    const preview = event.preview ? { preview: event.preview, callId: event.id } : {}
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
        ? [...message.parts, { kind: 'tool', tool: { name: event.name, text: toolText(event.name), state: 'failed', ...result, ...change, ...preview } }]
        : message.parts
      : message.parts.map((part, index): TranscriptPart => index === running && part.kind === 'tool'
        ? { ...part, tool: { ...part.tool, state: event.isError ? 'failed' : 'done', ...result, ...change, ...preview } }
        : part)
    return {
      ...message,
      parts,
      waitPhase: nextWait.phase,
      thoughtMs: nextWait.thoughtMs,
      ...(nextWait.hasUnobservedReasoning ? { hasUnobservedReasoning: true } : {}),
    }
  }
  if (event.type === 'response-waiting' || event.type === 'reasoning-start' || event.type === 'waited' || event.type === 'compacted' || event.type === 'steer') {
    return {
      ...message,
      status: undefined,
      waitPhase: nextWait.phase,
      thoughtMs: nextWait.thoughtMs,
      ...(nextWait.hasUnobservedReasoning ? { hasUnobservedReasoning: true } : {}),
    }
  }
  if (event.type === 'reasoning-end') {
    return {
      ...message,
      waitPhase: nextWait.phase,
      thoughtMs: nextWait.thoughtMs,
      ...(nextWait.hasUnobservedReasoning ? { hasUnobservedReasoning: true } : {}),
    }
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
    return { ...message, parts: withWidget(message.parts, part), ...(event.draft ? { status: undefined } : {}), waitPhase: nextWait.phase }
  }
  // The words are the daemon's: `says` is what the turn's row shows about the step,
  // written in one place and not once per surface. A step with nothing to say about
  // the row — a finished turn, a tool line — leaves the line that is already there.
  if (event.type === 'done' || event.type === 'error' || event.type === 'aborted') {
    // A call left marked running never heard back from, whether the turn failed or was
    // stopped: it stops saying it is underway, and the row says why.
    return {
      ...message,
      parts: settled(message.parts),
      waitPhase: undefined,
      thoughtMs: finalThoughtMs(nextWait),
      ...(says ? { status: says } : {}),
    }
  }
  if (event.type === 'job-waited') {
    const last = message.parts[message.parts.length - 1]
    const parts =
      last?.kind === 'text' && last.text.trim() && !last.text.endsWith('\n\n')
        ? [...message.parts.slice(0, -1), { ...last, text: `${last.text.replace(/\n+$/, '')}\n\n` }]
        : message.parts
    return { ...message, parts, status: undefined, waitPhase: nextWait.phase }
  }
  if (event.type === 'waiting' || event.type === 'compacting' || event.type === 'job-waiting') {
    return {
      ...message,
      waitPhase: nextWait.phase,
      thoughtMs: nextWait.thoughtMs,
      ...(nextWait.hasUnobservedReasoning ? { hasUnobservedReasoning: true } : {}),
      ...(says ? { status: says } : {}),
    }
  }
  if (event.type === 'usage') return { ...message, tokens: { input: event.inputTokens, output: event.outputTokens } }
  if (says) return { ...message, status: says }
  return message
}

/**
 * Applies a frame's gathered text/reasoning deltas using the shared turn state
 * reducer so live delta transitions and duration invalidation match everywhere.
 */
export function applyDeltas(message: ChatMessage, batch: readonly PendingDelta[]): ChatMessage {
  let state = waitStateOf(message)
  let wrote = false
  for (const token of batch) {
    if (token.kind === 'text') {
      wrote = true
      state = reduceTurnWaitState(state, { type: 'text-delta', delta: token.delta })
    } else {
      state = reduceTurnWaitState(state, {
        type: 'reasoning-delta',
        delta: token.delta,
        ...(token.replayed ? { replayed: true } : {}),
      })
    }
  }
  return {
    ...message,
    parts: appendDeltas(message.parts, batch),
    waitPhase: state.phase,
    thoughtMs: state.thoughtMs,
    ...(state.hasUnobservedReasoning ? { hasUnobservedReasoning: true } : {}),
    ...(wrote ? { status: undefined } : {}),
  }
}

/**
 * Finalize accumulated thinking duration when a turn or bot message settles.
 */
export function finalizedThoughtMs(message: ChatMessage): number | undefined {
  return finalThoughtMs({
    thoughtMs: message.thoughtMs,
    hasUnobservedReasoning: message.hasUnobservedReasoning,
  })
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
