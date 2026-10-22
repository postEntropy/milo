/**
 * What a tool changed in a file, for the line under its call.
 *
 * The writing tool is the only place that knows the file as it was and as it now
 * is, so the change is computed there and carried to the surfaces. Derived from
 * the arguments instead, a `replace_all` would have no idea where its other
 * occurrences landed, and a replaced file would have no "before" at all.
 *
 * A diff is display state: the model gets the tool's own sentence, never this.
 */

export type ChangeLineKind = 'add' | 'remove' | 'context'

export interface ChangeLine {
  kind: ChangeLineKind
  text: string
  /** The line's number in the file before the change, when it had one. */
  old?: number
  /** The line's number after it, when it has one. */
  new?: number
}

export interface FileChange {
  path: string
  additions: number
  deletions: number
  /** The file did not exist before the call. */
  created?: boolean
  /** The file is gone after it. */
  deleted?: boolean
  /** The changed lines, with a couple of unchanged ones either side, and capped. */
  lines: ChangeLine[]
  /** The body was cut; `additions` and `deletions` still count the whole change. */
  truncated?: boolean
}

/**
 * Whether a file is worth reporting at all. Writing back exactly what was there
 * moved nothing, and a surface that says "1 file changed" over an empty fold says
 * something that did not happen.
 */
export function changeReported(change: FileChange): boolean {
  return (
    change.created === true ||
    change.deleted === true ||
    change.additions > 0 ||
    change.deletions > 0
  )
}

/** How many lines a surface is handed for one file. The counts stay exact. */
const MAX_BODY_LINES = 80

/** Unchanged lines kept on each side of a change, so it reads in place. */
const CONTEXT = 2

/**
 * The largest segment an exact line comparison is worth. Past it the diff splits
 * the segment on lines that are unique to both sides (patience) instead of
 * spending a table on it, and a segment with no such line is drawn whole.
 */
const MAX_EXACT_CELLS = 4096

interface Edit {
  kind: ChangeLineKind
  text: string
}

/**
 * The change from `before` to `after`, with `null` meaning "did not exist".
 *
 * A file that did not exist is every line added; one that is gone is every line
 * removed. Both are capped the same way, so a surface draws an empty file or a
 * thousand-line one without knowing the difference.
 */
export function fileChange(path: string, before: string | null, after: string | null): FileChange {
  if (before === null && after === null) {
    return { path, additions: 0, deletions: 0, lines: [] }
  }
  if (before === null) {
    const lines = linesOf(after ?? '')
    return {
      path,
      additions: lines.length,
      deletions: 0,
      created: true,
      lines: lines.slice(0, MAX_BODY_LINES).map((text, index) => ({ kind: 'add' as const, text, new: index + 1 })),
      ...(lines.length > MAX_BODY_LINES ? { truncated: true } : {}),
    }
  }
  if (after === null) {
    const lines = linesOf(before)
    return {
      path,
      additions: 0,
      deletions: lines.length,
      deleted: true,
      lines: lines.slice(0, MAX_BODY_LINES).map((text, index) => ({ kind: 'remove' as const, text, old: index + 1 })),
      ...(lines.length > MAX_BODY_LINES ? { truncated: true } : {}),
    }
  }

  const numbered = numberLines(script(linesOf(before), linesOf(after)))

  let additions = 0
  let deletions = 0
  for (const edit of numbered) {
    if (edit.kind === 'add') additions += 1
    else if (edit.kind === 'remove') deletions += 1
  }

  const visible = window(numbered, CONTEXT)
  return {
    path,
    additions,
    deletions,
    lines: visible.slice(0, MAX_BODY_LINES),
    ...(visible.length > MAX_BODY_LINES ? { truncated: true } : {}),
  }
}

/**
 * The whole file as an edit script: unchanged lines as context, a line only in
 * `before` removed, one only in `after` added.
 */
function script(a: string[], b: string[]): Edit[] {
  const out: Edit[] = []
  diffRange(a, 0, a.length, b, 0, b.length, out, 0)
  return out
}

