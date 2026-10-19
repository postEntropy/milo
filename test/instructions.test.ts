import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readOwnInstructions, readProjectInstructions } from '../src/core/agent/instructions.js'
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
