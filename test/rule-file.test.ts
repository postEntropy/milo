import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  loadRules,
  matchingRule,
  readRuleFile,
  ruleMatches,
  type PermissionRule,
  type RuleBook,
} from '../src/core/tools/rule-file.js'

function folder(): string {
  return mkdtempSync(path.join(tmpdir(), 'milo-rules-'))
}

function write(file: string, body: string): string {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, body)
  return file
}

const book = (...rules: PermissionRule[]): RuleBook => ({ kind: 'rules', rules })

describe('readRuleFile', () => {
  it('reads a rules file', () => {
    const file = write(
      path.join(folder(), 'rules.yml'),
      ['rules:', '  - match: "npm test*"', '    action: allow'].join('\n'),
    )

    expect(readRuleFile(file)).toEqual({
      kind: 'rules',
      rules: [{ match: 'npm test*', action: 'allow' }],
    })
  })

  it('answers absent for a missing or empty file', () => {
    expect(readRuleFile(path.join(folder(), 'rules.yml'))).toEqual({ kind: 'absent' })
    expect(readRuleFile(write(path.join(folder(), 'rules.yml'), '  \n'))).toEqual({ kind: 'absent' })
  })

  it('answers unreadable for a file it cannot parse, or one that is too big', () => {
    const invalid = write(path.join(folder(), 'rules.yml'), 'rules: not-a-list')
    expect(readRuleFile(invalid).kind).toBe('unreadable')

    const huge = write(path.join(folder(), 'rules.yml'), `rules: []\n${'#'.repeat(17 * 1024)}`)
    expect(readRuleFile(huge).kind).toBe('unreadable')
  })

  it('refuses an unknown action', () => {
    const file = write(
      path.join(folder(), 'rules.yml'),
      ['rules:', '  - match: "ls"', '    action: maybe'].join('\n'),
    )
    expect(readRuleFile(file).kind).toBe('unreadable')
  })
})

describe('matchingRule', () => {
  it('matches a command glob, and reads an absent match as every command', () => {
    expect(matchingRule(book({ match: 'npm test*', action: 'allow' }), 'npm test -- --watch')).toMatchObject({
      action: 'allow',
    })
    expect(matchingRule(book({ action: 'deny' }), 'anything at all')).toMatchObject({ action: 'deny' })
    expect(matchingRule(book({ match: 'git push --force*', action: 'deny' }), 'git status')).toBeUndefined()
  })

  it('reads not_match as a narrowing of the match', () => {
    expect(ruleMatches({ match: 'git *', not_match: 'git status', action: 'ask' }, 'git status')).toBe(false)
    expect(ruleMatches({ match: 'git *', not_match: 'git status', action: 'ask' }, 'git push')).toBe(true)
  })

  it('tests each command on the line, with sudo peeled off', () => {
    expect(matchingRule(book({ match: 'npm test*', action: 'allow' }), 'cd app && npm test')).toMatchObject({
      action: 'allow',
    })
    expect(matchingRule(book({ match: 'rm *', action: 'deny' }), 'true; sudo -u root rm -rf /')).toMatchObject({
      action: 'deny',
    })
  })

  it('never lets an unreadable command match an allow', () => {
    const rules = book({ match: '*', action: 'allow' })
    expect(matchingRule(rules, 'echo $(date)')).toBeUndefined()
    expect(matchingRule(rules, 'sh -c "rm -rf /"')).toBeUndefined()
    // Denying what cannot be read is still allowed to match.
    expect(matchingRule(book({ match: '*', action: 'deny' }), 'echo $(date)')).toMatchObject({ action: 'deny' })
  })
})

describe('loadRules', () => {
  it("puts the project's rules before the install's", () => {
    const cwd = folder()
    write(
      path.join(cwd, '.milo', 'rules.yml'),
      ['rules:', '  - match: "npm test*"', '    action: deny'].join('\n'),
    )
    const global = write(
      path.join(folder(), 'rules.yml'),
      ['rules:', '  - match: "npm test*"', '    action: allow'].join('\n'),
    )

    const loaded = loadRules(cwd, global)
    expect(loaded.kind).toBe('rules')
    if (loaded.kind !== 'rules') return
    expect(loaded.rules.map((rule) => rule.action)).toEqual(['deny', 'allow'])
    expect(matchingRule(loaded, 'npm test')).toMatchObject({ action: 'deny' })
  })

  it('keeps a readable file when the other one is broken', () => {
    const cwd = folder()
    write(path.join(cwd, '.milo', 'rules.yml'), 'rules: nope')
    const global = write(
      path.join(folder(), 'rules.yml'),
      ['rules:', '  - match: "ls*"', '    action: allow'].join('\n'),
    )

    expect(loadRules(cwd, global)).toMatchObject({ kind: 'rules' })
  })

  it('answers unreadable when nothing could be read', () => {
    const cwd = folder()
    write(path.join(cwd, '.milo', 'rules.yml'), 'rules: nope')
    const global = path.join(folder(), 'rules.yml')

    expect(loadRules(cwd, global)).toMatchObject({ kind: 'unreadable' })
  })
})
