import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { panelTool } from '../src/core/tools/panel.js'

const home = mkdtempSync(path.join(os.tmpdir(), 'milo-panel-tool-'))

const ctx = (cwd = home): { cwd: string; signal: AbortSignal } => ({ cwd, signal: new AbortController().signal })

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
})

describe('the panel tool', () => {
  it('points the panel at a file, resolved against the working directory', async () => {
    writeFileSync(path.join(home, 'report.md'), '# the report')
    const result = await panelTool.execute({ path: 'report.md' }, ctx())
    expect(result.isError).toBeUndefined()
    expect(result.panel).toEqual({ path: path.join(home, 'report.md') })
  })

  it('shows the browser when asked, instead of a file', async () => {
    const result = await panelTool.execute({ browser: true }, ctx())
    expect(result.isError).toBeUndefined()
    expect(result.panel).toEqual({ browser: true })
  })

  it('carries a title when one is given, trimmed', async () => {
    writeFileSync(path.join(home, 'a.txt'), 'x')
    const result = await panelTool.execute({ path: 'a.txt', title: '  The report  ' }, ctx())
    expect(result.panel).toEqual({ path: path.join(home, 'a.txt'), title: 'The report' })
  })

  it('takes the panel down', async () => {
    const result = await panelTool.execute({ action: 'close' }, ctx())
    expect(result.panel).toEqual({ close: true })
  })

  it('names the valid options when asked for nothing at all', async () => {
    const result = await panelTool.execute({}, ctx())
    expect(result.isError).toBe(true)
    expect(result.content).toContain('path')
    expect(result.content).toContain('browser')
    expect(result.content).toContain('close')
  })

  it('says so when the file is not there, rather than opening an empty panel', async () => {
    const result = await panelTool.execute({ path: 'nope.md' }, ctx())
    expect(result.isError).toBe(true)
    expect(result.content).toContain('No such file')
    expect(result.panel).toBeUndefined()
  })

  it('refuses a directory', async () => {
    mkdirSync(path.join(home, 'docs'))
    const result = await panelTool.execute({ path: 'docs' }, ctx())
    expect(result.isError).toBe(true)
    expect(result.content).toContain('not a file')
    expect(result.panel).toBeUndefined()
  })
})
