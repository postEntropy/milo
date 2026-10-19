import { exec } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { errorMessage } from '../util/errors.js'
import type { Project, ProjectCheck } from './projects.js'
import { clipMiddle } from './tools/output.js'

/**
 * The project's own checks, run after a turn that wrote.
 *
 * The prompt tells the model to run the project's tests before saying it is
 * done. This is what makes that claim checkable: the turn ends with what the
 * checks actually answered, not with what the model said it ran. v1 reports —
 * it does not feed the failure back for the model to fix, because a gate that
 * also acts is a different, larger decision.
 *
 * Discovery is deliberately narrow: the commands the folder already declares,
 * in its package manager's own spelling. Nothing is invented.
 */

export interface CheckResult {
  name: string
  command: string
  ok: boolean
  exitCode: number | null
  timedOut: boolean
  ms: number
  /** Combined stdout and stderr, clipped: enough to see the first failure. */
  output: string
}

/** What a project declares, before anything ran. */
export type DiscoveredChecks =
  | { kind: 'checks'; checks: ProjectCheck[] }
  | { kind: 'none'; reason: string }
  | { kind: 'unreadable'; error: string }

/** What the gate came to: the declarations, and what each answered. */
export type VerificationResult =
  | { kind: 'checks'; checks: CheckResult[]; ok: boolean }
  | { kind: 'none'; reason: string }
  | { kind: 'unreadable'; error: string }

export interface VerifyOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_OUTPUT = 4_096
const MAX_BUFFER = 4 * 1024 * 1024

/**
 * The checks this project declares, or why there are none. Explicit checks in
 * `projects.json` win outright; otherwise the folder's own manifest is read.
 */
export function discoverChecks(project: Project): DiscoveredChecks {
  if (project.checks !== undefined) {
    if (!Array.isArray(project.checks)) {
      return { kind: 'unreadable', error: 'checks is not a list' }
    }
    const checks = project.checks.filter(
      (check): check is ProjectCheck =>
        Boolean(check) && typeof check.name === 'string' && typeof check.command === 'string' && check.command.trim() !== '',
    )
    if (checks.length !== project.checks.length) {
      return { kind: 'unreadable', error: 'every check needs a name and a command' }
    }
    return checks.length > 0
      ? { kind: 'checks', checks }
      : { kind: 'none', reason: 'the project lists no checks' }
  }

  const folder = project.path
  const packageChecks = readPackageChecks(folder)
  if (packageChecks.kind !== 'none') return packageChecks

  if (existsSync(path.join(folder, 'Cargo.toml'))) {
    return {
      kind: 'checks',
      checks: [
        { name: 'test', command: 'cargo test' },
        { name: 'check', command: 'cargo check' },
      ],
    }
  }

  if (existsSync(path.join(folder, 'go.mod'))) {
    return { kind: 'checks', checks: [{ name: 'test', command: 'go test ./...' }] }
  }

  const python = readPythonChecks(folder)
  if (python.kind !== 'none') return python

  if (makeHasTest(folder)) {
    return { kind: 'checks', checks: [{ name: 'test', command: 'make test' }] }
  }

  return {
    kind: 'none',
    reason: 'no test, typecheck or lint command found (package.json, Cargo.toml, go.mod, pyproject.toml, Makefile)',
  }
}

function readPackageChecks(folder: string): DiscoveredChecks {
  const file = path.join(folder, 'package.json')
  if (!existsSync(file)) return { kind: 'none', reason: 'no package.json' }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    return { kind: 'unreadable', error: `package.json: ${errorMessage(error)}` }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { kind: 'unreadable', error: 'package.json is not an object' }
  }

  const scripts = (parsed as { scripts?: unknown }).scripts
  if (!scripts || typeof scripts !== 'object') return { kind: 'none', reason: 'package.json has no scripts' }

  const manager = packageManager(folder)
  const checks: ProjectCheck[] = []
  for (const name of ['test', 'typecheck', 'lint', 'check']) {
    const value = (scripts as Record<string, unknown>)[name]
    if (typeof value !== 'string' || value.trim() === '') continue
    // `npm init` writes a failing placeholder; running it is not a check.
    if (name === 'test' && /no test specified/i.test(value)) continue
    checks.push({ name, command: scriptCommand(manager, name) })
  }
  return checks.length > 0 ? { kind: 'checks', checks } : { kind: 'none', reason: 'package.json has no test, typecheck, lint or check script' }
}

type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

