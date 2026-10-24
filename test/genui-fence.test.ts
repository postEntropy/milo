import { describe, expect, it } from 'vitest'
import { GenUiFence, type GenUiFencePart } from '../src/core/genui-fence.js'
import { GENUI_SECTION, genUiFromBlock } from '../src/core/genui.js'

/** Feeds an answer through in chunks, and returns everything it produced. */
function run(chunks: string[]): GenUiFencePart[] {
  const fence = new GenUiFence()
  return [...chunks.flatMap((chunk) => fence.push(chunk)), ...fence.finish()]
}

const TREE = '{"title":"Team plan","tree":{"kind":"list","items":["eight seats"]}}'
const BLOCK = `\`\`\`genui\n${TREE}\n\`\`\`\n`
const drawn = (part: GenUiFencePart): part is Extract<GenUiFencePart, { kind: 'ui' }> => part.kind === 'ui'

describe('splitting an answer into prose and blocks', () => {
  it('gives prose back untouched when there is no block', () => {
    expect(run(['Lima is the capital.'])).toEqual([{ kind: 'text', text: 'Lima is the capital.' }])
  })

  it('hands a block out as a widget, between the prose around it', () => {
    const parts = run([`Lima.\n\n${BLOCK}And the market opens at nine.`])
    expect(parts.map((part) => part.kind)).toEqual(['text', 'ui', 'text'])
    expect(parts[1] && drawn(parts[1]) ? parts[1].render.title : null).toBe('Team plan')
  })

  it('holds a fence that is still arriving, instead of showing it and taking it back', () => {
    // Three backticks now, the tag a moment later: the tail is never text, so the
    // person never sees ```` ``` ```` appear and vanish mid-answer.
    const parts = run(['Lima.\n\n``', '`genui\n', `${TREE}\n`, '```\n'])
    expect(parts.map((part) => part.kind)).toEqual(['text', 'ui'])
    expect(parts[0]).toEqual({ kind: 'text', text: 'Lima.\n\n' })
  })

  it('waits for the closing fence to finish before drawing anything', () => {
    const halfway = run([BLOCK.slice(0, 30)])
    expect(halfway.every((part) => part.kind !== 'ui')).toBe(true)
  })

  it('takes a closing fence the model ran onto the last line of the tree', () => {
    // `…}]}}` ``` `` with no line break before it. Markdown would not call that a
    // fence and a live model writes it anyway; the intent is not in doubt, so the
    // block closes here rather than running to the end of the answer.
    const parts = run([`Lima.\n\n\`\`\`genui\n${TREE}\`\`\`\nAnd the market opens at nine.`])
    expect(parts.map((part) => part.kind)).toEqual(['text', 'ui', 'text'])
    expect(parts[1] && drawn(parts[1]) ? parts[1].render.title : null).toBe('Team plan')
  })

  it('keeps a block whole across the chunks a real stream arrives in', () => {
    const parts = run([...BLOCK])
    expect(parts.filter(drawn)).toHaveLength(1)
  })

  it('draws two blocks in the order they were written', () => {
    const parts = run([`a\n${BLOCK}b\n${BLOCK}c`])
    expect(parts.map((part) => part.kind)).toEqual(['text', 'ui', 'text', 'ui', 'text'])
  })

  it('leaves a code fence that is not a widget alone', () => {
    const parts = run(['Try this:\n\n```js\nconst x = 1\n```\n'])
    expect(parts).toHaveLength(1)
    expect(parts[0]?.kind).toBe('text')
  })

  it('gives an unreadable block back as its own words, not as nothing', () => {
    const parts = run(['\n```genui\n{not json at all}\n```\n'])
    const refused = parts.find((part) => part.kind === 'refused')
    expect(refused?.kind === 'refused' && refused.text).toContain('{not json at all}')
  })

  it('refuses a tree the schema will not draw, and says so in its text', () => {
    const parts = run(['```genui\n{"title":"x","tree":{"kind":"canvas"}}\n```\n'])
    expect(parts.some((part) => part.kind === 'refused')).toBe(true)
    expect(parts.some(drawn)).toBe(false)
  })

  it('gives a block that never closed back as text when the answer ends', () => {
    const parts = run([`Lima.\n\n\`\`\`genui\n${TREE}`])
    expect(parts[0]).toEqual({ kind: 'text', text: 'Lima.\n\n' })
    expect(parts[1]?.kind).toBe('refused')
  })

  it('holds nothing back that could not still become a fence', () => {
    // A lone backtick mid-sentence is prose, and prose is not delayed.
    expect(run(['a ` tick'])).toEqual([{ kind: 'text', text: 'a ` tick' }])
  })
})

