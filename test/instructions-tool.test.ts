import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { ToolContext } from '../src/core/tools/types.js'

// A throwaway home, set before the module that reads it is loaded: the tool writes
// to the install's own `AGENTS.md`, and the person's real one is not the subject.
const previousHome = process.env.MILO_HOME
const home = mkdtempSync(path.join(tmpdir(), 'milo-instructions-tool-'))
process.env.MILO_HOME = home
const { instructionsTool } = await import('../src/core/tools/instructions.js')
const { readOwnInstructions } = await import('../src/core/agent/instructions.js')

afterAll(() => {
  if (previousHome === undefined) delete process.env.MILO_HOME
  else process.env.MILO_HOME = previousHome
})

/** A turn's context, in a project when one is given. */
function context(projectRoot?: string): ToolContext {
  return {
    cwd: projectRoot ?? home,
    signal: new AbortController().signal,
    confineTo: projectRoot,
  }
}

function projectFolder(): string {
  return mkdtempSync(path.join(tmpdir(), 'milo-instructions-project-'))
}

const installFile = path.join(home, 'AGENTS.md')

describe('the instructions tool', () => {
  it('saves a rule in the install’s own file by default', async () => {
    rmSync(installFile, { force: true })

    const answer = await instructionsTool.execute(
      { action: 'add', text: 'Keep answers to a few lines.' },
      context(),
    )

    expect(answer.isError).toBeFalsy()
    expect(readFileSync(installFile, 'utf8')).toBe('## Preferences\n- Keep answers to a few lines.\n')
    // What the next turn is handed: the same file the prompt reads, already carrying it.
    const carried = readOwnInstructions(home)
    expect(carried.kind).toBe('present')
    if (carried.kind === 'present') expect(carried.text).toContain('Keep answers to a few lines.')
  })

  it('saves a rule in the project’s file when the scope asks for it', async () => {
    const folder = projectFolder()
    const answer = await instructionsTool.execute(
      { action: 'add', text: 'Run the suite before calling it done.', scope: 'project' },
      context(folder),
    )

    expect(answer.isError).toBeFalsy()
    expect(readFileSync(path.join(folder, 'AGENTS.md'), 'utf8')).toContain(
      '- Run the suite before calling it done.',
    )
    // The install's file is not the project's: the scope is what decides.
    expect(readFileSync(installFile, 'utf8')).not.toContain('Run the suite')
  })

  it('answers with the file to use when a project scope has no project', async () => {
    const answer = await instructionsTool.execute(
      { action: 'add', text: 'Be brief.', scope: 'project' },
      context(),
    )

    expect(answer.isError).toBe(true)
    expect(answer.content).toContain('no project')
  })

  it('lists the rules the file carries, and says when it carries none', async () => {
    const folder = projectFolder()
    const empty = await instructionsTool.execute({ action: 'list', scope: 'project' }, context(folder))
    expect(empty.content).toContain('No rules')

    await instructionsTool.execute(
      { action: 'add', text: 'Be brief.', scope: 'project' },
      context(folder),
    )
    const listed = await instructionsTool.execute({ action: 'list', scope: 'project' }, context(folder))
    expect(listed.content).toContain('1. Be brief.')
  })

  it('drops a rule by the text the list shows', async () => {
    const folder = projectFolder()
    await instructionsTool.execute(
      { action: 'add', text: 'Be brief.', scope: 'project' },
      context(folder),
    )
    const removed = await instructionsTool.execute(
      { action: 'remove', text: 'Be brief.', scope: 'project' },
      context(folder),
    )

    expect(removed.isError).toBeFalsy()
    const listed = await instructionsTool.execute({ action: 'list', scope: 'project' }, context(folder))
    expect(listed.content).toContain('No rules')
  })

  it('answers that nothing says it when the text is not a rule there', async () => {
    const folder = projectFolder()
    await instructionsTool.execute(
      { action: 'add', text: 'Be brief.', scope: 'project' },
      context(folder),
    )
    const answer = await instructionsTool.execute(
      { action: 'remove', text: 'Be verbose.', scope: 'project' },
      context(folder),
    )

    expect(answer.isError).toBe(true)
    expect(answer.content).toContain('Nothing')
  })

  it('asks before a rule is written, and not before the list is read', () => {
    expect(instructionsTool.asksWhen?.({ action: 'list' })).toBe(false)
    expect(instructionsTool.asksWhen?.({ action: 'add', text: 'Be brief.' })).toBe(true)
    expect(instructionsTool.asksWhen?.({ action: 'remove', text: 'Be brief.' })).toBe(true)
  })
})