function packageManager(folder: string): PackageManager {
  if (existsSync(path.join(folder, 'bun.lock')) || existsSync(path.join(folder, 'bun.lockb'))) return 'bun'
  if (existsSync(path.join(folder, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(path.join(folder, 'yarn.lock'))) return 'yarn'
  return 'npm'
}

function scriptCommand(manager: PackageManager, script: string): string {
  return manager === 'yarn' ? `yarn ${script}` : `${manager} run ${script}`
}

function readPythonChecks(folder: string): DiscoveredChecks {
  const pyproject = path.join(folder, 'pyproject.toml')
  if (!existsSync(pyproject)) return { kind: 'none', reason: 'no pyproject.toml' }

  let text = ''
  try {
    text = readFileSync(pyproject, 'utf8')
  } catch (error) {
    return { kind: 'unreadable', error: `pyproject.toml: ${errorMessage(error)}` }
  }

  const checks: ProjectCheck[] = [{ name: 'test', command: 'pytest' }]
  const ruff =
    existsSync(path.join(folder, 'ruff.toml')) ||
    existsSync(path.join(folder, '.ruff.toml')) ||
    text.includes('[tool.ruff')
  if (ruff) checks.push({ name: 'lint', command: 'ruff check .' })
  return { kind: 'checks', checks }
}

function makeHasTest(folder: string): boolean {
  const file = path.join(folder, 'Makefile')
  if (!existsSync(file)) return false
  try {
    return /^test\s*:/m.test(readFileSync(file, 'utf8'))
  } catch {
    return false
  }
}

/**
 * Runs the checks in order, one at a time. Sequential on purpose: parallel test
 * runs fight for the same CPU and interleave their output, and the point here is
 * a report a person can read.
 */
export async function runChecks(checks: ProjectCheck[], options: VerifyOptions & { cwd: string }): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  for (const check of checks) {
    if (options.signal?.aborted) break
    results.push(await runCheck(check, options.cwd, options.timeoutMs ?? DEFAULT_TIMEOUT_MS, options.signal))
  }
  return results
}

function runCheck(
  check: ProjectCheck,
  cwd: string,
  timeout: number,
  signal?: AbortSignal,
): Promise<CheckResult> {
  const started = Date.now()
  return new Promise<CheckResult>((resolve) => {
    exec(
      check.command,
      { cwd, timeout, maxBuffer: MAX_BUFFER, signal },
      (error, stdout, stderr) => {
        const combined = `${stdout}${stderr ? `${stdout ? '\n' : ''}${stderr}` : ''}`.trim()
        const failure = error as (NodeJS.ErrnoException & { killed?: boolean }) | null
        resolve({
          name: check.name,
          command: check.command,
          ok: !error,
          exitCode: error ? (typeof error.code === 'number' ? error.code : null) : 0,
          timedOut: Boolean(failure?.killed),
          ms: Date.now() - started,
          output: clipMiddle(combined, MAX_OUTPUT),
        })
      },
    )
  })
}

/**
 * The gate's report, in words every surface can draw as it is. The words live
 * here once: the terminal, the browser, the phone and the bots read the same
 * block, so they cannot disagree about whether the turn passed.
 */
export function verificationText(result: VerificationResult): string {
  if (result.kind === 'none') return `No checks to run — ${result.reason}.`
  if (result.kind === 'unreadable') return `The project's checks could not be read — ${result.error}.`

  if (result.ok) {
    return `Checks passed — ${result.checks.map((check) => check.name).join(', ')}.`
  }

  const failed = result.checks.filter((check) => !check.ok)
  const lines = [`Checks failed — ${failed.length} of ${result.checks.length}.`]
  for (const check of failed) {
    lines.push(
      `${check.name} (${check.command}): ${check.timedOut ? 'timed out' : `exit ${check.exitCode ?? 'unknown'}`}`,
    )
    const output = check.output
      .split('\n')
      .filter((line) => line.trim() !== '')
      .slice(0, 6)
      .map((line) => `  ${line.length > 200 ? `${line.slice(0, 197)}…` : line}`)
    lines.push(...output)
  }
  return lines.join('\n')
}

/** Discovery and execution in one call, as the session's injected `verify`. */
export async function verifyProject(project: Project, options: VerifyOptions = {}): Promise<VerificationResult> {
  const discovered = discoverChecks(project)
  if (discovered.kind !== 'checks') return discovered

  const checks = await runChecks(discovered.checks, {
    cwd: project.path,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  })
  return { kind: 'checks', checks, ok: checks.every((check) => check.ok) }
}
