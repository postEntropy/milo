import { z } from 'zod'

/**
 * The generated interface: the widget a turn draws beside its prose, written as a
 * fenced block inside the answer and lifted out of the stream before any surface
 * sees it.
 *
 * A tree of primitives, not code. The model writes data — boxes, tables, a
 * slider and the arithmetic over it — and the surface draws that data with its
 * own components. There is no expression language to run and nothing to sandbox:
 * the model can describe an interface, never a program.
 *
 * The catalog is deliberately small and bound to the app's own tokens (sizes,
 * spacing steps), so a generated interface looks like the rest of the product
 * rather than like a web page dropped into it. Anything outside the catalog is
 * refused by the schema and reported back, the way an unknown property is.
 */

/** The heading sizes a `title` may ask for — the app's own type scale. */
export const GENUI_TITLE_SIZES = ['sm', 'md', 'lg', 'xl'] as const
/** The spacing steps a `box` may use — the 4px scale the interface is built on. */
export const GENUI_SCALES = [1, 2, 3, 4] as const

export type GenUiTitleSize = (typeof GENUI_TITLE_SIZES)[number]
export type GenUiScale = (typeof GENUI_SCALES)[number]

/** A layout container: a row or a column of other nodes. */
export interface GenUiBox {
  kind: 'box'
  direction?: 'row' | 'column'
  gap?: GenUiScale
  padding?: GenUiScale
  children: GenUiNode[]
}

/** A heading. */
export interface GenUiTitle {
  kind: 'title'
  text: string
  size?: GenUiTitleSize
}

/** A paragraph. `{id}` interpolates an input's current value. */
export interface GenUiText {
  kind: 'text'
  text: string
}

/**
 * A number derived from the inputs, recomputed as they move. `formula` is
 * arithmetic over input ids (`seats * 29`), evaluated by the surface — never by
 * the model and never with `eval`.
 */
export interface GenUiStat {
  kind: 'stat'
  label: string
  formula: string
  prefix?: string
  suffix?: string
  decimals?: number
}

/** A table: fixed columns, one row per inner array. */
export interface GenUiTable {
  kind: 'table'
  columns: string[]
  rows: string[][]
}

/** A bulleted list. */
export interface GenUiList {
  kind: 'list'
  items: string[]
}

/** A slider the person drags; its value is available to `stat` and `text`. */
export interface GenUiSlider {
  kind: 'slider'
  id: string
  label: string
  min: number
  max: number
  step?: number
  value: number
  prefix?: string
  suffix?: string
}

/** A number field. */
export interface GenUiNumber {
  kind: 'number'
  id: string
  label: string
  value: number
  min?: number
  max?: number
  prefix?: string
  suffix?: string
}

/** A checkbox; its value is 1 or 0 in a formula. */
export interface GenUiCheckbox {
  kind: 'checkbox'
  id: string
  label: string
  value?: boolean
}

/** A choice among fixed options. */
export interface GenUiSelect {
  kind: 'select'
  id: string
  label: string
  options: string[]
  value: string
}

/**
 * A control that answers the model: pressing it sends `send` as a new message,
 * built from the state the person set. The only way an interface speaks back.
 */
export interface GenUiButton {
  kind: 'button'
  label: string
  send: string
}

/** One step of an ordered procedure: the title is the act, the detail is one line. */
export interface GenUiStep {
  title: string
  detail?: string
}

/** A procedure in order — what to do, and in what order. */
export interface GenUiSteps {
  kind: 'steps'
  title?: string
  entries: GenUiStep[]
}

/** One label-and-value pair. */
export interface GenUiFact {
  label: string
  value: string
}

/** A short set of key figures, meant to be read at a glance. */
export interface GenUiFacts {
  kind: 'facts'
  title?: string
  entries: GenUiFact[]
}

export type GenUiNode =
  | GenUiBox
  | GenUiTitle
  | GenUiText
  | GenUiStat
  | GenUiTable
  | GenUiList
  | GenUiSteps
  | GenUiFacts
  | GenUiSlider
  | GenUiNumber
  | GenUiCheckbox
  | GenUiSelect
  | GenUiButton

