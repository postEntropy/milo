import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '../src/core/agent/events.js'
import {
  cliStatusLabel,
  finalThoughtMs,
  initialTurnWaitState,
  reduceTurnWaitState,
  waitIndicator,
} from '../src/core/agent/turn-state.js'

function replay(events: AgentEvent[]) {
  let state = initialTurnWaitState()
  for (const event of events) {
    state = reduceTurnWaitState(state, event)
  }
  return state
}

describe('shared turn wait state machine', () => {
  it('starts in waiting-response rather than thinking before provider evidence arrives', () => {
    const state = initialTurnWaitState()
    expect(state.phase).toBe('waiting-response')
    expect(waitIndicator(state.phase)).toEqual({ kind: 'dots', label: 'Waiting for response' })
    expect(cliStatusLabel(state.phase)).toBe('…')
    expect(finalThoughtMs(state)).toBeUndefined()
  })

  it('transitions to thinking only on reasoning-start or reasoning-delta, and returns on reasoning-end', () => {
    const start = reduceTurnWaitState(initialTurnWaitState(), { type: 'reasoning-start' })
    expect(start.phase).toBe('thinking')
    expect(waitIndicator(start.phase)).toEqual({ kind: 'text', label: 'Thinking', icon: 'light' })
    expect(cliStatusLabel(start.phase)).toBe('thinking…')

    const end = reduceTurnWaitState(start, { type: 'reasoning-end', ms: 1250 })
    expect(end.phase).toBe('waiting-response')
    expect(end.thoughtMs).toBe(1250)
    expect(finalThoughtMs(end)).toBe(1250)
  })

  it('preserves queue, compaction, tool, and background-job phases without showing Thinking', () => {
    let state = initialTurnWaitState()

    state = reduceTurnWaitState(state, { type: 'waiting' })
    expect(state.phase).toBe('waiting')
    expect(waitIndicator(state.phase)).toBeNull()

    state = reduceTurnWaitState(state, { type: 'waited', ms: 2000 })
    expect(state.phase).toBe('waiting-response')

    state = reduceTurnWaitState(state, { type: 'compacting' })
    expect(state.phase).toBe('compacting')
    expect(waitIndicator(state.phase)).toBeNull()

    state = reduceTurnWaitState(state, { type: 'compacted', ms: 1500, folded: 2, tokens: 300, summarized: true })
    expect(state.phase).toBe('waiting-response')

    state = reduceTurnWaitState(state, { type: 'tool-start', id: 'c1', name: 'read_file', args: {} })
    expect(state.phase).toBe('tool')
    expect(waitIndicator(state.phase)).toBeNull()

    state = reduceTurnWaitState(state, { type: 'tool-end', id: 'c1', name: 'read_file', result: 'ok', isError: false })
    expect(state.phase).toBe('waiting-response')

    state = reduceTurnWaitState(state, { type: 'job-waiting', ids: ['j1'] })
    expect(state.phase).toBe('waiting-job')
    expect(waitIndicator(state.phase)).toBeNull()

    state = reduceTurnWaitState(state, { type: 'job-waited', ids: ['j1'], ms: 5000, reason: 'settled' })
    expect(state.phase).toBe('waiting-response')
  })

  it('accumulates observable reasoning across multiple calls and excludes sub-second totals', () => {
    const underSecond = replay([
      { type: 'reasoning-start' },
      { type: 'reasoning-end', ms: 600 },
      { type: 'text-delta', delta: 'ok' },
      { type: 'done', finishReason: 'stop' },
    ])
    expect(finalThoughtMs(underSecond)).toBeUndefined()

    const multiCall = replay([
      { type: 'response-waiting' },
      { type: 'reasoning-start' },
      { type: 'reasoning-end', ms: 700 },
      { type: 'tool-start', id: 'c1', name: 'read_file', args: {} },
      { type: 'tool-end', id: 'c1', name: 'read_file', result: 'ok', isError: false },
      { type: 'response-waiting' },
      { type: 'reasoning-start' },
      { type: 'reasoning-end', ms: 500 },
      { type: 'text-delta', delta: 'done' },
      { type: 'done', finishReason: 'stop' },
    ])
    expect(multiCall.phase).toBe('done')
    expect(finalThoughtMs(multiCall)).toBe(1200)
  })

  it('settles cleanly on abort and error without inventing duration for incomplete reasoning', () => {
    const aborted = replay([
      { type: 'reasoning-start' },
      { type: 'reasoning-end' },
      { type: 'aborted' },
    ])
    expect(aborted.phase).toBe('done')
    expect(aborted.hasUnobservedReasoning).toBe(true)
    expect(finalThoughtMs(aborted)).toBeUndefined()

    const failed = replay([
      { type: 'reasoning-start' },
      { type: 'reasoning-delta', delta: 'partial' },
      { type: 'error', message: 'boom' },
    ])
    expect(failed.phase).toBe('done')
    expect(failed.hasUnobservedReasoning).toBe(true)
    expect(finalThoughtMs(failed)).toBeUndefined()
  })

  it('drops prior partial duration when an unmeasured or incomplete reasoning block occurs before or after', () => {
    const completeThenInterrupted = replay([
      { type: 'reasoning-start' },
      { type: 'reasoning-end', ms: 1400 },
      { type: 'tool-start', id: 'c1', name: 'read_file', args: {} },
      { type: 'tool-end', id: 'c1', name: 'read_file', result: 'ok', isError: false },
      { type: 'reasoning-start' },
      { type: 'reasoning-end' },
      { type: 'reasoning-start' },
      { type: 'reasoning-end', ms: 1500 },
      { type: 'text-delta', delta: 'recovered' },
      { type: 'done', finishReason: 'stop' },
    ])
    expect(completeThenInterrupted.hasUnobservedReasoning).toBe(true)
    expect(completeThenInterrupted.thoughtMs).toBeUndefined()
    expect(finalThoughtMs(completeThenInterrupted)).toBeUndefined()

    const unclosedThenComplete = replay([
      { type: 'reasoning-start' },
      { type: 'text-delta', delta: 'mid' },
      { type: 'tool-start', id: 'c1', name: 'read_file', args: {} },
      { type: 'tool-end', id: 'c1', name: 'read_file', result: 'ok', isError: false },
      { type: 'reasoning-start' },
      { type: 'reasoning-end', ms: 1800 },
      { type: 'done', finishReason: 'stop' },
    ])
    expect(unclosedThenComplete.hasUnobservedReasoning).toBe(true)
    expect(finalThoughtMs(unclosedThenComplete)).toBeUndefined()

    const deltaWithoutStart = replay([
      { type: 'reasoning-delta', delta: 'unopened' },
      { type: 'reasoning-end', ms: 1800 },
      { type: 'done', finishReason: 'stop' },
    ])
    expect(deltaWithoutStart.hasUnobservedReasoning).toBe(true)
    expect(finalThoughtMs(deltaWithoutStart)).toBeUndefined()
  })

  it('keeps phase accurate and omits duration when reasoning-delta arrives as replayed post-hoc summary', () => {
    const state = replay([
      { type: 'response-waiting' },
      { type: 'reasoning-delta', delta: 'post-hoc summary', replayed: true },
    ])
    expect(state.phase).toBe('waiting-response')
    expect(waitIndicator(state.phase)).toEqual({ kind: 'dots', label: 'Waiting for response' })
    expect(state.hasUnobservedReasoning).toBe(true)
    expect(finalThoughtMs(state)).toBeUndefined()
  })
})
