import { describe, expect, it } from 'vitest'
import type { TranscriptPart } from '../src/gateways/web/protocol.js'
import { toolRows, type KeyedPart } from '../web/src/chat/tool-runs.js'

/** Parts as the page holds them: named by kind and the order they arrived in. */
function keyed(parts: TranscriptPart[]): KeyedPart[] {
  const seen = new Map<string, number>()
  return parts.map((part) => {
    const occurrence = seen.get(part.kind) ?? 0
    seen.set(part.kind, occurrence + 1)
    return { part, key: `${part.kind}-${occurrence}` }
  })
}

const call = (name: string, value: string): TranscriptPart => ({ kind: 'tool', tool: { name, text: `${name} ${value}` } })
const said = (text: string): TranscriptPart => ({ kind: 'text', text })
const thought = (text: string): TranscriptPart => ({ kind: 'reasoning', text })

/** The calls a row holds, without the names they are drawn under. */
function callsIn(rows: ReturnType<typeof toolRows>): Array<Array<{ name: string; text: string; state?: string }>> {
  return rows.map((row) => row.kind === 'spine' ? row.steps.map((step) => step.tool) : [])
}

describe('one turn, grouped for drawing', () => {
  it('draws a call on its own as a line, not a thread', () => {
    const rows = toolRows(keyed([call('grep', 'retry')]))

    expect(rows).toEqual([{ kind: 'part', part: call('grep', 'retry'), key: 'tool-0' }])
  })

  it('draws two calls that came back to back as one thread', () => {
    const rows = toolRows(keyed([call('grep', 'retry'), call('read_file', 'src/core/retry.ts')]))

    expect(rows[0]?.kind).toBe('spine')
    expect(callsIn(rows)).toEqual([[
      { name: 'grep', text: 'grep retry' },
      { name: 'read_file', text: 'read_file src/core/retry.ts' },
    ]])
    // A step is named by the part it came from, never by where it sits.
    expect(rows[0]?.kind === 'spine' ? rows[0].steps.map((step) => step.key) : []).toEqual(['tool-0', 'tool-1'])
  })

  it('keeps the steps of a thread in the order they were called', () => {
    const rows = toolRows(keyed([call('a', '1'), call('b', '2'), call('c', '3')]))

    expect(callsIn(rows)[0]?.map((tool) => tool.name)).toEqual(['a', 'b', 'c'])
  })

  it('ends the thread at a thought, because thinking is not a call', () => {
    const rows = toolRows(keyed([call('a', '1'), thought('now the other one'), call('b', '2')]))

    // Two calls with a thought between them were not made back to back.
    expect(rows.map((row) => row.kind)).toEqual(['part', 'part', 'part'])
  })

  it('ends the thread at prose, and starts a new one after it', () => {
    const rows = toolRows(keyed([call('a', '1'), call('b', '2'), said('both failed'), call('c', '3'), call('d', '4')]))

    expect(rows.map((row) => row.kind)).toEqual(['spine', 'part', 'spine'])
    expect(rows[1]?.kind === 'part' ? rows[1].part : null).toEqual(said('both failed'))
  })

  it('leaves a plan or a widget between calls to end the thread too', () => {
    const plan: TranscriptPart = { kind: 'todo', items: [{ content: 'Step', status: 'pending' }] }
    const rows = toolRows(keyed([call('a', '1'), plan, call('b', '2')]))

    expect(rows.map((row) => row.kind)).toEqual(['part', 'part', 'part'])
  })

  it('draws every part of a turn with none of them dropped', () => {
    const parts = [said('before'), call('a', '1'), call('b', '2'), said('after')]
    const drawn = toolRows(keyed(parts))

    expect(drawn).toHaveLength(3)
    expect(drawn[0]?.kind === 'part' ? drawn[0].part : null).toEqual(said('before'))
    expect(drawn[2]?.kind === 'part' ? drawn[2].part : null).toEqual(said('after'))
  })

  it('carries what the calls said about themselves, state included', () => {
    const done: TranscriptPart = { kind: 'tool', tool: { name: 'a', text: 'a 1', state: 'done' } }
    const running: TranscriptPart = { kind: 'tool', tool: { name: 'b', text: 'b 2', state: 'running' } }
    const rows = toolRows(keyed([done, running]))

    expect(callsIn(rows)[0]?.map((tool) => tool.state)).toEqual(['done', 'running'])
  })
})
