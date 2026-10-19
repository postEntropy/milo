import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { detectFormatter, formatCommand, formatTool } from '../src/core/tools/format.js'
import type { ToolContext } from '../src/core/tools/types.js'

function folder(files: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'milo-format-'))
  for (const file of files) {
    const full = path.join(dir, file)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, '')
  }
  return dir
}

describe('detectFormatter', () => {
  it('finds Biome from its config', () => {
    expect(detectFormatter(folder(['biome.json']))?.name).toBe('biome')
  })

  it('finds Prettier from its config, when there is no Biome', () => {
    expect(detectFormatter(folder(['.prettierrc']))?.name).toBe('prettier')
    expect(detectFormatter(folder(['biome.json', '.prettierrc']))?.name).toBe('biome')
  })

  it('finds Ruff, Cargo and gofmt from the project files', () => {
    expect(detectFormatter(folder(['pyproject.toml']))?.name).toBe('ruff')
    expect(detectFormatter(folder(['Cargo.toml']))?.name).toBe('cargo')
    expect(detectFormatter(folder(['go.mod']))?.name).toBe('gofmt')
  })

  it('answers nothing when the folder has no formatter', () => {
    expect(detectFormatter(folder(['README.md']))).toBeNull()
  })
})

describe('formatCommand', () => {
  const biome = { name: 'biome' as const, command: 'biome', extensions: ['.ts'] }
  const prettier = { name: 'prettier' as const, command: 'prettier', extensions: ['.ts'] }
  const ruff = { name: 'ruff' as const, command: 'ruff', extensions: ['.py'] }
  const cargo = { name: 'cargo' as const, command: 'cargo', extensions: ['.rs'], wholeProject: true }
  const gofmt = { name: 'gofmt' as const, command: 'gofmt', extensions: ['.go'] }

  it('writes when formatting, and checks when asked', () => {
    expect(formatCommand(biome, ['a.ts'], false)).toEqual({
      command: 'biome',
      args: ['format', '--write', 'a.ts'],
    })
    expect(formatCommand(biome, ['a.ts'], true)).toEqual({
      command: 'biome',
      args: ['format', 'a.ts'],
    })
    expect(formatCommand(prettier, ['a.ts'], false).args).toEqual(['--write', 'a.ts'])
    expect(formatCommand(prettier, ['a.ts'], true).args).toEqual(['--check', 'a.ts'])
    expect(formatCommand(ruff, ['a.py'], false).args).toEqual(['format', 'a.py'])
    expect(formatCommand(ruff, ['a.py'], true).args).toEqual(['format', '--check', 'a.py'])
    expect(formatCommand(gofmt, ['a.go'], false).args).toEqual(['-w', 'a.go'])
    expect(formatCommand(gofmt, ['a.go'], true).args).toEqual(['-l', 'a.go'])
    // The whole crate, which is the only subject `cargo fmt` takes.
    expect(formatCommand(cargo, [], false).args).toEqual(['fmt'])
    expect(formatCommand(cargo, [], true).args).toEqual(['fmt', '--check'])
  })
})

describe('format', () => {
  const context = (cwd: string): ToolContext => ({ cwd, signal: new AbortController().signal })

  it('says plainly when the folder has no formatter', async () => {
    const result = await formatTool.execute({}, context(folder(['README.md'])))

    expect(result.isError).toBe(true)
    expect(result.content).toContain('No formatter is configured')
  })

  it('refuses a file the detected formatter does not own', async () => {
    const cwd = folder(['biome.json', 'notes.txt'])
    const result = await formatTool.execute({ path: 'notes.txt' }, context(cwd))

    expect(result.isError).toBe(true)
    expect(result.content).toContain('is not one of the files biome formats')
  })

  it('says a folder outside the project is a write it will not make', async () => {
    const cwd = folder(['biome.json'])
    const result = await formatTool.execute(
      { path: '../elsewhere.ts' },
      { ...context(cwd), confineTo: cwd },
    )

    expect(result.isError).toBe(true)
    expect(result.content).toContain("outside the project's folder")
  })

  it('says when the changed files cannot be read outside a repository', async () => {
    const result = await formatTool.execute({}, context(folder(['biome.json'])))

    expect(result.isError).toBe(true)
    expect(result.content).toContain('not a git repository')
  })
})
