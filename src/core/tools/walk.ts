import type { Dirent, Stats } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { errorMessage } from '../../util/errors.js'

/**
 * Directories whose contents are build output or dependency caches. They are
 * skipped while walking a tree, and collapsed to a count when listing a
 * directory — walking `node_modules` would swamp every result an agent asks for.
 * A directory passed *as* the root is never skipped, so asking for one
 * explicitly still works.
 */
export const DEFAULT_IGNORES: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '__pycache__',
  '.venv',
  'venv',
  '.mypy_cache',
  '.pytest_cache',
  'target',
])

export interface WalkEntry {
  /** Absolute path. */
  path: string
  /** Path relative to the walk root, always with `/` separators. */
  rel: string
  size: number
  mtimeMs: number
}

export interface WalkResult {
  entries: WalkEntry[]
  /**
   * Directories met on the way, relative to the root, ignoring the same names the walk
   * does. A folder holding no file is still a folder; a tree built only from the paths
   * files are in would hide it.
   */
  folders: string[]
  /** The file cap was hit, so the tree was only partly walked. */
  truncated: boolean
  /** The caller cancelled, so the tree was only partly walked. */
  aborted?: boolean
  /**
   * Directories and files that could not be read, in the walk's own words. A
   * listing that quietly skipped an unreadable directory is a listing claiming
   * the tree holds less than it does — so what was missed is carried back rather
   * than dropped.
   */
  warnings: string[]
}

export interface WalkOptions {
  root: string
  ignore?: ReadonlySet<string>
  /** Stop after this many files; guards against walking a huge tree. */
  maxEntries?: number
  signal?: AbortSignal
}

const MAX_ENTRIES = 20_000

/** Breadth-first, so a cap keeps the shallow files rather than one deep corner. */
export async function walk(options: WalkOptions): Promise<WalkResult> {
  const ignore = options.ignore ?? DEFAULT_IGNORES
  const maxEntries = options.maxEntries ?? MAX_ENTRIES
  const entries: WalkEntry[] = []
  const folders: string[] = []
  const warnings: string[] = []
  const queue = [options.root]

  for (let index = 0; index < queue.length; index += 1) {
    // A cancelled walk is reported as cancelled, never as a complete one.
    if (options.signal?.aborted) return { entries, folders, truncated: false, aborted: true, warnings }
    if (entries.length >= maxEntries) return { entries, folders, truncated: true, warnings }

    const dir = queue[index]!
    let dirents: Dirent[]
    try {
      dirents = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      warnings.push(`could not read ${dir}: ${errorMessage(error)}`)
      continue
    }

    for (const dirent of dirents) {
      if (options.signal?.aborted) return { entries, folders, truncated: false, aborted: true, warnings }
      if (entries.length >= maxEntries) return { entries, folders, truncated: true, warnings }

      const full = path.join(dir, dirent.name)
      if (dirent.isDirectory()) {
        if (!ignore.has(dirent.name)) {
          folders.push(toPosix(path.relative(options.root, full)))
          queue.push(full)
        }
        continue
      }
      // Symlinks are skipped rather than followed: a link pointing back up the
      // tree would otherwise walk forever.
      if (!dirent.isFile()) continue

      let info: Stats
      try {
        info = await stat(full)
      } catch (error) {
        warnings.push(`could not read ${full}: ${errorMessage(error)}`)
        continue
      }
      entries.push({
        path: full,
        rel: toPosix(path.relative(options.root, full)),
        size: info.size,
        mtimeMs: info.mtimeMs,
      })
    }
  }

  return { entries, folders, truncated: false, warnings }
}

export function resolveToolPath(cwd: string, target: string | undefined): string {
  const value = target?.trim()
  if (!value) return cwd
  // `~` is expanded here rather than left to `path.resolve`, which would make
  // `~/x` a literal `~` directory inside the working directory.
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(homedir(), value.slice(2))
  }
  return path.isAbsolute(value) ? value : path.resolve(cwd, value)
}

/** Where a write may go, or why it may not. */
export type WritePath = { ok: true; path: string } | { ok: false; error: string }

/** A target, refused when a project session reaches outside its folder. */
export type ScopedPath = { ok: true; path: string } | { ok: false; error: string }

/** Resolve links before applying a project's boundary; a lexical `..` check alone misses symlinks. */
export function resolveScopedPath(cwd: string, target: string | undefined, confineTo?: string): ScopedPath {
  const resolved = resolveToolPath(cwd, target)
  const actual = canonicalToolPath(cwd, target)
  if (!confineTo) return { ok: true, path: actual }

  const root = canonicalExisting(confineTo)
  if (isInsideFolder(actual, root)) return { ok: true, path: actual }
  return {
    ok: false,
    error: `"${target ?? resolved}" is outside the project's folder (${root}). Access outside it is not allowed.`,
  }
}

