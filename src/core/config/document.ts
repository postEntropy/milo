import { existsSync, readFileSync } from 'node:fs'
import { Document, Scalar, isMap, isPair, isScalar, parseDocument, type Pair } from 'yaml'
import { errorMessage } from '../../util/errors.js'
import { logWarn } from '../../util/log.js'
import { CONFIG_NOTES } from './comments.js'
import { configFile } from './paths.js'

/**
 * The config as a YAML document, rather than as the object it parses to.
 *
 * The difference is the whole reason the file is YAML: a document remembers the
 * comments and the order it was read with, so a write can change the one value
 * that moved and leave every other line — including the ones nobody's code put
 * there — exactly as they were. Parsing to an object and re-serializing it, which
 * is what this replaced, gives a correct file and takes every hand-written
 * comment with it.
 *
 * All of it is one rule: what the caller hands over is the truth about values,
 * and the file is the truth about everything else.
 */

/** A path to one key: `['sessions', 'maxSessions']`. */
type Path = string[]

function same(left: unknown, right: unknown): boolean {
  // Only ever compared between two leaves, so structural order cannot mislead it.
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * Every leaf of a config-shaped value, with the path that reaches it.
 *
 * An array is a leaf — it is replaced whole, because there is nothing to preserve
 * inside it — and `null` is a leaf rather than the object `typeof` calls it.
 */
export function leaves(value: unknown, prefix: Path = []): Array<{ path: Path; value: unknown }> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return prefix.length > 0 ? [{ path: prefix, value }] : []
  }
  const found: Array<{ path: Path; value: unknown }> = []
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    // An absent optional is not a value to write: leaving it out is how the file
    // says "unset", which is what the schema reads back.
    if (child === undefined) continue
    found.push(...leaves(child, [...prefix, key]))
  }
  return found
}

/**
 * Every path a key reaches, sections included.
 *
 * The help is keyed by path, and a section has a line of its own — so this walks
 * what `leaves` walks plus every object on the way down. An array carries no keys
 * of its own and is its own last path.
 */
function nodes(value: unknown, prefix: Path = []): Array<{ path: Path; value: unknown }> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return []
  const found: Array<{ path: Path; value: unknown }> = []
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (child === undefined) continue
    const path = [...prefix, key]
    found.push({ path, value: child }, ...nodes(child, path))
  }
  return found
}

/** Whether this is a section with nothing in it yet. */
function isEmpty(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0
}

/**
 * The key of a pair, as a value.
 *
 * `setIn` leaves a key it created as a bare string where the parser would have
 * given a Scalar node — so both shapes arrive here, and a comment can only be
 * hung on the second.
 */
function keyOf(pair: Pair): unknown {
  return isScalar(pair.key) ? pair.key.value : pair.key
}

/** The map entry for `path`, so a comment can be attached ahead of its key. */
function pairAt(doc: Document, path: Path): Pair | undefined {
  const parent = path.length === 1 ? doc.contents : doc.getIn(path.slice(0, -1), true)
  if (!isMap(parent)) return undefined
  const last = path[path.length - 1]
  return parent.items.find((item) => isPair(item) && keyOf(item) === last)
}

/** Stamps the help for `path` onto its key — ever only a key this write created. */
function note(doc: Document, path: Path): void {
  const text = CONFIG_NOTES[path.join('.')]
  if (!text) return
  const pair = pairAt(doc, path)
  if (!pair) return
  const existing = pair.key
  // A key built by `setIn` can be a bare string, with nowhere to hang a comment;
  // the emitter wants a node, so it is given one.
  const key = isScalar(existing) ? existing : new Scalar(String(existing))
  if (!isScalar(existing)) pair.key = key
  // The marker is the caller's to write: the library puts `#` straight against it.
  key.commentBefore = ` ${text}`
}

/**
 * A blank line between the top-level blocks.
 *
 * The config is a column of documented settings, and running them together makes
 * a single one hard to find; YAML has the room to keep them apart. The first key
 * is left alone — a blank line opening the file is not a separator, and the
 * emitter would put one ahead of the very first line.
 */
function spaceSections(doc: Document): void {
  if (!isMap(doc.contents)) return
  doc.contents.items.forEach((item, index) => {
    if (index === 0 || !isPair(item)) return
    // As with a comment, a key `setIn` built can be a bare string with nowhere to
    // hang the flag; the emitter reads it off a node, so it is given one.
    const key = isScalar(item.key) ? item.key : new Scalar(String(item.key))
    if (!isScalar(item.key)) item.key = key
    key.spaceBefore = true
  })
}

/** The document as it is on disk; an unreadable or missing file starts a new one. */
export function readDocument(file = configFile()): Document {
  if (!existsSync(file)) return new Document()
  try {
    return parseDocument(readFileSync(file, 'utf8'))
  } catch (error) {
    logWarn(`could not read ${file}: ${errorMessage(error)}`)
    return new Document()
  }
}

/**
 * Writes `config` into `doc`, touching as little of it as the difference requires:
 * only a leaf whose value moved is replaced, only a key the file no longer has is
 * dropped, and a key being added arrives with its line of help.
 */
export function applyConfig(doc: Document, config: unknown): void {
  if (!isMap(doc.contents)) doc.contents = doc.createNode({})

  // What the file already held. The help is stamped on what this write brings and
  // not on what was already there — a distinction with teeth: on re-reading, the
  // comment before a block's *first* key comes back attached to the collection
  // above it rather than to the key, so a guard that looked for it on the key
  // would miss it and stamp a second copy. Every save would have added one.
  const had = new Set(nodes(doc.toJS()).map(({ path }) => path.join('.')))

  const wanted = new Map(leaves(config).map((leaf) => [leaf.path.join('.'), leaf]))
  for (const { path, value } of wanted.values()) {
    if (!same(doc.getIn(path), value)) doc.setIn(path, value)
  }
  // A section with nothing in it yet has to be created here or not at all: no leaf
  // reaches it, and the file would quietly lose a section the person is meant to
  // fill in. `gateways: {}` is the one that matters — it is where the bot surfaces
  // are turned on, and it is empty on a new install.
  for (const { path, value } of nodes(config)) {
    if (isEmpty(value) && doc.getIn(path) === undefined) doc.setIn(path, value)
  }
  for (const { path } of nodes(config)) {
    if (!had.has(path.join('.'))) note(doc, path)
  }
  // What the file still holds and the config does not: a key the schema dropped,
  // or one the value changed away from. Left alone it would come back on the next
  // read as a default, so the file is made to say what the config says.
  for (const leaf of leaves(doc.toJS())) {
    if (!wanted.has(leaf.path.join('.'))) {
      doc.deleteIn(leaf.path)
      if (leaf.path.length > 1) {
        const parentPath = leaf.path.slice(0, -1)
        const parent = doc.getIn(parentPath)
        if (isMap(parent) && parent.items.length === 0) {
          doc.deleteIn(parentPath)
        }
      }
    }
  }
  spaceSections(doc)
}

/** The document as text, unwrapped and newline-terminated. */
export function renderDocument(doc: Document): string {
  // `lineWidth: 0` turns off folding: a system prompt or a base URL is one line,
  // the way it was written, rather than re-wrapped at 80 columns.
  const text = doc.toString({ lineWidth: 0 }).trimEnd()
  return text ? `${text}\n` : ''
}