describe('reading a block body', () => {
  it('accepts a tree that fits the catalog', () => {
    expect(genUiFromBlock(TREE)?.title).toBe('Team plan')
  })

  it('refuses text that is not JSON, and JSON that is not a tree', () => {
    expect(genUiFromBlock('not json')).toBeNull()
    expect(genUiFromBlock('{"tree":{"kind":"canvas"}}')).toBeNull()
    expect(genUiFromBlock('{"title":"no tree"}')).toBeNull()
  })
})

describe('drawing a widget while it is still being written', () => {
  /** Feeds an answer through with drafts asked for, and returns everything it produced. */
  function drafting(chunks: string[], draftEveryMs = 0): GenUiFencePart[] {
    const fence = new GenUiFence({ drafts: true, draftEveryMs })
    return [...chunks.flatMap((chunk) => fence.push(chunk)), ...fence.finish()]
  }

  it('fills the widget in as the tree arrives, and still finishes with one finished widget', () => {
    const parts = drafting([
      '```genui\n{"title":"Team plan","tree":{"kind":"list","items":["eight seats"',
      ',"a table for two"]}}',
      '\n```\n',
    ])
    expect(parts.map((part) => part.kind)).toEqual(['ui-draft', 'ui-draft', 'ui'])
    const drafts = parts.filter((part) => part.kind === 'ui-draft')
    const items = (part: GenUiFencePart): unknown =>
      part.kind === 'ui-draft' && part.render.tree.kind === 'list' ? part.render.tree.items : null
    expect(items(drafts[0]!)).toEqual(['eight seats'])
    expect(items(drafts[1]!)).toEqual(['eight seats', 'a table for two'])
    // Nothing is drawn twice at the end: the last draft hands over to the widget.
    expect(parts.filter((part) => part.kind === 'ui')).toHaveLength(1)
  })

  it('fills a chart in as its series arrives, and finishes with one chart', () => {
    const parts = drafting([
      '```genui\n{"tree":{"kind":"chart","type":"bar","labels":["North","South"],"series":[{"values":[420',
      ',310]}]}}',
      '\n```\n',
    ])
    expect(parts.map((part) => part.kind)).toEqual(['ui-draft', 'ui'])
    const draft = parts[0]
    const values = draft?.kind === 'ui-draft' && draft.render.tree.kind === 'chart'
      ? draft.render.tree.series[0]?.values
      : null
    expect(values).toEqual([420, 310])
  })

  it('does not send a tree twice, and not more often than the screen could show it', () => {
    const fence = new GenUiFence({ drafts: true, draftEveryMs: 100 })
    expect(fence.push('```genui\n{"title":"Team plan","tree":{"kind":"list","items":["eight', 0)).toHaveLength(1)
    // Half a word later, inside the interval: the tree moved, the wire waits.
    expect(fence.push(' seats"]}}', 50)).toEqual([])
    expect(fence.push('', 120)).toHaveLength(1)
    // The next tick has nothing new to say.
    expect(fence.push('', 240)).toEqual([])
  })

  it('draws no draft for a prefix that is not a tree yet', () => {
    const fence = new GenUiFence({ drafts: true, draftEveryMs: 0 })
    // The label has landed and the value has not: the schema refuses, so nothing is
    // drawn — a draft is the tree so far, not a guess at the rest of it.
    expect(fence.push('```genui\n{"tree":{"kind":"facts","entries":[{"label":"Rede"')).toEqual([])
    // The value arrives, and now there is a tree, a moment before the fence closes.
    expect(fence.push(',"value":"Longe"}]}}').map((part) => part.kind)).toEqual(['ui-draft'])
  })

  it('draws no draft unless the fence was asked for one', () => {
    const chunks = ['```genui\n{"tree":{"kind":"list","items":["a"', ',"b"]}}', '\n```\n']
    expect(run(chunks).map((part) => part.kind)).toEqual(['ui'])
  })
})

describe('what a turn that draws is told', () => {
  // The catalog is one text, and the fence that opens a block is in it: a block
  // arrives as text, so nothing else would say where the tree goes. The rules are
  // checked here against the schema elsewhere — this is the placing.
  it('carries the rules, the catalog and the fence', () => {
    for (const rule of [
      'The widget is built only from the catalog below',
      'write every string in English even when the person asks in another language',
      'never repeats a highlighted timeline event',
      'A `button` carries the message to send when it is pressed',
      'It is data, not code: there is no scripting',
    ]) {
      expect(GENUI_SECTION).toContain(rule)
    }
    expect(GENUI_SECTION).toContain('```genui')
  })
})