/** Resolve a path and existing symlinks without applying a project boundary. */
export function canonicalToolPath(cwd: string, target: string | undefined): string {
  return canonicalOrNearest(resolveToolPath(cwd, target))
}

/**
 * The path a write would land on, refused when it leaves the folder the turn is
 * confined to. Resolving the existing path and its parent links first keeps a
 * symlink from turning an in-folder name into an out-of-folder write.
 *
 * The check is on the resolved path, so `../` and an absolute path are held to
 * the same rule as a plain relative one.
 */
export function resolveWritePath(
  cwd: string,
  target: string | undefined,
  confineTo?: string,
): WritePath {
  const result = resolveScopedPath(cwd, target, confineTo)
  if (!result.ok) {
    return { ok: false, error: result.error.replace('Access outside it', 'Writing outside it') }
  }
  return result
}

/** Canonicalize missing write targets through their nearest existing ancestor. */
function canonicalOrNearest(target: string): string {
  let cursor = path.resolve(target)
  const tail: string[] = []
  while (true) {
    try {
      return path.resolve(realpathSync(cursor), ...tail.reverse())
    } catch {
      const parent = path.dirname(cursor)
      if (parent === cursor) return path.resolve(target)
      tail.push(path.basename(cursor))
      cursor = parent
    }
  }
}

function canonicalExisting(target: string): string {
  try {
    return realpathSync(target)
  } catch {
    return path.resolve(target)
  }
}

function isInsideFolder(target: string, folder: string): boolean {
  const from = path.resolve(folder)
  const to = path.resolve(target)
  if (to === from) return true
  const rel = path.relative(from, to)
  return rel !== '' && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)
}

/** How a path is shown back to the model: relative when that is shorter. */
export function displayPath(cwd: string, target: string): string {
  const rel = toPosix(path.relative(cwd, target))
  return rel && !rel.startsWith('..') ? rel : target
}

export function toPosix(filePath: string): string {
  return path.sep === '/' ? filePath : filePath.split(path.sep).join('/')
}

/**
 * A pattern without a `/` is matched at any depth — `*.ts` behaves like
 * `**\/*.ts`, which is what a caller means every time.
 */
export function compileFilePattern(pattern: string): RegExp {
  const normalized = pattern.trim().replace(/^\.\//, '')
  return globToRegExp(normalized.includes('/') ? normalized : `**/${normalized}`)
}

/** Turns a glob into an anchored regex. Supports `**`, `*`, `?`, `[…]` and `{a,b}`. */
export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.trim().replace(/^\.\//, '')
  const alternatives = expandBraces(normalized).map(globSource)
  return new RegExp(`^(?:${alternatives.join('|')})$`)
}

function globSource(glob: string): string {
  let source = ''
  let index = 0

  while (index < glob.length) {
    const char = glob[index]!
    if (char === '*') {
      if (glob[index + 1] === '*') {
        // `**/` also matches zero segments, so `**/*.ts` matches a root file.
        if (glob[index + 2] === '/') {
          source += '(?:[^/]+/)*'
          index += 3
          continue
        }
        source += '.*'
        index += 2
        continue
      }
      source += '[^/]*'
      index += 1
      continue
    }
    if (char === '?') {
      source += '[^/]'
      index += 1
      continue
    }
    if (char === '[') {
      const close = glob.indexOf(']', index + 1)
      if (close > index + 1) {
        const body = glob.slice(index + 1, close)
        source += `[${body.startsWith('!') ? `^${body.slice(1)}` : body}]`
        index = close + 1
        continue
      }
      source += '\\['
      index += 1
      continue
    }
    source += escapeRegExp(char)
    index += 1
  }

  return source
}

function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf('{')
  if (open === -1) return [pattern]
  const close = matchingBrace(pattern, open)
  if (close === -1) return [pattern]

  const before = pattern.slice(0, open)
  const after = pattern.slice(close + 1)
  return splitAlternatives(pattern.slice(open + 1, close)).flatMap((part) =>
    expandBraces(`${before}${part}${after}`),
  )
}

function matchingBrace(pattern: string, open: number): number {
  let depth = 0
  for (let index = open; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/** Splits `a,{b,c}` on the top-level comma only, so nesting survives. */
function splitAlternatives(body: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0

  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]
    if (char === '{') depth += 1
    else if (char === '}') depth -= 1
    else if (char === ',' && depth === 0) {
      parts.push(body.slice(start, index))
      start = index + 1
    }
  }

  parts.push(body.slice(start))
  return parts
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
