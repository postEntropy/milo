import { describe, expect, it } from 'vitest'
import { applyDeltas, applyEvent, finalizedThoughtMs, settled } from '../web/src/chat/frames.js'
import type { ChatMessage } from '../web/src/chat/message.js'
import type { TranscriptPart, TurnWaitPhase } from '../src/gateways/web/protocol.js'

function message(parts: TranscriptPart[], waitPhase?: TurnWaitPhase): ChatMessage {
  return { id: 'turn-1', role: 'assistant', parts, ...(waitPhase === undefined ? {} : { waitPhase }) }
}

describe('one step of a turn folded into its message', () => {
  it('opens a tool line and transitions to tool phase without inventing thought duration', () => {
    const next = applyEvent(message([], 'waiting-response'), { type: 'tool-start', id: 'c1', name: 'read_file', args: { path: 'a.ts' } })
    expect(next.parts).toHaveLength(1)
    expect(next.parts[0]).toMatchObject({ kind: 'tool', tool: { name: 'read_file', state: 'running' } })
    expect(next.waitPhase).toBe('tool')
    expect(next.thoughtMs).toBeUndefined()
  })

  it('tracks provider-signaled thinking and sums observed reasoning durations', () => {
    const start = applyEvent(message([], 'waiting-response'), { type: 'reasoning-start' })
    expect(start.waitPhase).toBe('thinking')

    const ended = applyEvent(start, { type: 'reasoning-end', ms: 1400 })
    expect(ended.waitPhase).toBe('waiting-response')
    expect(ended.thoughtMs).toBe(1400)

    const again = applyEvent(applyEvent(ended, { type: 'reasoning-start' }), { type: 'reasoning-end', ms: 600 })
    expect(again.thoughtMs).toBe(2000)

    const finished = applyEvent(again, { type: 'done', finishReason: 'stop' })
    expect(finished.waitPhase).toBeUndefined()
    expect(finished.thoughtMs).toBe(2000)
  })

  it('drops sub-second thinking duration when settling a turn', () => {
    const short = applyEvent(applyEvent(message([], 'waiting-response'), { type: 'reasoning-start' }), { type: 'reasoning-end', ms: 400 })
    expect(finalizedThoughtMs(short)).toBeUndefined()
    const aborted = applyEvent(short, { type: 'aborted' }, 'Stopped.')
    expect(aborted.waitPhase).toBeUndefined()
    expect(aborted.thoughtMs).toBeUndefined()
  })

  it('discards prior partial duration when an unmeasured or replayed reasoning block follows', () => {
    const firstComplete = applyEvent(applyEvent(message([], 'waiting-response'), { type: 'reasoning-start' }), { type: 'reasoning-end', ms: 1400 })
    expect(firstComplete.thoughtMs).toBe(1400)

    const unmeasuredInterrupt = applyEvent(applyEvent(firstComplete, { type: 'reasoning-start' }), { type: 'reasoning-end' })
    expect(unmeasuredInterrupt.hasUnobservedReasoning).toBe(true)
    expect(unmeasuredInterrupt.thoughtMs).toBeUndefined()

    const laterComplete = applyEvent(applyEvent(unmeasuredInterrupt, { type: 'reasoning-start' }), { type: 'reasoning-end', ms: 1600 })
    expect(laterComplete.thoughtMs).toBeUndefined()

    const replayed = applyDeltas(message([], 'waiting-response'), [
      { kind: 'reasoning', delta: 'post-hoc summary', replayed: true },
      { kind: 'text', delta: 'done' },
    ])
    expect(replayed.waitPhase).toBe('writing')
    expect(replayed.hasUnobservedReasoning).toBe(true)
    expect(replayed.parts).toEqual([
      { kind: 'reasoning', text: 'post-hoc summary' },
      { kind: 'text', text: 'done' },
    ])
  })

  it('settles the call that was running when its result arrives and waits for next response', () => {
    const running: TranscriptPart = { kind: 'tool', tool: { name: 'read_file', text: 'read_file a.ts', state: 'running' } }
    const next = applyEvent(message([running], 'tool'), { type: 'tool-end', id: 'c1', name: 'read_file', result: 'ok', isError: false })
    expect(next.parts[0]).toMatchObject({ kind: 'tool', tool: { state: 'done', result: 'ok' } })
    expect(next.waitPhase).toBe('waiting-response')
  })

  it('says a failure that would otherwise go unsaid, even with no line to put it on', () => {
    const next = applyEvent(message([], 'tool'), { type: 'tool-end', id: 'c1', name: 'shell_command', result: 'boom', isError: true })
    expect(next.parts[0]).toMatchObject({ kind: 'tool', tool: { name: 'shell_command', state: 'failed', result: 'boom' } })
    expect(next.waitPhase).toBe('waiting-response')
  })

  it('stops a running call and says why when the turn is stopped', () => {
    const running: TranscriptPart = { kind: 'tool', tool: { name: 'read_file', text: 'read_file a.ts', state: 'running' } }
    const next = applyEvent(message([running], 'tool'), { type: 'aborted' }, 'Stopped.')
    expect(next.parts[0]).toMatchObject({ kind: 'tool', tool: { state: undefined } })
    expect(next.waitPhase).toBeUndefined()
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

  it('separates progress prose across job-waiting and job-waited and clears the wait status', () => {
    const waiting = applyEvent(
      message([{ kind: 'text', text: 'Downloading tools…' }], 'waiting-response'),
      { type: 'job-waiting', ids: ['job_40'] },
      'Waiting for job_40…',
    )
    expect(waiting.status).toBe('Waiting for job_40…')
    expect(waiting.waitPhase).toBe('waiting-job')

    const resumed = applyEvent(waiting, {
      type: 'job-waited',
      ids: ['job_40'],
      ms: 3000,
      reason: 'settled',
    })
    expect(resumed.status).toBeUndefined()
    expect(resumed.waitPhase).toBe('waiting-response')
    expect(resumed.parts[0]).toEqual({ kind: 'text', text: 'Downloading tools…\n\n' })
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