function diffRange(
  a: string[],
  a0: number,
  a1: number,
  b: string[],
  b0: number,
  b1: number,
  out: Edit[],
  depth: number,
): void {
  while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) {
    out.push({ kind: 'context', text: a[a0]! })
    a0 += 1
    b0 += 1
  }

  // The run both sides end with belongs after everything this range still has to
  // say, so it is collected and put back at the end.
  const tail: Edit[] = []
  while (a0 < a1 && b0 < b1 && a[a1 - 1] === b[b1 - 1]) {
    a1 -= 1
    b1 -= 1
    tail.unshift({ kind: 'context', text: a[a1]! })
  }

  if (a0 === a1 || b0 === b1) {
    for (; a0 < a1; a0 += 1) out.push({ kind: 'remove', text: a[a0]! })
    for (; b0 < b1; b0 += 1) out.push({ kind: 'add', text: b[b0]! })
    out.push(...tail)
    return
  }

  if ((a1 - a0) * (b1 - b0) <= MAX_EXACT_CELLS) {
    out.push(...lcs(a, a0, a1, b, b0, b1))
    out.push(...tail)
    return
  }

  // A segment this large is split on the lines it has in common with the other
  // side, once; a segment that has none — a rewrite — is said whole, and one
  // that has nested on itself this far is said whole too rather than spending
  // a table on what is already a rewrite in all but name.
  const anchors = depth >= 8 ? [] : anchorsOf(a, a0, a1, b, b0, b1)
  if (anchors.length === 0) {
    for (; a0 < a1; a0 += 1) out.push({ kind: 'remove', text: a[a0]! })
    for (; b0 < b1; b0 += 1) out.push({ kind: 'add', text: b[b0]! })
    out.push(...tail)
    return
  }

  let ai = a0
  let bi = b0
  for (const [ax, bx] of anchors) {
    diffRange(a, ai, ax, b, bi, bx, out, depth + 1)
    out.push({ kind: 'context', text: a[ax]! })
    ai = ax + 1
    bi = bx + 1
  }
  diffRange(a, ai, a1, b, bi, b1, out, depth + 1)
  out.push(...tail)
}

/** The classic table walk, for a segment small enough to afford it. */
function lcs(a: string[], a0: number, a1: number, b: string[], b0: number, b1: number): Edit[] {
  const n = a1 - a0
  const m = b1 - b0
  const width = m + 1
  const table = new Int32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        a[a0 + i] === b[b0 + j]
          ? table[(i + 1) * width + j + 1]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!)
    }
  }
  const out: Edit[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[a0 + i] === b[b0 + j]) {
      out.push({ kind: 'context', text: a[a0 + i]! })
      i += 1
      j += 1
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
      out.push({ kind: 'remove', text: a[a0 + i]! })
      i += 1
    } else {
      out.push({ kind: 'add', text: b[b0 + j]! })
      j += 1
    }
  }
  for (; i < n; i += 1) out.push({ kind: 'remove', text: a[a0 + i]! })
  for (; j < m; j += 1) out.push({ kind: 'add', text: b[b0 + j]! })
  return out
}

/**
 * Lines that appear exactly once on each side, in the order both sides keep
 * them — the places the two can be lined up on without guessing. The longest
 * increasing run of them is taken, so the anchors never cross.
 */
function anchorsOf(a: string[], a0: number, a1: number, b: string[], b0: number, b1: number): Array<[number, number]> {
  const countA = new Map<string, number>()
  for (let i = a0; i < a1; i += 1) countA.set(a[i]!, (countA.get(a[i]!) ?? 0) + 1)
  const countB = new Map<string, number>()
  for (let j = b0; j < b1; j += 1) countB.set(b[j]!, (countB.get(b[j]!) ?? 0) + 1)

  const pairs: Array<[number, number]> = []
  const seen = new Map<string, number>()
  for (let j = b0; j < b1; j += 1) seen.set(b[j]!, j)
  for (let i = a0; i < a1; i += 1) {
    const line = a[i]!
    if (countA.get(line) !== 1 || countB.get(line) !== 1) continue
    pairs.push([i, seen.get(line)!])
  }
  if (pairs.length === 0) return []

  // Longest increasing subsequence over the `b` positions, `pairs` being ordered
  // by `a` already.
  const tails: number[] = []
  const previous = new Array<number>(pairs.length).fill(-1)
  for (let index = 0; index < pairs.length; index += 1) {
    const value = pairs[index]![1]
    let low = 0
    let high = tails.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (pairs[tails[middle]!]![1] < value) low = middle + 1
      else high = middle
    }
    if (low > 0) previous[index] = tails[low - 1]!
    tails[low] = index
  }

  const out: Array<[number, number]> = []
  for (let index = tails[tails.length - 1] ?? -1; index !== -1; index = previous[index]!) {
    out.push(pairs[index]!)
  }
  return out.reverse()
}

/** Gives every line the number it had and the number it has. */
function numberLines(edits: Edit[]): ChangeLine[] {
  let old = 1
  let next = 1
  return edits.map((edit) => {
    if (edit.kind === 'context') {
      const line: ChangeLine = { kind: edit.kind, text: edit.text, old, new: next }
      old += 1
      next += 1
      return line
    }
    if (edit.kind === 'remove') {
      const line: ChangeLine = { kind: edit.kind, text: edit.text, old }
      old += 1
      return line
    }
    const line: ChangeLine = { kind: edit.kind, text: edit.text, new: next }
    next += 1
    return line
  })
}

/**
 * The lines worth drawing: every change, a couple of unchanged ones around it,
 * and no stretch of context long enough to push the changes off the screen.
 */
function window(edits: ChangeLine[], context: number): ChangeLine[] {
  const keep = new Set<number>()
  for (let index = 0; index < edits.length; index += 1) {
    if (edits[index]!.kind === 'context') continue
    for (let at = index - context; at <= index + context; at += 1) {
      if (at >= 0 && at < edits.length) keep.add(at)
    }
  }
  return edits.filter((_, index) => keep.has(index))
}

/** The lines of a file as a diff counts them: a trailing newline ends the last one. */
function linesOf(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}
