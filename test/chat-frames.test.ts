import { describe, expect, it } from 'vitest'
import { applyEvent, settled } from '../web/src/chat/frames.js'
import type { ChatMessage } from '../web/src/chat/message.js'
import type { TranscriptPart } from '../src/gateways/web/protocol.js'

function message(parts: TranscriptPart[], waitingSince?: number): ChatMessage {
  return { id: 'turn-1', role: 'assistant', parts, ...(waitingSince === undefined ? {} : { waitingSince }) }
}

describe('one step of a turn folded into its message', () => {
  it('opens a tool line and ends the wait that was filling the answer', () => {
    const next = applyEvent(message([], Date.now() - 2000), { type: 'tool-start', id: 'c1', name: 'read_file', args: { path: 'a.ts' } })
    expect(next.parts).toHaveLength(1)
    expect(next.parts[0]).toMatchObject({ kind: 'tool', tool: { name: 'read_file', state: 'running' } })
    expect(next.waitingSince).toBeUndefined()
    expect(next.thoughtMs).toBeGreaterThanOrEqual(1000)
  })

  it('settles the call that was running when its result arrives', () => {
    const running: TranscriptPart = { kind: 'tool', tool: { name: 'read_file', text: 'read_file a.ts', state: 'running' } }
    const next = applyEvent(message([running]), { type: 'tool-end', id: 'c1', name: 'read_file', result: 'ok', isError: false })
    expect(next.parts[0]).toMatchObject({ kind: 'tool', tool: { state: 'done', result: 'ok' } })
  })

  it('says a failure that would otherwise go unsaid, even with no line to put it on', () => {
    const next = applyEvent(message([]), { type: 'tool-end', id: 'c1', name: 'shell_command', result: 'boom', isError: true })
    expect(next.parts[0]).toMatchObject({ kind: 'tool', tool: { name: 'shell_command', state: 'failed', result: 'boom' } })
  })

  it('stops a running call and says why when the turn is stopped', () => {
    const running: TranscriptPart = { kind: 'tool', tool: { name: 'read_file', text: 'read_file a.ts', state: 'running' } }
    const next = applyEvent(message([running]), { type: 'aborted' }, 'Stopped.')
    expect(next.parts[0]).toMatchObject({ kind: 'tool', tool: { state: undefined } })
    expect(next.status).toBe('Stopped.')
  })

  it('leaves a token to the caller, which draws a batch once per frame', () => {
    const before = message([{ kind: 'text', text: 'One.' }])
    expect(applyEvent(before, { type: 'text-delta', delta: ' two' })).toBe(before)
  })

  it('keeps the step words the daemon wrote, and only those', () => {
    const quiet = applyEvent(message([{ kind: 'text', text: 'Done.' }]), { type: 'done', finishReason: 'stop' })
    expect(quiet.status).toBeUndefined()
    const said = applyEvent(message([{ kind: 'text', text: 'Done.' }]), { type: 'done', finishReason: 'stop' }, 'Checking the folder')
    expect(said.status).toBe('Checking the folder')
  })
})

describe('a call nobody heard back from', () => {
  it('stops saying it is underway without guessing how it went', () => {
    const parts: TranscriptPart[] = [
      { kind: 'text', text: 'Let me look.' },
      { kind: 'tool', tool: { name: 'read_file', text: 'read_file a.ts', state: 'running' } },
    ]
    expect(settled(parts)).toEqual([
      { kind: 'text', text: 'Let me look.' },
      { kind: 'tool', tool: { name: 'read_file', text: 'read_file a.ts', state: undefined } },
    ])
  })
})
