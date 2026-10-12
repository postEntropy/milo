import type { ToolMark, TranscriptPart } from '../../../src/gateways/web/protocol.js'

/** A part of a turn together with the stable name it is drawn under. */
export interface KeyedPart {
  part: TranscriptPart
  key: string
}

/**
 * How one turn is drawn: every part as it is, except a run of calls that came
 * back to back, which becomes one `spine` — the thread with a dot per step. Each
 * step carries the name it is drawn under, so a step keeps its identity as the
 * turn streams instead of being known by where it happens to sit.
 */
export type ToolRow =
  | { kind: 'part'; part: TranscriptPart; key: string }
  | { kind: 'spine'; steps: Array<{ tool: ToolMark; key: string }>; key: string }

/**
 * Groups a turn's calls for drawing.
 *
 * Two or more calls in a row are one sequence and are drawn as a thread; a call
 * with anything else on either side of it is drawn as a line on its own. "In a
 * row" is meant literally: prose, a plan or a widget between two calls ends the
 * run, and so does a thought the surface is drawing — but a thought it is hiding
 * does not, because nothing of the model's stands between the two calls on screen.
 *
 * This lives here, over parts, rather than on the wire — because the parts are
 * the same either way. A turn streamed live is assembled by the page and a turn
 * read back from disk is assembled by the server, and both hand this the same
 * list; grouping at the protocol instead would mean deciding it twice and letting
 * the two drift, which is what a reopened session drawing differently from a live
 * one already was.
 *
 * `showReasoning` is whether the surface draws a thought at all, since a hidden
 * one is not on screen to end a run.
 */
export function toolRows(parts: KeyedPart[], showReasoning: boolean): ToolRow[] {
  const rows: ToolRow[] = []
  let run: Array<{ tool: ToolMark; key: string }> = []

  /** Closes the run being built: one call is a line, two or more are a thread. */
  const flush = (): void => {
    if (run.length === 1) rows.push({ kind: 'part', part: { kind: 'tool', tool: run[0]!.tool }, key: run[0]!.key })
    else if (run.length > 1) rows.push({ kind: 'spine', steps: run, key: run[0]!.key })
    run = []
  }

  for (const { part, key } of parts) {
    // A thought the surface is hiding is not on screen, so it neither draws nor
    // breaks a run: two calls with only a hidden thought between them are back to
    // back where the person is looking.
    if (part.kind === 'reasoning' && !showReasoning) continue
    if (part.kind === 'tool') {
      run.push({ tool: part.tool, key })
      continue
    }
    flush()
    rows.push({ kind: 'part', part, key })
  }
  flush()

  return rows
}
