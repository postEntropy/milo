import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Project } from '../src/core/projects.js'
import {
  discoverChecks,
  runChecks,
  verificationText,
  verifyProject,
} from '../src/core/verification.js'

function project(files: Record<string, string> = {}, checks?: Project['checks']): Project {
  const dir = mkdtempSync(path.join(tmpdir(), 'milo-verify-'))
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, body)
  }
  return { id: 'p1', name: 'Demo', path: dir, createdAt: 0, ...(checks ? { checks } : {}) }
}

describe('discoverChecks', () => {
  it('takes the explicit checks over anything in the folder', () => {
    const found = discoverChecks(
      project({ 'package.json': JSON.stringify({ scripts: { test: 'vitest' } }) }, [
        { name: 'mine', command: 'make verify' },
      ]),
    )
    expect(found).toEqual({ kind: 'checks', checks: [{ name: 'mine', command: 'make verify' }] })
  })

  it('reads the npm scripts a project declares, in order', () => {
    const found = discoverChecks(
      project({
        'package-lock.json': '{}',
        'package.json': JSON.stringify({
          scripts: { lint: 'biome check .', test: 'vitest run', typecheck: 'tsc --noEmit', build: 'tsup' },
        }),
      }),
    )
    expect(found).toEqual({
      kind: 'checks',
      checks: [
        { name: 'test', command: 'npm run test' },
        { name: 'typecheck', command: 'npm run typecheck' },
        { name: 'lint', command: 'npm run lint' },
      ],
    })
  })

  it('skips the npm placeholder test', () => {
    const found = discoverChecks(
      project({
        'package.json': JSON.stringify({
          scripts: { test: 'echo "Error: no test specified" && exit 1' },
        }),
      }),
    )
    expect(found.kind).toBe('none')
  })

  it('spells the script the package manager way', () => {
    const scripts = JSON.stringify({ scripts: { test: 'vitest run' } })
    expect(discoverChecks(project({ 'pnpm-lock.yaml': '', 'package.json': scripts }))).toMatchObject({
      checks: [{ command: 'pnpm run test' }],
    })
    expect(discoverChecks(project({ 'yarn.lock': '', 'package.json': scripts }))).toMatchObject({
      checks: [{ command: 'yarn test' }],
    })
    expect(discoverChecks(project({ 'bun.lockb': '', 'package.json': scripts }))).toMatchObject({
      checks: [{ command: 'bun run test' }],
    })
  })

  it('reads Cargo, Go, Python and Makefile projects', () => {
    expect(discoverChecks(project({ 'Cargo.toml': '[package]' }))).toEqual({
      kind: 'checks',
      checks: [
        { name: 'test', command: 'cargo test' },
        { name: 'check', command: 'cargo check' },
      ],
    })
    expect(discoverChecks(project({ 'go.mod': 'module x' }))).toEqual({
      kind: 'checks',
      checks: [{ name: 'test', command: 'go test ./...' }],
    })
    expect(discoverChecks(project({ 'pyproject.toml': '[tool.ruff]\nline-length = 100' }))).toEqual({
      kind: 'checks',
      checks: [
        { name: 'test', command: 'pytest' },
        { name: 'lint', command: 'ruff check .' },
      ],
    })
    expect(discoverChecks(project({ Makefile: 'build:\n\ttrue\ntest:\n\ttrue\n' }))).toEqual({
      kind: 'checks',
      checks: [{ name: 'test', command: 'make test' }],
    })
  })

  it('answers none, and says why, when the folder declares no checks', () => {
    const found = discoverChecks(project({ 'README.md': 'x' }))
    expect(found.kind).toBe('none')
    if (found.kind === 'none') expect(found.reason).toContain('no test, typecheck or lint command')
  })

  it('says a malformed package.json is unreadable, rather than guessing', () => {
    expect(discoverChecks(project({ 'package.json': '{ nope' }))).toMatchObject({ kind: 'unreadable' })
  })
})

describe('runChecks', () => {
  it('reports what a check answered', async () => {
    const [ok, failed] = await runChecks(
      [
        { name: 'ok', command: 'exit 0' },
        { name: 'failed', command: 'echo boom; exit 3' },
      ],
      { cwd: process.cwd(), timeoutMs: 5_000 },
    )

    expect(ok).toMatchObject({ ok: true, exitCode: 0 })
    expect(failed).toMatchObject({ ok: false, exitCode: 3 })
    expect(failed?.output).toContain('boom')
  })

  it('kills a check that outlives its timeout', async () => {
    const [slow] = await runChecks(
      [{ name: 'slow', command: 'sleep 5' }],
      { cwd: process.cwd(), timeoutMs: 50 },
    )

    expect(slow).toMatchObject({ ok: false, timedOut: true })
  })

  it('runs the project checks and answers one verdict', async () => {
    const result = await verifyProject(
      project({ 'package.json': JSON.stringify({ scripts: { test: 'exit 0' } }) }, [
        { name: 'test', command: 'exit 0' },
      ]),
    )

    expect(result).toMatchObject({ kind: 'checks', ok: true })
  })
})

describe('verificationText', () => {
  it('says a pass by the checks that ran', () => {
    expect(
      verificationText({
        kind: 'checks',
        ok: true,
        checks: [
          { name: 'test', command: 'npm test', ok: true, exitCode: 0, timedOut: false, ms: 1, output: '' },
          { name: 'lint', command: 'npm run lint', ok: true, exitCode: 0, timedOut: false, ms: 1, output: '' },
        ],
      }),
    ).toBe('Checks passed — test, lint.')
  })

  it('says what failed, and what it answered', () => {
    const text = verificationText({
      kind: 'checks',
      ok: false,
      checks: [
        {
          name: 'test',
          command: 'npm test',
          ok: false,
          exitCode: 1,
          timedOut: false,
          ms: 1,
          output: 'one failing line\nanother',
        },
      ],
    })

    expect(text).toContain('Checks failed — 1 of 1.')
    expect(text).toContain('test (npm test): exit 1')
    expect(text).toContain('one failing line')
  })

  it('says why there was nothing to run', () => {
    expect(verificationText({ kind: 'none', reason: 'no package.json' })).toContain('No checks to run')
    expect(verificationText({ kind: 'unreadable', error: 'bad JSON' })).toContain('could not be read')
  })
})
