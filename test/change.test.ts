import { describe, expect, it } from 'vitest'
import { fileChange } from '../src/core/change.js'

const changed = (change: ReturnType<typeof fileChange>) =>
  change.lines.map((line) => `${line.kind === 'context' ? '0' : line.kind[0]}:${line.text}`)

describe('file change', () => {
  it('counts one replaced line as one added and one removed', () => {
    const change = fileChange('a.ts', 'one\ntwo\nthree\n', 'one\nTWO\nthree\n')
    expect(change.additions).toBe(1)
    expect(change.deletions).toBe(1)
    expect(changed(change)).toEqual(['0:one', 'r:two', 'a:TWO', '0:three'])
  })

  it('numbers the lines each side of the change', () => {
    const change = fileChange('a.ts', 'one\ntwo\nthree\n', 'one\ntwo\nthree\nfour\n')
    expect(change.lines).toEqual([
      { kind: 'context', text: 'two', old: 2, new: 2 },
      { kind: 'context', text: 'three', old: 3, new: 3 },
      { kind: 'add', text: 'four', new: 4 },
    ])
  })

  it('draws a file that did not exist as all added, capped but counted whole', () => {
    const content = `${Array.from({ length: 200 }, (_, index) => `line ${index + 1}`).join('\n')}\n`
    const change = fileChange('new.ts', null, content)
    expect(change.created).toBe(true)
    expect(change.additions).toBe(200)
    expect(change.deletions).toBe(0)
    expect(change.lines).toHaveLength(80)
    expect(change.lines[0]).toEqual({ kind: 'add', text: 'line 1', new: 1 })
    expect(change.truncated).toBe(true)
  })

  it('draws a file that is gone as all removed', () => {
    const change = fileChange('old.ts', 'a\nb\n', null)
    expect(change.deleted).toBe(true)
    expect(change.deletions).toBe(2)
    expect(change.lines).toEqual([
      { kind: 'remove', text: 'a', old: 1 },
      { kind: 'remove', text: 'b', old: 2 },
    ])
  })

  it('says nothing changed when the text is the same', () => {
    const change = fileChange('a.ts', 'one\ntwo\n', 'one\ntwo\n')
    expect(change.additions).toBe(0)
    expect(change.deletions).toBe(0)
    expect(change.lines).toEqual([])
  })

  it('lines up two changes far apart in a large file', () => {
    const before = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`)
    const after = [...before]
    after[0] = 'first'
    after[199] = 'last'
    const change = fileChange('a.ts', `${before.join('\n')}\n`, `${after.join('\n')}\n`)
    expect(change.additions).toBe(2)
    expect(change.deletions).toBe(2)
    expect(change.lines.filter((line) => line.kind === 'add').map((line) => line.text)).toEqual(['first', 'last'])
  })

  it('keeps two lines of context on each side, and no more', () => {
    const before = `${['a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n')}\n`
    const after = `${['a', 'b', 'c', 'D', 'e', 'f', 'g'].join('\n')}\n`
    expect(changed(fileChange('a.ts', before, after))).toEqual(['0:b', '0:c', 'r:d', 'a:D', '0:e', '0:f'])
  })
})
