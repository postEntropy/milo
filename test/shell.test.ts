import { describe, expect, it } from 'vitest'
import { shellTool } from '../src/core/tools/shell.js'

const ctx = { cwd: process.cwd(), signal: new AbortController().signal }

describe('shell_command', () => {
  it('runs a command and reports exit 0 with output', async () => {
    const result = await shellTool.execute({ command: 'echo hello' }, ctx)
    expect(result.content).toContain('exit 0')
    expect(result.content).toContain('hello')
    expect(result.isError).toBeFalsy()
  })

  it('reports a non-zero exit code', async () => {
    const result = await shellTool.execute({ command: 'exit 3' }, ctx)
    expect(result.content).toContain('exit 3')
  })

  it('runs in the current working directory by default', async () => {
    const result = await shellTool.execute({ command: 'pwd' }, ctx)
    expect(result.content).toContain(process.cwd())
  })

  it('is not read-only (needs confirmation)', () => {
    expect(shellTool.readOnly).toBe(false)
  })

  it('keeps the end of a long output, where the error is', async () => {
    // stdout is long enough to be truncated, and the failure lands in stderr.
    const command = `printf 'x%.0s' $(seq 1 30000); echo 'THE-ERROR' >&2; exit 1`
    const result = await shellTool.execute({ command }, ctx)

    expect(result.content).toContain('exit 1')
    expect(result.content).toContain('character(s) omitted')
    expect(result.content).toContain('THE-ERROR')
    expect(result.content.length).toBeLessThan(21_000)
  })

  it('leaves a short output untouched', async () => {
    const result = await shellTool.execute({ command: `echo short` }, ctx)
    expect(result.content).not.toContain('omitted')
  })
})
