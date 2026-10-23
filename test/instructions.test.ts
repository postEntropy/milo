import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PREFERENCES_HEADING,
  addRule,
  instructionsPath,
  readOwnInstructions,
  readProjectInstructions,
  readWrittenRules,
  removeRule,
  writtenRules,
} from '../src/core/agent/instructions.js'
import type { ProjectPlacement } from '../src/core/projects.js'

/** A project over a fresh folder, with the files given written into it by relative path. */
function project(files: Record<string, string> = {}): ProjectPlacement {
  const dir = mkdtempSync(path.join(tmpdir(), 'milo-instructions-'))
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, body)
  }
  return { ok: true, project: { id: 'p1', name: 'Demo', path: dir, createdAt: 0 } }
}

describe('readProjectInstructions', () => {
  it("reads the AGENTS.md at the project's root", () => {
    const placement = project({ 'AGENTS.md': '\n  Run the suite before you call it done.\n' })
    const instructions = readProjectInstructions(placement)

    // Trimmed: the file's own blank edges are not part of what it says.
    expect(instructions).toEqual({
      kind: 'present',
      file: 'AGENTS.md',
      text: 'Run the suite before you call it done.',
    })
  })

  it('reads CLAUDE.md when the folder has no AGENTS.md', () => {
    const placement = project({ 'CLAUDE.md': 'Use the repository conventions.' })
    expect(readProjectInstructions(placement)).toEqual({
      kind: 'present',
      file: 'CLAUDE.md',
      text: 'Use the repository conventions.',
    })
  })

  it('prefers AGENTS.md when the folder carries both', () => {
    const placement = project({ 'AGENTS.md': 'Milo rules.', 'CLAUDE.md': 'Other rules.' })
    expect(readProjectInstructions(placement)).toEqual({
      kind: 'present',
      file: 'AGENTS.md',
      text: 'Milo rules.',
    })
  })

  it('does not fall through to CLAUDE.md when AGENTS.md is there but empty', () => {
    const placement = project({ 'AGENTS.md': '  \n', 'CLAUDE.md': 'Other rules.' })
    expect(readProjectInstructions(placement)).toEqual({ kind: 'absent' })
  })

  it('does not fall through to CLAUDE.md when AGENTS.md exists but cannot be read', () => {
    const placement = project({ 'AGENTS.md': 'x'.repeat(17 * 1024), 'CLAUDE.md': 'Other rules.' })
    const instructions = readProjectInstructions(placement)
    expect(instructions.kind).toBe('unreadable')
    if (instructions.kind === 'unreadable') expect(instructions.file).toBe('AGENTS.md')
  })

  it('answers that there is none when the folder carries no AGENTS.md', () => {
    const placement = project({ 'README.md': 'Not the rules.' })
    expect(readProjectInstructions(placement)).toEqual({ kind: 'absent' })
  })

  it('answers that there is none when the file is empty', () => {
    const placement = project({ 'AGENTS.md': '   \n\n' })
    expect(readProjectInstructions(placement)).toEqual({ kind: 'absent' })
  })

  it('does not read into a file over the carried size, and says how big it is', () => {
    const placement = project({ 'AGENTS.md': 'x'.repeat(17 * 1024) })
    const instructions = readProjectInstructions(placement)

    expect(instructions.kind).toBe('unreadable')
    if (instructions.kind === 'unreadable') expect(instructions.error).toContain('over the')
  })

  it('refuses a file that is not text', () => {
    const placement = project({ 'AGENTS.md': 'PNG\u0000binary' })
    const instructions = readProjectInstructions(placement)

    expect(instructions).toEqual({ kind: 'unreadable', file: 'AGENTS.md', error: 'it is not a text file' })
  })

  it('refuses something with the file name that is not a file', () => {
    const placement = project()
    if (!placement.ok) throw new Error('unreachable')
    mkdirSync(path.join(placement.project.path, 'AGENTS.md'))

    expect(readProjectInstructions(placement)).toEqual({
      kind: 'unreadable',
      file: 'AGENTS.md',
      error: 'AGENTS.md is not a file',
    })
  })

  it('answers that there is none when there is no project, or its folder is gone', () => {
    expect(readProjectInstructions(undefined)).toEqual({ kind: 'absent' })
    expect(readProjectInstructions({ ok: false, id: 'p1', error: 'the folder is gone' })).toEqual({
      kind: 'absent',
    })
  })
})

describe('readOwnInstructions', () => {
  it("reads the AGENTS.md in Milo's own directory", () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milo-own-instructions-'))
    writeFileSync(path.join(dir, 'AGENTS.md'), 'Answer in English.\n')

    expect(readOwnInstructions(dir)).toEqual({
      kind: 'present',
      file: 'AGENTS.md',
      text: 'Answer in English.',
    })
  })

  it('answers that there are none when the directory has no AGENTS.md', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milo-own-instructions-'))
    expect(readOwnInstructions(dir)).toEqual({ kind: 'absent' })
  })

  it('does not read CLAUDE.md as the install’s own rules', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milo-own-instructions-'))
    writeFileSync(path.join(dir, 'CLAUDE.md'), 'Some other agent’s rules.')

    expect(readOwnInstructions(dir)).toEqual({ kind: 'absent' })
  })
})

