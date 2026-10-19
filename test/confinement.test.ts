import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyPatchTool } from '../src/core/tools/apply-patch.js'
import { editFileTool } from '../src/core/tools/edit-file.js'
import { readFileTool } from '../src/core/tools/read-file.js'
import { sandboxArgs } from '../src/core/tools/shell.js'
import type { ToolContext } from '../src/core/tools/types.js'
import { resolveWritePath } from '../src/core/tools/walk.js'
import { writeFileTool } from '../src/core/tools/write-file.js'

function folders(): { project: string; outside: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'milo-confine-'))
  const project = path.join(root, 'project')
  const outside = path.join(root, 'outside')
  mkdirSync(project, { recursive: true })
  mkdirSync(outside, { recursive: true })
  return { project, outside }
}

function context(project: string): ToolContext {
  return { cwd: project, signal: new AbortController().signal, confineTo: project }
}

describe('a project confines writes to its folder', () => {
  it('writes inside the folder', async () => {
    const { project } = folders()
    const result = await writeFileTool.execute({ path: 'src/a.txt', content: 'ok\n' }, context(project))

    expect(result.isError).toBeUndefined()
    expect(readFileSync(path.join(project, 'src/a.txt'), 'utf8')).toBe('ok\n')
  })

  it('refuses a write outside it, naming the boundary', async () => {
    const { project, outside } = folders()
    const result = await writeFileTool.execute(
      { path: path.join(outside, 'a.txt'), content: 'no\n' },
      context(project),
    )

    expect(result.isError).toBe(true)
    expect(result.content).toContain("outside the project's folder")
    expect(existsSync(path.join(outside, 'a.txt'))).toBe(false)
  })

  it('refuses a relative path that climbs out', () => {
    const { project, outside } = folders()
    const result = resolveWritePath(project, `../outside/a.txt`, project)

    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.error).toContain('outside the project')
    expect(result).not.toMatchObject({ path: path.join(outside, 'a.txt') })
  })

  it('refuses an edit outside it', async () => {
    const { project, outside } = folders()
    writeFileSync(path.join(outside, 'a.txt'), 'old\n')
    const result = await editFileTool.execute(
      { path: path.join(outside, 'a.txt'), old_string: 'old', new_string: 'new' },
      context(project),
    )

    expect(result.isError).toBe(true)
    expect(readFileSync(path.join(outside, 'a.txt'), 'utf8')).toBe('old\n')
  })

  it('refuses the whole patch when any file is outside it', async () => {
    const { project, outside } = folders()
    writeFileSync(path.join(project, 'inside.txt'), 'old\n')

    const result = await applyPatchTool.execute(
      {
        patch: [
          '*** Begin Patch',
          '*** Update File: inside.txt',
          '@@',
          '-old',
          '+new',
          `*** Add File: ${path.join(outside, 'bad.txt')}`,
          '+no',
          '*** End Patch',
        ].join('\n'),
      },
      context(project),
    )

    expect(result.isError).toBe(true)
    expect(result.content).toContain("outside the project's folder")
    expect(readFileSync(path.join(project, 'inside.txt'), 'utf8')).toBe('old\n')
    expect(existsSync(path.join(outside, 'bad.txt'))).toBe(false)
  })

  it('still reads outside it', async () => {
    const { project, outside } = folders()
    writeFileSync(path.join(outside, 'readme.txt'), 'can read\n')

    const result = await readFileTool.execute({ path: path.join(outside, 'readme.txt') }, context(project))

    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('can read')
  })
})

describe('the shell sandbox', () => {
  it('keeps the machine read-only, the workspace writable and the network off', () => {
    expect(sandboxArgs('ls', '/work/project/sub', '/work/project')).toEqual([
      '--ro-bind', '/', '/',
      '--bind', '/work/project', '/work/project',
      '--dev', '/dev',
      '--proc', '/proc',
      '--unshare-net',
      '--die-with-parent',
      '--chdir', '/work/project/sub',
      '--', '/bin/sh', '-c', 'ls',
    ])
  })
})
