import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

export interface Tree {
  root: string
  cleanup(): void
}

/** Writes `{ 'src/a.ts': 'content' }` into a throwaway directory. */
export function makeTree(files: Record<string, string | Buffer>): Tree {
  const root = mkdtempSync(path.join(tmpdir(), 'milo-tree-'))
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(root, rel)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

export function ctxFor(root: string) {
  return { cwd: root, signal: new AbortController().signal }
}

/** Creates a directory with nothing in it. */
export function makeDir(root: string, rel: string): void {
  mkdirSync(path.join(root, rel), { recursive: true })
}

/** Pins a file's mtime, so ordering does not depend on how fast the test wrote. */
export function setMtime(root: string, rel: string, seconds: number): void {
  const date = new Date(seconds * 1000)
  utimesSync(path.join(root, rel), date, date)
}
