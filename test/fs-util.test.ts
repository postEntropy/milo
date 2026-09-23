import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeFileAtomic } from '../src/util/fs.js'

const freshDir = () => mkdtempSync(path.join(tmpdir(), 'milo-fs-'))

describe('writeFileAtomic', () => {
  it('creates a missing file', async () => {
    const file = path.join(freshDir(), 'a.txt')
    await writeFileAtomic(file, 'hello')
    expect(readFileSync(file, 'utf8')).toBe('hello')
  })

  it('replaces the content of an existing file', async () => {
    const file = path.join(freshDir(), 'a.txt')
    writeFileSync(file, 'old')
    await writeFileAtomic(file, 'new')
    expect(readFileSync(file, 'utf8')).toBe('new')
  })

  it('keeps the executable bit across a rewrite', async () => {
    const file = path.join(freshDir(), 'run.sh')
    writeFileSync(file, 'echo old')
    chmodSync(file, 0o755)
    await writeFileAtomic(file, 'echo new')
    expect(statSync(file).mode & 0o7777).toBe(0o755)
  })

  it('leaves no temporary files behind', async () => {
    const dir = freshDir()
    const file = path.join(dir, 'a.txt')
    await writeFileAtomic(file, 'x')
    await writeFileAtomic(file, 'y')
    expect(readdirSync(dir)).toEqual(['a.txt'])
  })
})
