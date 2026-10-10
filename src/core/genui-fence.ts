import { GENUI_FENCE_TAG, genUiFromBlock, genUiFromPartial, type GenUiRender } from './genui.js'

/**
 * A piece of an answer, once the widgets have been separated from the words:
 * prose to read, a widget to draw, the same widget drawn while it is still being
 * written, or a block that was meant to be one and is handed back as text instead.
 */
export type GenUiFencePart =
  | { kind: 'text'; text: string }
  | { kind: 'ui'; render: GenUiRender }
  | { kind: 'ui-draft'; render: GenUiRender }
  | { kind: 'refused'; text: string }

export interface GenUiFenceOptions {
  /**
   * Draw the tree as the model writes it, instead of holding it whole until the fence
   * closes. Off by default: reading a stored session back should draw the widget it
   * ended up with, not the seventeen drafts it passed through.
   */
  drafts?: boolean
  /** How often a draft may leave, in milliseconds. */
  draftEveryMs?: number
}

/** Ten trees a second: enough to watch it fill in, not enough to flood the wire. */
const DRAFT_EVERY_MS = 100

const OPEN = `\`\`\`${GENUI_FENCE_TAG}`
/** A fence is a line of it, indented up to three spaces, which is what markdown allows. */
const OPEN_RE = /^[ \t]{0,3}```genui[ \t]*\r?\n/m
/**
 * The closer, wherever it is. Markdown wants one on a line of its own, but a model
 * appends it to the last line of the tree often enough — `…}]}}` ``` `` — to be worth
 * forgiving: after an opening fence there is nothing else three backticks can be. The
 * cost is the one case where the tree itself holds a fence, which cuts the block short
 * and shows the rest as prose: the words are still there, and a widget was never going
 * to have one.
 */
const CLOSE_RE = /```/

/**
 * Splits an answer's text stream into what to read and what to draw.
 *
 * A block is written where the prose is, so the two have to come apart before a
 * surface sees either — and they arrive a token at a time, which is what makes
 * this more than a `split`. Two moments need care, and both are about a fence
 * arriving in pieces: a tail that could still become an opening fence is held
 * back rather than shown and then taken away, and a block is held whole until its
 * closing fence lands, because half a JSON object is not a widget.
 *
 * Nothing is dropped. A block that closes over something the schema does not
 * accept, and one that never closes at all, come back as `refused` carrying their
 * own words — the model's text is the model's text even when it cannot be drawn.
 *
 * While a block is open and drafts are asked for, the tree so far leaves as
 * `ui-draft`: a prefix of the block, read by the schema, so a surface can fill the
 * widget in as it is written. Nothing else leaves an open block, which is what lets
 * a surface treat the next `ui` as the finished one and any words as a refusal.
 */
export class GenUiFence {
  /** Text not yet given out: a held-back fence tail, or a block still open. */
  private held = ''
  private inside = false
  /** The last tree drafted, and when, so the same one is not sent an inch at a time. */
  private drafted = ''
  private draftedAt = Number.NEGATIVE_INFINITY
  private readonly drafts: boolean
  private readonly draftEveryMs: number

  constructor(options: GenUiFenceOptions = {}) {
    this.drafts = options.drafts ?? false
    this.draftEveryMs = options.draftEveryMs ?? DRAFT_EVERY_MS
  }

  /** The parts this chunk of the answer produced. */
  push(delta: string, now = Date.now()): GenUiFencePart[] {
    this.held += delta
    const parts: GenUiFencePart[] = []
    for (;;) {
      if (this.inside) {
        const close = CLOSE_RE.exec(this.held)
        // Nothing leaves a block until its fence does — except the tree so far.
        if (!close) {
          const draft = this.draft(now)
          if (draft) parts.push(draft)
          return parts
        }
        const body = this.held.slice(0, close.index)
        const lineEnd = this.held.indexOf('\n', close.index)
        this.held = lineEnd === -1 ? '' : this.held.slice(lineEnd + 1)
        this.inside = false
        parts.push(draw(body))
        continue
      }
      const open = OPEN_RE.exec(this.held)
      if (!open) {
        const keep = holdBack(this.held)
        const emit = this.held.slice(0, this.held.length - keep)
        if (emit) parts.push({ kind: 'text', text: emit })
        this.held = this.held.slice(this.held.length - keep)
        return parts
      }
      const before = this.held.slice(0, open.index)
      if (before) parts.push({ kind: 'text', text: before })
      this.held = this.held.slice(open.index + open[0].length)
      this.inside = true
      this.drafted = ''
      this.draftedAt = Number.NEGATIVE_INFINITY
    }
  }

  /** What is left when the answer ends: a tail held back, or a block still open. */
  finish(): GenUiFencePart[] {
    const held = this.held
    this.held = ''
    this.drafted = ''
    if (!held) return []
    if (!this.inside) return [{ kind: 'text', text: held }]
    this.inside = false
    return [{ kind: 'refused', text: asCodeBlock(held) }]
  }

  /** The tree as far as it has been written, if it has moved on since the last one. */
  private draft(now: number): GenUiFencePart | null {
    if (!this.drafts || now - this.draftedAt < this.draftEveryMs) return null
    const render = genUiFromPartial(this.held)
    if (!render) return null
    const written = JSON.stringify(render)
    if (written === this.drafted) return null
    this.drafted = written
    this.draftedAt = now
    return { kind: 'ui-draft', render }
  }
}

/** A closed block: the widget it describes, or its own words back. */
function draw(body: string): GenUiFencePart {
  const render = genUiFromBlock(body)
  return render ? { kind: 'ui', render } : { kind: 'refused', text: asCodeBlock(body) }
}

/**
 * A block that could not be drawn, given back as the code block it looked like —
 * so an undrawable tree reads as prose that failed, not as a widget that quietly
 * did not appear.
 */
function asCodeBlock(body: string): string {
  return `\`\`\`\n${body.trim()}\n\`\`\`\n`
}

/**
 * How much of the tail is held back: a line that could still turn into an opening
 * fence. It is held rather than shown because a fence split across two chunks —
 * three backticks now, the tag a moment later — must never be printed as prose and
 * then taken away.
 */
function holdBack(held: string): number {
  const lineStart = held.lastIndexOf('\n') + 1
  const tail = held.slice(lineStart)
  const body = tail.replace(/^[ \t]{0,3}/, '').replace(/[ \t]+$/, '')
  return OPEN.startsWith(body) ? tail.length : 0
}
