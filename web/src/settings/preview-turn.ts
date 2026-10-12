import { toolDraw, type ToolLevel } from '../../../src/gateways/tool-line.js'

/**
 * The sample turn for the Display preview.
 *
 * Kept a plain union with no imports but the one rule it shares with the chat,
 * like `suggestions.ts`: a root test imports this file, so it must not reach into
 * the web app's aliases or the DOM. The line itself comes from `toolDraw` — the
 * same function the live turn and a session read back are drawn by — so the
 * preview cannot promise a shape the chat does not draw.
 */
export type PreviewTools = ToolLevel

export type PreviewPart =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool'; tool: { name: string; text: string; state?: 'running' | 'done' | 'failed' } }

export interface PreviewMessage {
  id: string
  role: 'user' | 'assistant'
  loaded: boolean
  thoughtMs?: number
  parts: PreviewPart[]
}

/**
 * One turn, caught in flight: a thought, the prose before a call, and the call
 * itself — still running, which is what puts the glare on it here. The call is a
 * long `shell_command` so every level has something to change — the whole command,
 * the name alone, or nothing at all. `loaded` keeps the sample from replaying the
 * settle-in animation each time a setting moves.
 */
export function previewTurn(tools: PreviewTools): PreviewMessage[] {
  const call = toolDraw('shell_command', { command: 'npm test -- --coverage' }, tools)
  const parts: PreviewPart[] = [
    { kind: 'reasoning', text: 'I should run the tests before answering.' },
    { kind: 'text', text: 'Let me run the suite first.' },
    // The sample is a turn still working, so its call is the last thing said and
    // reads the way a call in flight does: the dot in the accent, the glare along
    // the command.
    ...(call ? [{ kind: 'tool' as const, tool: { ...call, state: 'running' as const } }] : []),
  ]
  return [
    { id: 'preview-user', role: 'user', loaded: true, parts: [{ kind: 'text', text: 'Is the release safe to ship?' }] },
    { id: 'preview-assistant', role: 'assistant', loaded: true, thoughtMs: 2400, parts },
  ]
}
