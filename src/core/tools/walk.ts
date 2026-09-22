import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

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
  /** The file cap was hit, so the tree was only partly walked. */
  truncated: boolean
  /** The caller cancelled, so the tree was only partly walked. */
  aborted?: boolean
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
  const queue = [options.root]

  for (let index = 0; index < queue.length; index += 1) {
    // A cancelled walk is reported as cancelled, never as a complete one.
    if (options.signal?.aborted) return { entries, truncated: false, aborted: true }
    if (entries.length >= maxEntries) return { entries, truncated: true }

    const dir = queue[index]!
    const dirents = await readdir(dir, { withFileTypes: true }).catch(() => [])

    for (const dirent of dirents) {
      if (options.signal?.aborted) return { entries, truncated: false, aborted: true }
      if (entries.length >= maxEntries) return { entries, truncated: true }

      const full = path.join(dir, dirent.name)
      if (dirent.isDirectory()) {
        if (!ignore.has(dirent.name)) queue.push(full)
        continue
      }
      // Symlinks are skipped rather than followed: a link pointing back up the
      // tree would otherwise walk forever.
      if (!dirent.isFile()) continue

      const info = await stat(full).catch(() => null)
      if (!info) continue
      entries.push({
        path: full,
        rel: toPosix(path.relative(options.root, full)),
        size: info.size,
        mtimeMs: info.mtimeMs,
      })
    }
  }

  return { entries, truncated: false }
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