/** One widget: an optional heading and the tree under it. */
export interface GenUiRender {
  title?: string
  tree: GenUiNode
}

/**
 * How a turn draws an interface: the model writes the tree as a fenced block
 * inside the answer, and the loop lifts it out of the stream before any surface
 * sees it. There is no tool and no second request — the widget rides the answer
 * it belongs to.
 *
 * The price of the round trip saved is the correction saved with it: a tool call
 * that came back malformed could be sent back with the schema's complaint and the
 * model could fix it in place, where a block the schema refuses is refused for
 * good, and the words show instead. So the teaching has to carry what the tool's
 * JSON Schema used to: the catalog, spelled out, and the example.
 */

/** The word in the fence that opens a block. */
export const GENUI_FENCE_TAG = 'genui'

/** A line that opens a block: three backticks, indented up to three spaces, then the tag. */
const GENUI_OPEN_RE = /^[ \t]{0,3}```genui[ \t]*\r?\n/m

/**
 * Whether the model's own words open a widget. One test, for the raw copy: a turn has
 * something the plain copy does not — worth a `Copy raw` beside it — exactly when this
 * is true of what it wrote, or when it reasoned, or when it called a tool.
 */
export function holdsGenUi(text: string): boolean {
  return GENUI_OPEN_RE.test(text)
}

/** How big a tree may get: a widget, not a page. */
const MAX_DEPTH = 8
const MAX_NODES = 80

const idSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]{0,31}$/, 'an id is a letter, then letters, digits or underscores')

const formulaSchema = z
  .string()
  .min(1)
  .max(140)
  .regex(/^[\dA-Za-z_+\-*/(). \t]+$/, 'a formula is numbers, input ids, + - * / and parentheses')

/**
 * A string the person reads, held to `max`: one that runs long is cut with an ellipsis
 * rather than refusing the tree. The caps below are about keeping a widget a glance, but
 * a model that writes a long line — a directory listing, a list of packages, a sentence
 * where a phrase was asked for — was losing the whole widget to one over-long cell, which
 * is the worse trade. The cut *is* the cap: `overwrite` runs after the checks and leaves
 * the schema the catalog sends on the wire untouched, so the shape stays readable as a
 * JSON Schema. The strings that are not read keep their strict limits: an `id` that is cut
 * keys nothing and a formula that is cut computes nothing, so those still refuse rather
 * than arrive quietly wrong.
 */
const shown = (max: number, min = 0): z.ZodType<string> =>
  z.string().min(min).overwrite((text) => (text.length > max ? `${text.slice(0, max - 1)}…` : text))

const labelSchema = shown(120, 1)
const scaleSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
const money = shown(12)

/** A JSON number, whole: `3.` is a number being written, not one that is finished. */
const NUMBER_RE = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/

const genUiNodeSchema: z.ZodType<GenUiNode> = z.lazy(() =>
  z.union([
    z.object({
      kind: z.literal('box'),
      direction: z.enum(['row', 'column']).optional(),
      gap: scaleSchema.optional(),
      padding: scaleSchema.optional(),
      children: z.array(genUiNodeSchema).min(1).max(24),
    }),
    z.object({ kind: z.literal('title'), text: labelSchema, size: z.enum(GENUI_TITLE_SIZES).optional() }),
    z.object({ kind: z.literal('text'), text: shown(600, 1) }),
    z.object({
      kind: z.literal('stat'),
      label: labelSchema,
      formula: formulaSchema,
      prefix: money.optional(),
      suffix: money.optional(),
      decimals: z.number().int().min(0).max(4).optional(),
    }),
    z.object({
      kind: z.literal('table'),
      // A name may be empty: the corner cell above a column of row labels has none,
      // and that table is the first one every model writes. Refusing it refuses the
      // whole widget over a cell that was never going to hold anything.
      columns: z.array(shown(60)).min(1).max(8),
      // A cell is a phrase, and one that runs longer is cut rather than refused: a
      // listing crammed into a cell is a long line, not a reason to lose the table.
      rows: z.array(z.array(shown(200)).max(8)).min(1).max(50),
    }),
    z.object({ kind: z.literal('list'), items: z.array(shown(200, 1)).min(1).max(24) }),
    z.object({
      kind: z.literal('steps'),
      title: shown(120, 1).optional(),
      entries: z
        .array(z.object({ title: shown(120, 1), detail: shown(240, 1).optional() }))
        .min(1)
        .max(12),
    }),
    z.object({
      kind: z.literal('facts'),
      title: shown(120, 1).optional(),
      entries: z
        // A pair is a name and what it says, and what it says is a clause: 60 refused
        // three of the four pairs a model wrote for a real question — each a sentence
        // that belonged there — and took the whole widget with them. The label is the
        // same label a `stat` carries; the value holds what a `list` item holds.
        .array(z.object({ label: labelSchema, value: shown(200, 1) }))
        .min(1)
        .max(12),
    }),
    z.object({
      kind: z.literal('slider'),
      id: idSchema,
      label: labelSchema,
      min: z.number().finite(),
      max: z.number().finite(),
      step: z.number().positive().optional(),
      value: z.number().finite(),
      prefix: money.optional(),
      suffix: money.optional(),
    }),
    z.object({
      kind: z.literal('number'),
      id: idSchema,
      label: labelSchema,
      value: z.number().finite(),
      min: z.number().finite().optional(),
      max: z.number().finite().optional(),
      prefix: money.optional(),
      suffix: money.optional(),
    }),
    z.object({ kind: z.literal('checkbox'), id: idSchema, label: labelSchema, value: z.boolean().optional() }),
    z.object({
      kind: z.literal('select'),
      id: idSchema,
      label: labelSchema,
      options: z.array(shown(60, 1)).min(1).max(12),
      value: shown(60),
    }),
    z.object({ kind: z.literal('button'), label: labelSchema, send: z.string().min(1).max(1000) }),
  ]),
)

/** The shape a widget arrives in, whatever carried it: a heading, and its tree. */
export const genUiSchema = z
  .object({
    title: shown(120, 1).optional(),
    tree: genUiNodeSchema,
  })
  .superRefine((value, ctx) => {
    const { nodes, depth } = measure(value.tree)
    if (nodes > MAX_NODES) {
      ctx.addIssue({ code: 'custom', message: `the tree has ${nodes} nodes; the most is ${MAX_NODES}` })
    }
    if (depth > MAX_DEPTH) {
      ctx.addIssue({ code: 'custom', message: `the tree is ${depth} levels deep; the most is ${MAX_DEPTH}` })
    }
  })

export type GenUiArgs = z.infer<typeof genUiSchema>

/** How many nodes a tree holds, and how deep it goes. */
function measure(node: GenUiNode, depth = 1): { nodes: number; depth: number } {
  if (node.kind !== 'box') return { nodes: 1, depth }
  let nodes = 1
  let deepest = depth
  for (const child of node.children) {
    const inner = measure(child, depth + 1)
    nodes += inner.nodes
    deepest = Math.max(deepest, inner.depth)
  }
  return { nodes, depth: deepest }
}

/**
 * A widget out of a tree that reached us as data — the JSON a block carried, or
 * the arguments of a session stored while a turn could draw by calling a tool —
 * checked rather than trusted: a transcript is read back from disk, so a tree that
 * is no longer the shape it was written as is dropped instead of drawn broken. The
 * same rule `todosFromArgs` and the panel's own reader follow.
 */
export function genUiFromArgs(args: unknown): GenUiRender | null {
  const parsed = genUiSchema.safeParse(args)
  if (!parsed.success) return null
  const title = parsed.data.title?.trim()
  return { ...(title ? { title } : {}), tree: parsed.data.tree }
}

/**
 * A widget out of the body of a block. The body is model text, so it fails the
 * way text fails: whatever is not a tree the schema accepts is refused, and the
 * caller is left holding the words rather than a broken widget.
 */
export function genUiFromBlock(body: string): GenUiRender | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body.trim())
  } catch {
    return null
  }
  return genUiFromArgs(parsed)
}

/**
 * A widget out of a block still being written — the same tree, read while it streams.
 *
 * The text handed here is a strict prefix of what the model will write, and this only
 * ever cuts it short and closes what it left open: it never repairs a character, moves
 * a bracket or invents a value. So a draft is a prefix of the tree that is coming, drawn
 * because the schema accepted it — never a guess at what the model means. A prefix that
 * cannot be one (a `facts` entry whose value has not arrived, a number written up to its
 * decimal point) is refused like any other bad tree, and the next token tries again.
 */
export function genUiFromPartial(body: string): GenUiRender | null {
  const scan = scanJson(body)
  // The whole of it first: a value caught mid-word is more than a value not begun.
  const whole = scan.openString ? `${body}"${closersFor(scan.opens)}` : body + closersFor(scan.opens)
  for (const candidate of [whole, `${body.slice(0, scan.cut)}${closersFor(scan.cutOpens)}`]) {
    const render = genUiFromBlock(candidate)
    if (render) return render
  }
  return null
}

