import type { TranscriptPart } from '@protocol'

/**
 * The parts of a turn that draws.
 *
 * A block is written where the prose is, so its widget arrives while the words around
 * it are still coming — and it arrives many times over, each time a longer prefix of
 * the same tree. Keeping that one widget drawn growing, rather than a pile of widgets
 * left behind it, is what these rules are for. Every one of them is about a part that
 * is still a draft: `draft` is set on a widget the model has not finished writing.
 */

/** Where the block being written has left its draft: -1 when there is none. */
export function draftAt(parts: TranscriptPart[]): number {
  for (let at = parts.length - 1; at >= 0; at -= 1) {
    const part = parts[at]!
    if (part.kind === 'ui') return part.draft ? at : -1
  }
  return -1
}

/**
 * Adds a widget to a turn. A draft takes the place of the draft before it, and the
 * finished tree takes the place of the draft it grew out of, because they are the same
 * widget at different moments — only a block after a finished one is another widget.
 */
export function withWidget(parts: TranscriptPart[], part: TranscriptPart): TranscriptPart[] {
  const at = draftAt(parts)
  return at === -1 ? [...parts, part] : [...parts.slice(0, at), part, ...parts.slice(at + 1)]
}

/**
 * Appends a token to the trailing prose part, or opens a new one.
 *
 * A fence lets nothing out of an open block but its drafts, so words arriving mean that
 * block was not a widget after all — the schema refused it, and its own text is what
 * follows. The draft goes with it rather than sitting above the words it is not.
 */
export function appendText(parts: TranscriptPart[], delta: string): TranscriptPart[] {
  const at = draftAt(parts)
  const kept = at === -1 ? parts : [...parts.slice(0, at), ...parts.slice(at + 1)]
  const last = kept[kept.length - 1]
  return last?.kind === 'text'
    ? [...kept.slice(0, -1), { ...last, text: last.text + delta }]
    : [...kept, { kind: 'text', text: delta }]
}

/** The same for a thought, so a turn's reasoning stays one block per step. */
export function appendReasoning(parts: TranscriptPart[], delta: string): TranscriptPart[] {
  const last = parts[parts.length - 1]
  return last?.kind === 'reasoning'
    ? [...parts.slice(0, -1), { ...last, text: last.text + delta }]
    : [...parts, { kind: 'reasoning', text: delta }]
}

/** A token waiting for the next frame, and the channel it arrived on. */
export interface PendingDelta {
  kind: 'text' | 'reasoning'
  delta: string
}

/**
 * Gathers a token into the batch a frame will draw, keeping the order it arrived
 * in. A thought and the first words of the answer can land in the same batch —
 * gathering them per channel would lose which came first and put the thought
 * after words it came before, cutting the sentence around it.
 */
export function withDelta(batch: readonly PendingDelta[], kind: PendingDelta['kind'], delta: string): PendingDelta[] {
  const last = batch[batch.length - 1]
  return last?.kind === kind
    ? [...batch.slice(0, -1), { kind, delta: last.delta + delta }]
    : [...batch, { kind, delta }]
}

/** Draws one frame's tokens into a turn, in the order they arrived. */
export function appendDeltas(parts: TranscriptPart[], batch: readonly PendingDelta[]): TranscriptPart[] {
  let next = parts
  for (const token of batch) {
    next = token.kind === 'reasoning' ? appendReasoning(next, token.delta) : appendText(next, token.delta)
  }
  return next
}
