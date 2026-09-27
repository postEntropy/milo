import { tokenize, words } from './tokenize.js'

/**
 * A note the store is considering, and what brought it here.
 *
 * Deliberately thin. The index's `bm25` and the model's cosine are *not* carried
 * across this boundary, because they do not decide anything here: the store has
 * already ranked the candidates with both of them (`fuse`), and the job left is
 * the one neither of them can do — telling an answer from a note that merely
 * shares a word with the question.
 */
export interface Candidate<T> {
  item: T
  /** What the note says, which is what coverage is measured against. */
  text: string
  /** The words never matched it: only meaning brought it in. */
  byMeaningOnly: boolean
}

/**
 * How much of the question a note has to carry, beside the best candidate, to be
 * worth a line.
 *
 * Relative on purpose, and this is the whole reason it is not a floor on a score:
 * an absolute cut-off was added once, measured and removed, because the scores of
 * the notes a question was about (0.01–0.70) and the notes it was not (0.05–0.31)
 * overlap — no number separates them. The *gap* does. When one note carries most
 * of the question and another carries a word of it, the second is the tail of a
 * keyword match and there is no question it answers. When every note carries
 * about as much, the whole set is close, and all of it stays.
 */
const KEEP_COVERAGE = 0.55

/**
 * Keeps the candidates that carry enough of the question, and drops the rest.
 *
 * This is where the measured gain in `npm run eval:memory` comes from, and it was
 * measured against the obvious alternative: re-ordering the candidates changed
 * nothing at all — the same precision, the same MRR, to the digit — because `bm25`
 * was already putting the right note first. The signals that only re-ordered were
 * deleted rather than kept as decoration, which is the same rule that dropped the
 * lightpanda and the `brief` mode. What was left is the one thing no ranking can
 * do for itself: noticing that most of what a keyword match returns is notes that
 * *share a word*, and that the reply was barely half answers.
 *
 * All of it is local arithmetic over at most a couple of dozen short strings,
 * because it runs before every turn: no model call, nothing to download, nothing
 * that can be down.
 */
export function keepCovered<T>(candidates: Candidate<T>[], query: string): Candidate<T>[] {
  // Nothing to trim: one candidate is either the answer or the only thing
  // meaning could find, and both are returned as they came.
  if (candidates.length <= 1) return candidates

  const terms = tokenize(query)
  if (terms.size === 0) return candidates

  const scored = candidates.map((candidate) => ({
    candidate,
    coverage: coverageOf(terms, words(candidate.text)),
  }))
  const best = scored.reduce((most, entry) => Math.max(most, entry.coverage), 0)

  return scored
    .filter(({ candidate, coverage }) => keep(candidate, coverage, best))
    .map(({ candidate }) => candidate)
}

/**
 * Whether the question's own words reach this note at all.
 *
 * The line between what the words found and what meaning reached — the two are
 * not worth the same, and the difference is now load-bearing outside this file:
 * `installMemory` uses it to decide whether the facts already answer the question
 * or whether the history still has something to add.
 */
export function sharesWords(query: string, text: string): boolean {
  const terms = tokenize(query)
  if (terms.size === 0) return false
  const said = new Set(words(text))
  for (const term of terms) if (said.has(term)) return true
  return false
}

/**
 * How much of the question the note carries.
 *
 * The words the question is *about* are what is counted — its filler is already
 * gone, which is why this is a share and not a count — and a note that carries
 * all of them is a note about the question.
 */
function coverageOf(terms: Set<string>, said: string[]): number {
  const present = new Set(said)
  let found = 0
  for (const term of terms) if (present.has(term)) found += 1
  return found / terms.size
}

/**
 * Whether a candidate is worth its line.
 *
 * A note the words never matched, that only meaning brought in, always stays: it
 * is the union recall promises, and the case that made embeddings necessary was a
 * question sharing no word with the note that answers it. Trimming it here would
 * undo the one thing the vectors are for.
 */
function keep<T>(candidate: Candidate<T>, coverage: number, best: number): boolean {
  if (candidate.byMeaningOnly) return true
  return coverage >= best * KEEP_COVERAGE
}