/** What a prefix of JSON left open, and where its last finished value ended. */
interface JsonScan {
  /** The brackets still open, outermost first. */
  opens: string[]
  /** Whether the text stops part-way through a string. */
  openString: boolean
  /** Where the last complete value ended, and what was open at that point. */
  cut: number
  cutOpens: string[]
}

/** The brackets that would shut what `scanJson` found open. */
function closersFor(opens: string[]): string {
  return opens
    .map((open) => (open === '{' ? '}' : ']'))
    .reverse()
    .join('')
}

/**
 * Reads a prefix of JSON as far as it goes: strings, escapes, the brackets still open,
 * and the offset just past the last value that finished. A string followed by a colon is
 * a key — a key is not a value, so it does not mark a place the text could be cut — and a
 * number or keyword only counts once it is the whole of one.
 */
function scanJson(text: string): JsonScan {
  const opens: string[] = []
  let cut = 0
  let cutOpens: string[] = []
  let inString = false
  let escaped = false
  let at = 0
  while (at < text.length) {
    const char = text[at]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') {
        inString = false
        if (!/^[ \t\r\n]*:/.test(text.slice(at + 1))) {
          cut = at + 1
          cutOpens = [...opens]
        }
      }
      at += 1
      continue
    }
    if (char === '"') { inString = true; at += 1; continue }
    if (char === '{' || char === '[') { opens.push(char); at += 1; continue }
    if (char === '}' || char === ']') {
      opens.pop()
      cut = at + 1
      cutOpens = [...opens]
      at += 1
      continue
    }
    const token = /^[A-Za-z0-9_.+-]+/.exec(text.slice(at))?.[0]
    if (token && (NUMBER_RE.test(token) || token === 'true' || token === 'false' || token === 'null')) {
      cut = at + token.length
      cutOpens = [...opens]
      at += token.length
      continue
    }
    at += 1
  }
  return { opens, openString: inString, cut, cutOpens }
}