describe('the rules a turn writes for itself', () => {
  /** A fresh folder, with `AGENTS.md` written only when a body is given. */
  function file(body?: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'milo-rules-'))
    const target = path.join(dir, 'AGENTS.md')
    if (body !== undefined) writeFileSync(target, body)
    return target
  }

  const contents = (target: string) => readFileSync(target, 'utf8')

  it('makes the heading for a file that had none', async () => {
    const target = file()
    expect(await addRule(target, 'Keep answers to a few lines.')).toEqual({
      kind: 'written',
      text: 'Keep answers to a few lines.',
    })

    expect(contents(target)).toBe(`${PREFERENCES_HEADING}\n- Keep answers to a few lines.\n`)
  })

  it('adds to the section without touching what the person wrote around it', async () => {
    const target = file('# Mine\n\n## Preferences\n- One.\n\n## Commits\n- Lowercase.')
    await addRule(target, 'Two.')

    expect(contents(target)).toBe(
      '# Mine\n\n## Preferences\n- One.\n- Two.\n\n## Commits\n- Lowercase.\n',
    )
  })

  it('puts the section at the end when the file has headings but not this one', async () => {
    const target = file('# Mine\n\n## Commits\n- Lowercase.')
    await addRule(target, 'Be brief.')

    expect(contents(target)).toBe(
      `# Mine\n\n## Commits\n- Lowercase.\n\n${PREFERENCES_HEADING}\n- Be brief.\n`,
    )
  })

  it('does not write a rule the file already carries', async () => {
    const target = file(`${PREFERENCES_HEADING}\n- Be brief.\n`)
    expect(await addRule(target, 'Be brief.')).toEqual({ kind: 'present', text: 'Be brief.' })

    expect(contents(target)).toBe(`${PREFERENCES_HEADING}\n- Be brief.\n`)
  })

  it('takes the bullet the model wrote off the rule it is given', async () => {
    const target = file()
    await addRule(target, '  - Be brief.  ')

    expect(contents(target)).toBe(`${PREFERENCES_HEADING}\n- Be brief.\n`)
  })

  it('drops one rule and leaves the others', async () => {
    const target = file(`${PREFERENCES_HEADING}\n- One.\n- Two.\n`)
    expect(await removeRule(target, 'One.')).toEqual({ kind: 'written', text: 'One.' })

    expect(contents(target)).toBe(`${PREFERENCES_HEADING}\n- Two.\n`)
  })

  it('takes the heading with the last rule it held', async () => {
    const target = file(`# Mine\n\n${PREFERENCES_HEADING}\n- One.\n\n## Commits\n- Lowercase.`)
    await removeRule(target, 'One.')

    expect(contents(target)).toBe('# Mine\n\n## Commits\n- Lowercase.\n')
  })

  it('has nothing to drop when no rule reads that way', async () => {
    const target = file(`${PREFERENCES_HEADING}\n- Be brief.\n`)
    expect(await removeRule(target, 'Be verbose.')).toEqual({ kind: 'absent', text: 'Be verbose.' })

    expect(contents(target)).toBe(`${PREFERENCES_HEADING}\n- Be brief.\n`)
  })

  it('refuses a rule that is not one line, and writes nothing', async () => {
    const target = file()
    const answer = await addRule(target, 'Be brief.\nAnd kind.')

    expect(answer.kind).toBe('refused')
    expect(existsSync(target)).toBe(false)
  })

  it('refuses a rule longer than a line the prompt can carry', async () => {
    const target = file()
    const answer = await addRule(target, 'x'.repeat(241))

    expect(answer.kind).toBe('refused')
    if (answer.kind === 'refused') expect(answer.error).toContain('at most')
  })

  it('refuses a rule that would push the file past what the prompt carries', async () => {
    // Over the 16 KiB the reader takes: past it the prompt drops the whole file, so
    // one more rule would cost the person every rule already there.
    const long = Array.from({ length: 90 }, () => `- ${'x'.repeat(200)}`).join('\n')
    const target = file(`${PREFERENCES_HEADING}\n${long}\n`)
    const answer = await addRule(target, 'One more.')

    expect(answer.kind).toBe('refused')
    if (answer.kind === 'refused') expect(answer.error).toContain('Remove one first')
  })

  it('reads only the bullets under the heading, in the order they sit', async () => {
    const text = `# Mine\n- Not a rule of ours.\n\n${PREFERENCES_HEADING}\n- One.\n- Two.\n\n## Commits\n- Lowercase.`

    expect(writtenRules(text)).toEqual(['One.', 'Two.'])
    expect(writtenRules('# Mine\n- Not a rule of ours.')).toEqual([])
  })

  it('reads the rules off the file, and no rules off a file that is not there', async () => {
    const target = file(`${PREFERENCES_HEADING}\n- One.\n`)

    expect(await readWrittenRules(target)).toEqual(['One.'])
    expect(await readWrittenRules(`${target}.gone`)).toEqual([])
  })

  it('puts the install’s rules and a project’s in the files the prompt reads', () => {
    expect(instructionsPath('install', '/work/demo', '/home/person/.milo')).toBe(
      path.join('/home/person/.milo', 'AGENTS.md'),
    )
    expect(instructionsPath('project', '/work/demo', '/home/person/.milo')).toBe(
      path.join('/work/demo', 'AGENTS.md'),
    )
    expect(instructionsPath('project', undefined, '/home/person/.milo')).toBeUndefined()
  })
})
