import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyPatchTool, parsePatch } from '../src/core/tools/apply-patch.js'
import { summarizeToolCall } from '../src/core/tools/permission.js'
import { scanWriteTarget } from '../src/core/tools/rules.js'
import type { ToolContext } from '../src/core/tools/types.js'

function folder(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'milo-patch-'))
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, body)
  }
  return dir
}

function context(cwd: string): ToolContext {
  return { cwd, signal: new AbortController().signal }
}

describe('apply_patch', () => {
  it('replaces an exact run of lines in one file', async () => {
    const cwd = folder({ 'a.txt': 'one\ntwo\nthree\n' })
    const result = await applyPatchTool.execute(
      {
        patch: [
          '*** Begin Patch',
          '*** Update File: a.txt',
          '@@',
          ' one',
          '-two',
          '+TWO',
          ' three',
          '*** End Patch',
        ].join('\n'),
      },
      context(cwd),
    )

    expect(result.isError).toBeUndefined()
    expect(readFileSync(path.join(cwd, 'a.txt'), 'utf8')).toBe('one\nTWO\nthree\n')
    expect(result.content).toContain('a.txt: 1 hunk(s) applied')
  })

  it('applies hunks to the same file in order', async () => {
    const cwd = folder({ 'a.txt': 'a\nb\nc\nd\n' })
    const result = await applyPatchTool.execute(
      {
        patch: [
          '*** Begin Patch',
          '*** Update File: a.txt',
          '@@',
          '-a',
          '+A',
          '@@',
          '-d',
          '+D',
          '*** End Patch',
        ].join('\n'),
      },
      context(cwd),
    )

    expect(result.isError).toBeUndefined()
    expect(readFileSync(path.join(cwd, 'a.txt'), 'utf8')).toBe('A\nb\nc\nD\n')
  })

  it('updates, adds and deletes across files in one patch', async () => {
    const cwd = folder({ 'update.txt': 'old\n', 'delete.txt': 'gone\n' })
    const result = await applyPatchTool.execute(
      {
        patch: [
          '*** Begin Patch',
          '*** Update File: update.txt',
          '@@',
          '-old',
          '+new',
          '*** Add File: nested/new.txt',
          '+hello',
          '*** Delete File: delete.txt',
          '*** End Patch',
        ].join('\n'),
      },
      context(cwd),
    )

    expect(result.isError).toBeUndefined()
    expect(readFileSync(path.join(cwd, 'update.txt'), 'utf8')).toBe('new\n')
    expect(readFileSync(path.join(cwd, 'nested/new.txt'), 'utf8')).toBe('hello\n')
    expect(existsSync(path.join(cwd, 'delete.txt'))).toBe(false)
  })

  it('writes nothing when one hunk does not match', async () => {
    const cwd = folder({ 'a.txt': 'one\n', 'b.txt': 'two\n' })
    const result = await applyPatchTool.execute(
      {
        patch: [
          '*** Begin Patch',
          '*** Update File: a.txt',
          '@@',
          '-one',
          '+ONE',
          '*** Update File: b.txt',
          '@@',
          '-missing',
          '+MISSING',
          '*** End Patch',
        ].join('\n'),
      },
      context(cwd),
    )

    expect(result.isError).toBe(true)
    expect(result.content).toContain('b.txt: hunk 1 does not match')
    // The first file was validated but never written.
    expect(readFileSync(path.join(cwd, 'a.txt'), 'utf8')).toBe('one\n')
    expect(readFileSync(path.join(cwd, 'b.txt'), 'utf8')).toBe('two\n')
  })

  it('refuses a hunk that matches more than once', async () => {
    const cwd = folder({ 'a.txt': 'same\ncontext\nsame\ncontext\n' })
    const result = await applyPatchTool.execute(
      {
        patch: ['*** Begin Patch', '*** Update File: a.txt', '@@', ' same', '-context', '+changed', '*** End Patch'].join('\n'),
      },
      context(cwd),
    )

    expect(result.isError).toBe(true)
    expect(result.content).toContain('matches 2 places')
  })

  it('refuses to add a file that is already there', async () => {
    const cwd = folder({ 'a.txt': 'here\n' })
    const result = await applyPatchTool.execute(
      {
        patch: ['*** Begin Patch', '*** Add File: a.txt', '+again', '*** End Patch'].join('\n'),
      },
      context(cwd),
    )

    expect(result.isError).toBe(true)
    expect(result.content).toContain('already exists')
    expect(readFileSync(path.join(cwd, 'a.txt'), 'utf8')).toBe('here\n')
  })

  it('refuses to delete a file that is not there', async () => {
    const cwd = folder()
    const result = await applyPatchTool.execute(
      { patch: ['*** Begin Patch', '*** Delete File: gone.txt', '*** End Patch'].join('\n') },
      context(cwd),
    )

    expect(result.isError).toBe(true)
    expect(result.content).toContain('does not exist')
  })

  it('names what is wrong with a malformed patch', () => {
    expect(parsePatch('*** Update File: a\n*** End Patch')).toEqual({
      ok: false,
      error: 'the patch must start with "*** Begin Patch".',
    })
    expect(parsePatch('*** Begin Patch\n*** Update File: a\n*** End Patch')).toEqual({
      ok: false,
      error: 'a: an update needs at least one "@@" hunk.',
    })
    expect(parsePatch('*** Begin Patch\n*** End Patch')).toEqual({
      ok: false,
      error: 'the patch changes nothing.',
    })
  })

  it('shows the files it will touch when it asks', () => {
    const summary = summarizeToolCall({
      patch: [
        '*** Begin Patch',
        '*** Update File: a.ts',
        '@@',
        '-old',
        '+new',
        '*** Add File: b.ts',
        '+x',
        '*** End Patch',
      ].join('\n'),
    })

    expect(summary).toContain('Apply a patch')
    expect(summary).toContain('Files: a.ts, b.ts')
  })

  it('holds every file in a patch to the protected-path rule', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: fine.txt',
      '+ok',
      '*** Add File: /etc/hosts',
      '+x',
      '*** End Patch',
    ].join('\n')

    expect(scanWriteTarget({ patch }, '/tmp')).toMatchObject({ rule: 'write-system-path' })
  })
})