/**
 * The widget as plain text: what goes back to the model as the tool's result, and
 * the form a surface that cannot draw one would fall back to. Derived values are
 * shown as the formula that produces them, since only the surface holds the
 * inputs the formula reads.
 */
export function genUiMarkdown(render: GenUiRender): string {
  const lines: string[] = []
  if (render.title) lines.push(`## ${render.title}`, '')
  writeNode(render.tree, 0, lines)
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

function writeNode(node: GenUiNode, indent: number, lines: string[]): void {
  const pad = '  '.repeat(indent)
  if (node.kind === 'box') {
    for (const child of node.children) {
      writeNode(child, indent, lines)
      lines.push('')
    }
    return
  }
  if (node.kind === 'title') {
    lines.push(`${pad}### ${node.text}`)
    return
  }
  if (node.kind === 'text') {
    lines.push(`${pad}${node.text}`)
    return
  }
  if (node.kind === 'stat') {
    lines.push(`${pad}**${node.label}:** ${node.prefix ?? ''}(${node.formula})${node.suffix ?? ''}`)
    return
  }
  if (node.kind === 'list') {
    for (const item of node.items) lines.push(`${pad}- ${item}`)
    return
  }
  if (node.kind === 'steps') {
    if (node.title) lines.push(`${pad}**${node.title}**`, '')
    node.entries.forEach((entry, index) => {
      lines.push(`${pad}${index + 1}. **${entry.title}**${entry.detail ? ` — ${entry.detail}` : ''}`)
    })
    return
  }
  if (node.kind === 'facts') {
    if (node.title) lines.push(`${pad}**${node.title}**`, '')
    for (const entry of node.entries) lines.push(`${pad}- **${entry.label}:** ${entry.value}`)
    return
  }
  if (node.kind === 'table') {
    lines.push(`${pad}| ${node.columns.join(' | ')} |`)
    lines.push(`${pad}| ${node.columns.map(() => '---').join(' | ')} |`)
    for (const row of node.rows) lines.push(`${pad}| ${node.columns.map((_, index) => row[index] ?? '').join(' | ')} |`)
    return
  }
  if (node.kind === 'button') {
    lines.push(`${pad}[${node.label}]`)
    return
  }
  // The inputs: their label and the value they start at, which is all a text form
  // can say about a control the person is meant to move.
  if (node.kind === 'checkbox') lines.push(`${pad}- ${node.label}: ${node.value ? 'yes' : 'no'}`)
  else if (node.kind === 'select') lines.push(`${pad}- ${node.label}: ${node.value}`)
  else lines.push(`${pad}- ${node.label}: ${node.prefix ?? ''}${node.value}${node.suffix ?? ''}`)
}

/**
 * The rules, one text, told once — and the only catalog a turn that draws is taught.
 *
 * They were once the same text under two frames, `render_ui`'s description and the
 * block's instruction, which is what let the two transports be compared. That
 * comparison is over: the round trip a tool call cost was the whole of the
 * difference, and the block does not pay it. What is left is the teaching.
 */
const GENUI_RULES = [
  'How an answer is shown is part of writing it: prose carries the sentences, and an answer whose shape is the point is drawn rather than described. A procedure, a comparison, a schedule, a set of options, figures worth reading at a glance — the widget is how those arrive.',
  'It arrives on an ordinary question, unasked: steps to follow, two things side by side, a plan, a set of options, figures worth reading at a glance. A single fact, a greeting, a passing mention or a short explanation stays prose, and a widget is never drawn to decorate a sentence that was already the answer.',
  'Keep it to a glance rather than a page: a table of the few rows actually being compared, not every row you could write. What does not fit is prose — which is where that detail reads better anyway — and a widget nobody can take in at once is not doing the job it was drawn for.',
  'The widget is built only from the catalog below: layout boxes, titles, text, tables, lists, an ordered procedure (`steps`), label-and-value facts (`facts`), a derived number (`stat`), the inputs (slider, number, checkbox, select) and one button.',
  'The inputs are for a calculation the person should be able to move. Every input has an `id`; a `stat` computes from those ids with a plain formula like `seats * 29`, and a `text` or a button message may show a value with `{id}`. The surface recomputes them as things move — no further call is made to you, so the arithmetic must be right when you write it.',
  'A `button` carries the message to send when it is pressed; `{id}` in it is filled with the value the person set, so build that message from the state.',
  'It is data, not code: there is no scripting, no styling and no node outside the catalog.',
  'The widget is the answer, not an illustration of it — keep the prose short, and do not say again in words what the widget already shows. Prose and widgets interleave, and more than one is right when the answer truly has parts, but each has to earn its place.',
]

/**
 * The worked example, written the way it should be written rather than the way it is
 * cheapest to print. It used to be one line, and a model imitates what it is shown: at
 * the size a real comparison reaches — a table of six or seven rows — one line is nine
 * hundred characters with no shape in it, and both models this was measured on dropped
 * a bracket in one run in three. The parser reads either; the model writes this one.
 */
const GENUI_EXAMPLE = [
  '{',
  '  "title": "Sunday roast, six people",',
  '  "tree": {',
  '    "kind": "box",',
  '    "direction": "column",',
  '    "gap": 3,',
  '    "children": [',
  '      {',
  '        "kind": "facts",',
  '        "entries": [',
  '          { "label": "Eat at", "value": "5:00 pm" },',
  '          { "label": "Oven", "value": "2 h 30" },',
  '          { "label": "Lamb", "value": "2.4 kg" }',
  '        ]',
  '      },',
  '      {',
  '        "kind": "steps",',
  '        "entries": [',
  '          { "title": "Prep ahead", "detail": "Crumble, marinade and table the night before." },',
  '          { "title": "Start roasting", "detail": "Preheat and roast the lamb — a thermometer, not the clock." },',
  '          { "title": "Sides", "detail": "Parboil the potatoes and rough up their edges." },',
  '          { "title": "Rest the lamb", "detail": "40 minutes covered, which frees the oven for the potatoes." },',
  '          { "title": "Serve", "detail": "Gravy, greens, and the crumble back in the warm oven." }',
  '        ]',
  '      }',
  '    ]',
  '  }',
  '}',
].join('\n')

const GENUI_CLOSER =
  'Nothing there was asked for as a UI: the question was an ordinary one, and the shape is the answer.'

/**
 * The teaching, as its own section of the system prompt, and the only place it is
 * told. The field list stands in for the JSON Schema the tool used to carry: a
 * block arrives as text, so without it the catalog would be a guess.
 * `genui-fence.test.ts` holds it against the schema — every kind the schema
 * accepts is named here, and no other.
 */
export const GENUI_SECTION = [
  '## Generated interfaces',
  'An answer whose shape is the point is drawn, not described. Write the interface as a block in the answer, where it belongs: the word `genui` in a fence, the tree as JSON, a closing fence.',
  ...GENUI_RULES,
  'The nodes and their fields, exactly:',
  '- `box`: `direction` ("row" or "column"), `gap` and `padding` (1 to 4, on the 4px scale), `children` — at most 24.',
  '- `title`: `text`, and `size` ("sm", "md", "lg" or "xl").',
  '- `text`: `text` — a `{id}` in it shows that input\'s current value.',
  '- `stat`: `label` and `formula`, and optionally `prefix`, `suffix`, `decimals`.',
  '- `table`: `columns` (at most 8) and `rows` — one array of cell strings per row, at most 50. A cell is a phrase, not a sentence: the detail that does not fit belongs in the prose beside it.',
  '- `list`: `items`, at most 24. An item is a line, not a paragraph.',
  '- `steps`: an optional `title`, and `entries` — `{title, detail?}`, at most 12.',
  '- `facts`: an optional `title`, and `entries` — `{label, value}`, at most 12.',
  '- `slider`: `id`, `label`, `min`, `max`, `value`, and optionally `step`, `prefix`, `suffix`.',
  '- `number`: `id`, `label`, `value`, and optionally `min`, `max`, `prefix`, `suffix`.',
  '- `checkbox`: `id`, `label`, and an optional `value`.',
  '- `select`: `id`, `label`, `options` (at most 12) and `value`.',
  '- `button`: `label` and `send`.',
  'A tree holds at most 80 nodes and goes at most 8 levels deep. A block that does not match this is refused, and its words show in the answer instead of a widget — which is why the JSON has to be exactly this shape.',
  'For example, asked "how should I time a Sunday roast for six?", the block is:',
  '',
  '```genui',
  GENUI_EXAMPLE,
  '```',
  '',
  GENUI_CLOSER,
].join('\n')
