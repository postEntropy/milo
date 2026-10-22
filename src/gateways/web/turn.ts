import { statusText } from '../../core/sessions/format.js'
import { toolDraw, toolResult } from '../tool-line.js'
import type { DisplayConfig } from '../../core/config/schema.js'
import type { AgentEvent, ServerFrame } from './protocol.js'

export type SendFrame = (frame: ServerFrame) => void

/**
 * The sentence a frame carries for the turn's own row, in the daemon's words: the browser
 * and the phone both read it here instead of writing the sentence each for itself. The
 * phone cannot import `statusText` at all, and a sentence written twice is a sentence that
 * drifts — which is what the phone's copy had already done. The tool line's `text` travels
 * for the same reason.
 *
 * A stopped turn is the other half: the frame says the state, and the sentence for that
 * state is the aborted one, written in the one place that writes it.
 */
export function withWords(frame: ServerFrame): ServerFrame {
  if (frame.type !== 'event' && frame.type !== 'turn-end') return frame
  const said = frame.type === 'event'
    ? statusText(frame.event)
    : (frame.status === 'stopped' ? statusText({ type: 'aborted' }) : undefined)
  return said ? { ...frame, says: said } : frame
}

export function displayEvent(event: AgentEvent, turnId: string, display: DisplayConfig, send: SendFrame): void {
  if (event.type === 'tool-start') {
    // Whether the call is drawn at all is `toolDraw`'s answer — the same one a
    // session read back from disk and the settings preview use, so the three can
    // no longer disagree. What is left here is the wire's shape of that answer:
    // `name` withholds the args rather than pre-formatting a shorter string, so
    // the one formatter still decides the line's shape.
    const mark = toolDraw(event.name, event.args, display.tools)
    if (!mark) return
    // The line is sent as well as the arguments. The browser re-reads the args
    // through the same formatter it imports, but a surface that cannot import the
    // TypeScript — the phone — reads this instead of keeping a copy that would
    // drift, the way `ToolMark.text` already carries a stored call's line.
    send({
      type: 'event',
      turnId,
      event: { ...event, text: mark.text, args: display.tools === 'name' ? undefined : event.args },
    })
    return
  }
  if (event.type === 'tool-end') {
    // The result rides the same level as the line: at `full` the call shows what it came
    // back with, and below it the line is a name alone, so the result is not offered at
    // all. Empty rather than absent, because the event's own shape carries a string — the
    // surfaces read an empty result as "draw nothing".
    const result = display.tools === 'full' ? toolResult(event.result) : ''
    const change = display.tools === 'full' ? event.change : undefined
    send({ type: 'event', turnId, event: { ...event, result, change } })
    return
  }
  // A thought always rides, whatever the display: `collapsed` draws it folded, and
  // a folded block is one click from being read, so the text has to be here.
  send({ type: 'event', turnId, event })
}
