import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { errorMessage } from '../util/errors.js'
import { humanSize } from '../util/format.js'
import { placeProject } from './projects.js'
import { pageText } from './tools/read-file.js'
import { walk, type WalkEntry } from './tools/walk.js'

/**
 * A project's folder as a tree, and one file of it as a page of text — what the Work
 * screen draws and reads.
 *
 * Read-only, and deliberately so: the person edits in their own editor and the agent
 * edits through its own tools, so nothing here writes. What it does own is where a path
 * is allowed to be: every read is checked against the project's own folder, so a path
 * that climbs out of it is refused rather than followed.
 *
 * The tree comes from `walk`, the same walker the agent's own tools use, so what the
 * screen offers and what a search finds cannot disagree about what is in a folder.
 */

/** A file in a project, as the tree draws it. */
export interface WorkFileNode {
  kind: 'file'
  /** The file's own name, as it is on disk. */
  name: string
  /** Path relative to the project's folder, with `/` separators. */
  rel: string
  size: number
}

/** A folder of a project, as the tree draws it: what is inside it, by name. */
export interface WorkFolderNode {
  kind: 'folder'
  name: string
  rel: string
  /** Folders first, then files, each by name. */
  children: WorkNode[]
}

export type WorkNode = WorkFolderNode | WorkFileNode

/** A project's tree, or why it could not be read. */
export type WorkTreeOutcome =
  | {
      ok: true
      nodes: WorkNode[]
      /** How many files the tree holds — what was walked, not what is on disk. */
      files: number
      /** True when the walk hit its ceiling, so the tree is only the first part of one. */
      truncated: boolean
      /** Folders the walk could not read, in its own words. */
      warnings: string[]
    }
  | { ok: false; error: string }

/** One page of a project's file, or why it could not be read. */
export type WorkFileOutcome =
  | {
      ok: true
      /** The path that was asked for, as it was asked for. */
      rel: string
      name: string
      size: number
      /** The page's lines, numbered from `from`. Empty for an empty file. */
      text: string
      /** The 1-based line this page starts at. */
      from: number
      /** How many lines the whole file has. */
      total: number
      /** The 1-based line the next page starts at; absent on the last page. */
      next?: number
    }
  | { ok: false; error: string }

/**
 * How many files a tree draws. `walk`'s own ceiling is for a search that wants
 * everything; a tree a person reads is cut far sooner, and the cut is said.
 */
const MAX_TREE_FILES = 2_000

/** The most of one file this reads: a log nobody meant to open is not read into memory. */
const MAX_FILE_BYTES = 8 * 1024 * 1024

/**
 * The tree of one project's folder, every file under it. Folders are the ones the files
 * are in: `walk` reports files, so a folder holding none — or holding only what is
 * ignored — is not a folder of this tree. What was cut and what could not be read ride
 * back with it, so the screen says both rather than drawing a smaller tree as the whole.
 */
export async function workTree(id: string): Promise<WorkTreeOutcome> {
  const placement = placeProject(id)
  if (!placement.ok) return { ok: false, error: placement.error }

  const walked = await walk({ root: placement.project.path, maxEntries: MAX_TREE_FILES })
  return {
    ok: true,
    nodes: buildTree(walked.entries),
    files: walked.entries.length,
    truncated: walked.truncated,
    warnings: walked.warnings,
  }
}

/**
 * One file of a project, read as a page of text. The page is cut by the same code the
 * agent's `read_file` is cut by, so the person reading along is handed the same lines
 * the agent was.
 *
 * Every refusal names what was wrong — the folder is gone, the path points outside the
 * project, there is no such file, it is not text — because a screen that answered an
 * empty page for a file it never read would be a screen that lies.
 */
export async function workFile(
  id: string,
  rel: string,
  options: { offset?: number } = {},
): Promise<WorkFileOutcome> {
  const placement = placeProject(id)
  if (!placement.ok) return { ok: false, error: placement.error }

  const asked = rel.trim()
  if (!asked) return { ok: false, error: 'a file needs a path' }

  const root = await realpath(placement.project.path).catch(() => placement.project.path)
  const target = path.resolve(root, asked)
  if (!inside(root, target)) return { ok: false, error: `${asked} is not inside ${placement.project.name}.` }

  let size: number
  try {
    const stats = await stat(target)
    if (!stats.isFile()) return { ok: false, error: `${asked} is not a file.` }
    size = stats.size
  } catch (error) {
    return { ok: false, error: `could not read ${asked}: ${errorMessage(error)}` }
  }
  if (size > MAX_FILE_BYTES) {
    return { ok: false, error: `${asked} is ${humanSize(size)} — this reads files up to ${humanSize(MAX_FILE_BYTES)}.` }
  }

  // A symlink inside the project can lead out of it; what is read is where it lands.
  const real = await realpath(target).catch(() => target)
  if (!inside(root, real)) return { ok: false, error: `${asked} is not inside ${placement.project.name}.` }

  let raw: string
  try {
    raw = await readFile(target, 'utf8')
  } catch (error) {
    return { ok: false, error: `could not read ${asked}: ${errorMessage(error)}` }
  }
  // A binary read as UTF-8 is garbage with no complaint; a NUL is the one byte text
  // does not hold, and it is what an image, an archive and a compiled file all start with.
  if (raw.includes('\u0000')) return { ok: false, error: `${asked} is not a text file.` }

  const page = pageText(raw, options)
  if (!page.ok) {
    return { ok: false, error: `line ${page.beyond} is past the end of ${asked} — it has ${page.total} line(s).` }
  }

  return {
    ok: true,
    rel: asked,
    name: path.basename(target),
    size,
    text: page.lines.join('\n'),
    from: page.from,
    total: page.total,
    ...(page.next !== undefined ? { next: page.next } : {}),
  }
}

/**
 * The walked files as a tree, nested by their own relative paths. Folders are made as
 * they are met, so a folder's own children are in the order the walk brought them until
 * they are sorted here: folders first, then files, each by name.
 */
function buildTree(entries: WalkEntry[]): WorkNode[] {
  const nodes: WorkNode[] = []
  const folders = new Map<string, WorkFolderNode>()

  /** The folder at `rel`, made — with its parent — the first time it is named. */
  const folderAt = (rel: string): WorkFolderNode => {
    const known = folders.get(rel)
    if (known) return known

    const name = rel.slice(rel.lastIndexOf('/') + 1)
    const made: WorkFolderNode = { kind: 'folder', name, rel, children: [] }
    folders.set(rel, made)

    const cut = rel.lastIndexOf('/')
    if (cut === -1) nodes.push(made)
    else folderAt(rel.slice(0, cut)).children.push(made)
    return made
  }

  for (const entry of entries) {
    const cut = entry.rel.lastIndexOf('/')
    const name = cut === -1 ? entry.rel : entry.rel.slice(cut + 1)
    const parent = cut === -1 ? nodes : folderAt(entry.rel.slice(0, cut)).children
    parent.push({ kind: 'file', name, rel: entry.rel, size: entry.size })
  }

  sortTree(nodes)
  return nodes
}

function sortTree(nodes: WorkNode[]): void {
  nodes.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'folder' ? -1 : 1))
  for (const node of nodes) if (node.kind === 'folder') sortTree(node.children)
}

/** Whether `target` is the folder `root` or something inside it — never the way out. */
function inside(root: string, target: string): boolean {
  const rel = path.relative(root, target)
  // `..` and `../x` climb out; `..foo` is a file that happens to start with the same dots.
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
}
