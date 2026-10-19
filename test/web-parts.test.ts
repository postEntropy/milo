import { describe, expect, it } from 'vitest'
import { appendDeltas, withDelta, type PendingDelta } from '../web/src/chat/parts.js'

describe('a frame of tokens', () => {
  it('gathers one channel into a single run', () => {
    let batch: PendingDelta[] = []
    for (const [kind, delta] of [['text', 'Vou ver '], ['reasoning', 'qual '], ['reasoning', 'gerenciador'], ['text', ' é o SDDM']] as const) {
      batch = withDelta(batch, kind, delta)
    }
    expect(batch).toEqual([
      { kind: 'text', delta: 'Vou ver ' },
      { kind: 'reasoning', delta: 'qual gerenciador' },
      { kind: 'text', delta: ' é o SDDM' },
    ])
  })

  it('draws a thought ahead of the words that followed it in the same batch', () => {
    const batch: PendingDelta[] = [
      { kind: 'reasoning', delta: 'Preciso ver o gerenciador.' },
      { kind: 'text', delta: 'Vou ver qual gerenciador está em uso.' },
    ]
    const parts = appendDeltas([], batch)
    expect(parts).toEqual([
      { kind: 'reasoning', text: 'Preciso ver o gerenciador.' },
      { kind: 'text', text: 'Vou ver qual gerenciador está em uso.' },
    ])
  })

  it('joins prose that arrives after prose', () => {
    const parts = appendDeltas([], [{ kind: 'text', delta: 'Vou ver ' }, { kind: 'text', delta: 'qual gerenciador.' }])
    expect(parts).toEqual([{ kind: 'text', text: 'Vou ver qual gerenciador.' }])
  })

  it('opens a new prose part after a thought that follows prose', () => {
    const parts = appendDeltas([], [
      { kind: 'text', delta: 'Primeiro.' },
      { kind: 'reasoning', delta: 'Agora a segunda etapa.' },
      { kind: 'text', delta: 'Segundo.' },
    ])
    expect(parts.map((part) => part.kind)).toEqual(['text', 'reasoning', 'text'])
  })
})
