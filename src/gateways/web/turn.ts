import { showsToolCall } from '../tool-line.js'
import type { AgentEvent, ServerFrame } from './protocol.js'

type DisplayConfig = { tools: 'full' | 'name' | 'off'; thinking: 'on' | 'off' }

export type SendFrame = (frame: ServerFrame) => void

export function displayEvent(event: AgentEvent, turnId: string, display: DisplayConfig, send: SendFrame): void {
  if (event.type === 'tool-start') {
    if (display.tools === 'off' || !showsToolCall(event.name)) return
    // Sent as a tool event, not folded into the reply text: the client draws the
    // line from the shared formatter, so the live turn and a session read back
    // look the same. `name` withholds the args rather than pre-formatting a
    // shorter string, so the one formatter still decides the line's shape.
    send({ type: 'event', turnId, event: { ...event, args: display.tools === 'name' ? undefined : event.args } })
    return
  }
  if (event.type === 'reasoning-delta' && display.thinking === 'off') return
  send({ type: 'event', turnId, event })
}
