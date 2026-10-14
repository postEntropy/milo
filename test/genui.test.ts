import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { GENUI_SECTION, genUiFromArgs, genUiFromPartial, genUiMarkdown, genUiSchema } from '../src/core/genui.js'

describe('the generated interface schema', () => {
  it('accepts a widget built from the catalog', () => {
    const result = genUiSchema.safeParse({
      title: 'Team plan',
      tree: {
        kind: 'box',
        direction: 'column',
        gap: 2,
        children: [
          { kind: 'title', text: 'Team plan estimate' },
          { kind: 'slider', id: 'seats', label: 'Seats', min: 1, max: 50, value: 8 },
          { kind: 'stat', label: 'Monthly', formula: 'seats * 29', prefix: '$', suffix: '/mo' },
        ],
      },
    })
    expect(result.success).toBe(true)
  })

  it('accepts an ordered procedure and a set of facts, the two shapes an ordinary answer wants', () => {
    const result = genUiSchema.safeParse({
      tree: {
        kind: 'box',
        children: [
          { kind: 'facts', entries: [{ label: 'Eat at', value: '5:00 pm' }] },
          { kind: 'steps', entries: [{ title: 'Prep ahead', detail: 'The night before.' }, { title: 'Serve' }] },
        ],
      },
    })
    expect(result.success).toBe(true)
  })

  it('refuses a procedure with no steps, a step with no title, or a fact with no value', () => {
    expect(genUiSchema.safeParse({ tree: { kind: 'steps', entries: [] } }).success).toBe(false)
    expect(genUiSchema.safeParse({ tree: { kind: 'steps', entries: [{ detail: 'no title' }] } }).success).toBe(false)
    expect(genUiSchema.safeParse({ tree: { kind: 'facts', entries: [{ label: 'Eat at' }] } }).success).toBe(false)
  })

  it('refuses a node that is not in the catalog', () => {
    expect(genUiSchema.safeParse({ tree: { kind: 'iframe', src: 'https://example.com' } }).success).toBe(false)
  })

  it('refuses a formula that is not arithmetic', () => {
    const result = genUiSchema.safeParse({ tree: { kind: 'stat', label: 'x', formula: 'fetch("/etc/passwd")' } })
    expect(result.success).toBe(false)
  })

  it('refuses a tree that is past the node budget', () => {
    const group = { kind: 'box', children: Array.from({ length: 4 }, (_, index) => ({ kind: 'text', text: `t${index}` })) }
    const tree = { kind: 'box', children: Array.from({ length: 24 }, () => group) }
    expect(genUiSchema.safeParse({ tree }).success).toBe(false)
  })

  it('refuses a tree that is deeper than it may be', () => {
    let tree: Record<string, unknown> = { kind: 'text', text: 'bottom' }
    for (let level = 0; level < 10; level += 1) tree = { kind: 'box', children: [tree] }
    expect(genUiSchema.safeParse({ tree }).success).toBe(false)
  })

  it('cuts a cell or an item that runs long instead of refusing the whole widget', () => {
    // A listing crammed into a cell — the shape a directory inventory makes — used to
    // take the widget down with it. It is cut now, so the table still draws.
    const long = 'a'.repeat(300)
    const cut = `${'a'.repeat(199)}…`
    const parsed = genUiSchema.safeParse({
      tree: {
        kind: 'box',
        children: [
          { kind: 'table', columns: ['Folder', 'Holds'], rows: [['02-agentes', long]] },
          { kind: 'list', items: [long] },
        ],
      },
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    const tree = parsed.data.tree
    if (tree.kind !== 'box') throw new Error('expected a box back')
    const [table, list] = tree.children
    expect(table?.kind === 'table' && table.rows[0]?.[1]).toBe(cut)
    expect(list?.kind === 'list' && list.items[0]).toBe(cut)
  })
})

describe('reading a widget back out of a tool call', () => {
  it('checks the tree rather than trusting it', () => {
    expect(genUiFromArgs({ tree: { kind: 'title', text: 'hi' } })).toEqual({ tree: { kind: 'title', text: 'hi' } })
    expect(genUiFromArgs({ tree: { kind: 'wat' } })).toBeNull()
    expect(genUiFromArgs(null)).toBeNull()
  })

  it('keeps a heading, trimmed, and leaves it out when it is blank', () => {
    expect(genUiFromArgs({ title: '  Plan  ', tree: { kind: 'title', text: 'hi' } })?.title).toBe('Plan')
    expect(genUiFromArgs({ title: '   ', tree: { kind: 'title', text: 'hi' } })).toEqual({ tree: { kind: 'title', text: 'hi' } })
  })
})

describe('a widget as text', () => {
  it('renders a table and a derived number, so the model reads back what it asked to show', () => {
    const markdown = genUiMarkdown({
      title: 'Team plan',
      tree: {
        kind: 'box',
        children: [
          { kind: 'table', columns: ['Guests', 'Lamb'], rows: [['4', '3-4 lb']] },
          { kind: 'stat', label: 'Total', formula: 'seats * 29', suffix: '/mo' },
        ],
      },
    })
    expect(markdown).toContain('## Team plan')
    expect(markdown).toContain('| Guests | Lamb |')
    expect(markdown).toContain('| 4 | 3-4 lb |')
    expect(markdown).toContain('**Total:** (seats * 29)/mo')
  })

  it('says what an input starts at', () => {
    const markdown = genUiMarkdown({ tree: { kind: 'slider', id: 'seats', label: 'Seats', min: 1, max: 50, value: 8, suffix: ' seats' } })
    expect(markdown).toBe('- Seats: 8 seats')
  })

  it('numbers a procedure, and lists the facts as label and value', () => {
    const markdown = genUiMarkdown({
      tree: {
        kind: 'box',
        children: [
          { kind: 'facts', entries: [{ label: 'Eat at', value: '5:00 pm' }] },
          { kind: 'steps', entries: [{ title: 'Prep ahead', detail: 'The night before.' }, { title: 'Serve' }] },
        ],
      },
    })
    expect(markdown).toContain('- **Eat at:** 5:00 pm')
    expect(markdown).toContain('1. **Prep ahead** — The night before.')
    expect(markdown).toContain('2. **Serve**')
  })
})

/**
 * A widget read while the model is still writing it: the text is a prefix, so every
 * draft has to be the tree so far and nothing the model has not said.
 */
describe('a widget read while it is still being written', () => {
  const full =
    '{"title":"AC × DC","tree":{"kind":"box","direction":"column","gap":3,"children":[' +
    '{"kind":"table","columns":["Aspecto","AC","DC"],"rows":[["Fluxo","Inverte","Um sentido"],["Forma","Senoide","Reta"]]},' +
    '{"kind":"facts","entries":[{"label":"Rede","value":"Viaja longe"}]}]}}'

  it('draws the tree as far as it has been written, no further', () => {
    const render = genUiFromPartial(full.slice(0, full.indexOf('"Reta"') + 7))
    expect(render?.title).toBe('AC × DC')
    const table = render?.tree.kind === 'box' ? render.tree.children[0] : undefined
    expect(table?.kind === 'table' ? table.rows : []).toHaveLength(2)
  })

  it('keeps the value it caught mid-word, rather than waiting for the word', () => {
    const render = genUiFromPartial(full.slice(0, full.indexOf('"Reta"') + 4))
    const table = render?.tree.kind === 'box' ? render.tree.children[0] : undefined
    // The word arrives a letter at a time, and the draft says what has arrived.
    expect(table?.kind === 'table' ? table.rows[1] : []).toEqual(['Forma', 'Senoide', 'Ret'])
  })

  it('drops the comma and the node it was still writing', () => {
    const render = genUiFromPartial(`${full.slice(0, full.lastIndexOf('}'))},`)
    const entries = render?.tree.kind === 'box' ? render.tree.children[1] : undefined
    expect(entries?.kind === 'facts' ? entries.entries : []).toEqual([{ label: 'Rede', value: 'Viaja longe' }])
  })

  it('refuses a prefix that is not a tree yet instead of inventing one', () => {
    // The kind and the entries of a fact, with the `value` still to come: drawing this
    // would mean making up the half the model has not written.
    const withoutValue = full.slice(0, full.lastIndexOf('"value"'))
    expect(genUiFromPartial(withoutValue)).toBeNull()
    // A number caught at its decimal point is not a number, and a slider needs one.
    expect(genUiFromPartial('{"tree":{"kind":"slider","id":"seats","label":"Seats","min":1,"value":8.')).toBeNull()
  })

  it('draws nothing out of something that was never JSON', () => {
    expect(genUiFromPartial('Corrente alternada e corrente contínua')).toBeNull()
    expect(genUiFromPartial('')).toBeNull()
  })
})


function examplesIn(description: string): unknown[] {
  const found: unknown[] = []
  let from = 0
  for (;;) {
    const open = /^[ \t]*\{/m.exec(description.slice(from))
    if (!open) return found
    const start = from + open.index + open[0].length - 1
    const parsed = readObject(description, start)
    if (!parsed) return found
    found.push(parsed.value)
    from = parsed.end
  }
}

/** The object that starts at `start`, and where it ends, walking strings properly. */
function readObject(text: string, start: number): { value: unknown; end: number } | null {
  let depth = 0
  let inString = false
  let escaped = false
  for (let at = start; at < text.length; at += 1) {
    const char = text[at]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{' || char === '[') depth += 1
    else if (char === '}' || char === ']') {
      depth -= 1
      if (depth === 0) {
        const slice = text.slice(start, at + 1)
        try {
          return { value: JSON.parse(slice), end: at + 1 }
        } catch {
          return null
        }
      }
    }
  }
  return null
}

describe('the examples in the instructions', () => {
  const description = GENUI_SECTION
  const examples = examplesIn(description)

  it('are all read: the reader finds one per tree the description carries', () => {
    // A guard that reads nothing guards nothing. Each example starts at `{"title":`,
    // so the count the reader finds has to match the number of `tree`s the
    // description carries — an example it cannot find would fail this.
    const trees = (description.match(/"tree":/g) ?? []).length
    expect(examples.length).toBeGreaterThan(0)
    expect(examples).toHaveLength(trees)
  })

  it('are trees the schema accepts, so the teaching cannot show one it refuses', () => {
    for (const example of examples) {
      expect(genUiSchema.safeParse(example).success).toBe(true)
    }
  })
})

describe('the catalog a turn that draws is taught', () => {
  it('names every kind the schema accepts, and no kind it would refuse', () => {
    // Read off the schema itself, through the same `z.toJSONSchema` the registry
    // sends a tool's catalog to the wire with — so the list the prose is held
    // against is the one the model is held to, not a copy of it here.
    const wire = z.toJSONSchema(genUiSchema) as unknown as { $defs: Record<string, { anyOf: { properties: { kind: { const: string } } }[] }> }
    const [node] = Object.values(wire.$defs)
    const accepted = node.anyOf.map((member) => member.properties.kind.const)
    const named = [...GENUI_SECTION.matchAll(/^- `([a-z]+)`:/gm)].map((match) => match[1])
    // Both directions, in the same order. A kind the prose leaves out is one the
    // model cannot know it may write; one named that the schema refuses is a tree
    // it will write and have thrown away — which is the failure this stands over.
    expect(named).toEqual(accepted)
  })
})
