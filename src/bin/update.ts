import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { findInstallRoot, formatInstallVersion, readInstallVersion } from '../core/version.js'
import { errorMessage } from '../util/errors.js'

export interface UpdateIo {
  out(line: string): void
  err(line: string): void
}

export interface CommandOutcome {
  code: number
  stdout: string
  stderr: string
}

export interface RunCommandOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  onOutput?: (line: string, stream: 'stdout' | 'stderr') => void
}

export interface UpdateDeps {
  installRoot?: string
  run?: (
    command: string,
    args: string[],
    options: RunCommandOptions,
  ) => Promise<CommandOutcome>
}

const USAGE = [
  'Usage:',
  '  milo update                 Pull the latest commits from GitHub and rebuild',
  '  milo update --check         Check for new commits without modifying anything',
  '  milo update --branch <ref>  Switch to and pull a specific branch',
  '  milo update --to <ref>      Check out and build a specific commit SHA or tag',
  '  milo update --force         Rebuild even when already at the target commit',
].join('\n')

interface ParsedUpdateArgs {
  check: boolean
  force: boolean
  help: boolean
  branch?: string
  to?: string
  error?: string
}

function parseUpdateArgs(argv: string[]): ParsedUpdateArgs {
  const args = argv[0] === 'update' ? argv.slice(1) : argv
  const parsed: ParsedUpdateArgs = { check: false, force: false, help: false }

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (arg === '--check') {
      parsed.check = true
    } else if (arg === '--force') {
      parsed.force = true
    } else if (arg === '--help' || arg === '-h' || arg === 'help') {
      parsed.help = true
    } else if (arg === '--branch') {
      const value = args[i + 1]
      if (!value || value.startsWith('-')) {
        return { ...parsed, error: 'Missing value for "--branch".' }
      }
      parsed.branch = value
      i += 1
    } else if (arg === '--to') {
      const value = args[i + 1]
      if (!value || value.startsWith('-')) {
        return { ...parsed, error: 'Missing value for "--to".' }
      }
      parsed.to = value
      i += 1
    } else {
      return {
        ...parsed,
        error: `Unknown option "${arg}". Valid options: --check, --branch <ref>, --to <ref>, --force, --help (-h).`,
      }
    }
  }

  if (parsed.branch && parsed.to) {
    return { ...parsed, error: 'Use either --branch or --to, not both.' }
  }

  return parsed
}

function defaultRun(
  command: string,
  args: string[],
  options: RunCommandOptions,
): Promise<CommandOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const emitLines = (stream: 'stdout' | 'stderr') => {
      let pending = ''
      return {
        push(chunk: Buffer) {
          if (!options.onOutput) return
          pending += chunk.toString('utf8')
          const lines = pending.split(/\r?\n/)
          pending = lines.pop() ?? ''
          for (const line of lines) {
            if (line.length > 0) options.onOutput(line, stream)
          }
        },
        flush() {
          if (options.onOutput && pending.length > 0) {
            options.onOutput(pending, stream)
          }
          pending = ''
        },
      }
    }
    const outStream = emitLines('stdout')
    const errStream = emitLines('stderr')
    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(chunk)
      outStream.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.push(chunk)
      errStream.push(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      outStream.flush()
      errStream.flush()
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    })
  })
}

async function execChecked(
  run: NonNullable<UpdateDeps['run']>,
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  onOutput?: RunCommandOptions['onOutput'],
): Promise<string> {
  const result = await run(command, args, { cwd, env, onOutput })
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`
    throw new Error(`${command} ${args.join(' ')} failed: ${detail}`)
  }
  return result.stdout.trim()
}

function buildEnv(): NodeJS.ProcessEnv {
  // NODE_ENV=production makes npm ci prune devDependencies (tsup, tsc, vite),
  // breaking the build on VPS setups where NODE_ENV=production is exported globally.
  return {
    ...process.env,
    NODE_ENV: 'development',
  }
}

function backupBuildArtifacts(root: string, rollbackRoot: string): { hasRootDist: boolean; hasWebDist: boolean } {
  const rootDist = path.join(root, 'dist')
  const webDist = path.join(root, 'web', 'dist')
  const hasRootDist = existsSync(rootDist)
  const hasWebDist = existsSync(webDist)
  if (hasRootDist) {
    cpSync(rootDist, path.join(rollbackRoot, 'dist'), { recursive: true })
  }
  if (hasWebDist) {
    cpSync(webDist, path.join(rollbackRoot, 'web-dist'), { recursive: true })
  }
  return { hasRootDist, hasWebDist }
}

function restoreBuildArtifacts(root: string, rollbackRoot: string, saved: { hasRootDist: boolean; hasWebDist: boolean }): void {
  const rootDist = path.join(root, 'dist')
  const webDist = path.join(root, 'web', 'dist')
  if (saved.hasRootDist) {
    rmSync(rootDist, { recursive: true, force: true })
    cpSync(path.join(rollbackRoot, 'dist'), rootDist, { recursive: true })
  }
  if (saved.hasWebDist) {
    rmSync(webDist, { recursive: true, force: true })
    cpSync(path.join(rollbackRoot, 'web-dist'), webDist, { recursive: true })
  }
}

/**
 * `milo update`: checks or pulls commits from GitHub and rebuilds the server
 * and web UI in place, with rollback on failure.
 */
export async function runUpdate(
  argv: string[] = [],
  io: Partial<UpdateIo> = {},
  deps: UpdateDeps = {},
): Promise<number> {
  const out = io.out ?? ((line: string) => console.log(line))
  const err = io.err ?? ((line: string) => console.error(line))
  const run = deps.run ?? defaultRun

  const parsed = parseUpdateArgs(argv)
  if (parsed.help) {
    out(USAGE)
    return 0
  }
  if (parsed.error) {
    err(parsed.error)
    err(USAGE)
    return 1
  }

  const root = deps.installRoot ?? findInstallRoot()
  const env = buildEnv()
  const streamBuild: RunCommandOptions['onOutput'] = (line, stream) => {
    if (stream === 'stderr') err(`  ${line}`)
    else out(`  ${line}`)
  }

  let rollbackRoot: string | undefined

  try {
    if (!existsSync(path.join(root, '.git'))) {
      err(`This Milo install (${root}) is not a git checkout. Install via install.sh to update from GitHub.`)
      return 1
    }

    const inside = await execChecked(run, 'git', ['rev-parse', '--is-inside-work-tree'], root, env)
    if (inside !== 'true') {
      err(`This Milo install (${root}) is not a git checkout.`)
      return 1
    }

    const dirty = await execChecked(run, 'git', ['status', '--porcelain'], root, env)
    if (dirty.length > 0 && !parsed.check) {
      err(`Working tree in ${root} has uncommitted changes. Commit or stash them before updating.`)
      return 1
    }

    const currentBranch = await execChecked(run, 'git', ['rev-parse', '--abbrev-ref', 'HEAD'], root, env)
    const beforeCommit = await execChecked(run, 'git', ['rev-parse', '--short', 'HEAD'], root, env)
    const beforeFull = await execChecked(run, 'git', ['rev-parse', 'HEAD'], root, env)

    let targetBranch: string | undefined
    let behind = 0
    let logOut = ''
    let targetCommit: string | undefined

    if (parsed.to) {
      out(`Fetching origin refs for ${parsed.to}…`)
      await execChecked(run, 'git', ['fetch', 'origin', '--tags'], root, env)
      // Best-effort direct ref fetch in case `--to` names an un-fetched branch or SHA.
      await run('git', ['fetch', 'origin', parsed.to], { cwd: root, env })

      targetCommit = await execChecked(run, 'git', ['rev-parse', '--verify', `${parsed.to}^{commit}`], root, env)
      const targetShort = await execChecked(run, 'git', ['rev-parse', '--short', targetCommit], root, env)

      if (parsed.check) {
        if (beforeFull === targetCommit) {
          out(`Already at ${targetShort} (${parsed.to}).`)
        } else {
          out(`Target ${parsed.to} resolves to ${targetShort} (current: ${beforeCommit}).`)
        }
        return 0
      }

      if (beforeFull === targetCommit && !parsed.force) {
        const info = readInstallVersion(root)
        out(`Already at ${formatInstallVersion(info)}.`)
        return 0
      }
    } else {
      targetBranch = parsed.branch ?? (currentBranch !== 'HEAD' ? currentBranch : undefined)
      if (!targetBranch) {
        err('Detached HEAD: specify which branch or commit to use with `milo update --branch <ref>` or `--to <ref>`.')
        return 1
      }

      out(`Fetching origin/${targetBranch}…`)
      await execChecked(run, 'git', ['fetch', 'origin', targetBranch, '--tags'], root, env)

      const remoteRef = `origin/${targetBranch}`
      const behindRaw = await execChecked(run, 'git', ['rev-list', '--count', `HEAD..${remoteRef}`], root, env)
      behind = Number(behindRaw) || 0
      logOut = behind > 0
        ? await execChecked(run, 'git', ['log', '--oneline', '-n', '20', `HEAD..${remoteRef}`], root, env)
        : ''

      if (parsed.check) {
        if (behind === 0 && currentBranch === targetBranch) {
          out(`Up to date (${beforeCommit} on ${targetBranch}).`)
        } else {
          out(`Update available: ${behind} new commit(s) on ${remoteRef} (current: ${beforeCommit} on ${currentBranch}).`)
          if (logOut) {
            for (const line of logOut.split('\n')) out(`  ${line}`)
          }
        }
        return 0
      }

      const switchingBranch = currentBranch !== targetBranch
      if (behind === 0 && !switchingBranch && !parsed.force) {
        const info = readInstallVersion(root)
        out(`Already up to date (${formatInstallVersion(info)}).`)
        return 0
      }
    }

    rollbackRoot = mkdtempSync(path.join(os.tmpdir(), 'milo-update-rollback-'))
    const savedArtifacts = backupBuildArtifacts(root, rollbackRoot)
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const hasRootLock = existsSync(path.join(root, 'package-lock.json'))
    const hasWebLock = existsSync(path.join(root, 'web', 'package-lock.json'))
    const webDir = path.join(root, 'web')
    let rootDepsTouched = false
    let webDepsTouched = false

    try {
      if (parsed.to && targetCommit) {
        if (beforeFull !== targetCommit) {
          await execChecked(run, 'git', ['checkout', '--detach', targetCommit], root, env)
        }
      } else if (targetBranch) {
        const remoteRef = `origin/${targetBranch}`
        const switchingBranch = currentBranch !== targetBranch
        if (switchingBranch) {
          const localExists = await run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${targetBranch}`], { cwd: root, env })
          if (localExists.code === 0) {
            await execChecked(run, 'git', ['checkout', targetBranch], root, env)
          } else {
            await execChecked(run, 'git', ['checkout', '-B', targetBranch, remoteRef], root, env)
          }
        }

        if (behind > 0 || switchingBranch) {
          await execChecked(run, 'git', ['pull', '--ff-only', 'origin', targetBranch], root, env)
        }
      }

      out('Installing dependencies and building Milo…')
      rootDepsTouched = true
      await execChecked(run, npmCmd, [hasRootLock ? 'ci' : 'install', '--include=dev'], root, env, streamBuild)
      await execChecked(run, npmCmd, ['run', 'build'], root, env, streamBuild)

      out('Building web UI…')
      webDepsTouched = true
      await execChecked(run, npmCmd, [hasWebLock ? 'ci' : 'install', '--include=dev'], webDir, env, streamBuild)
      await execChecked(run, npmCmd, ['run', 'build'], webDir, env, streamBuild)
    } catch (buildError) {
      let depsRestored = true
      try {
        if (currentBranch !== 'HEAD') {
          await run('git', ['checkout', currentBranch], { cwd: root, env })
          await run('git', ['reset', '--hard', beforeFull], { cwd: root, env })
        } else {
          await run('git', ['checkout', '--detach', beforeFull], { cwd: root, env })
        }
        restoreBuildArtifacts(root, rollbackRoot, savedArtifacts)
        if (rootDepsTouched) {
          const res = await run(npmCmd, [hasRootLock ? 'ci' : 'install', '--prefer-offline', '--include=dev'], { cwd: root, env })
          if (res.code !== 0) depsRestored = false
        }
        if (webDepsTouched) {
          const res = await run(npmCmd, [hasWebLock ? 'ci' : 'install', '--prefer-offline', '--include=dev'], { cwd: webDir, env })
          if (res.code !== 0) depsRestored = false
        }
      } catch {
        depsRestored = false
      }
      const depsNote = (rootDepsTouched || webDepsTouched) && !depsRestored
        ? ' Run `milo update --force` to resync dependencies.'
        : ''
      err(`${errorMessage(buildError)}\nUpdate failed; restored git state (${beforeCommit}) and previous build.${depsNote}`)
      return 1
    }

    const afterCommit = await execChecked(run, 'git', ['rev-parse', '--short', 'HEAD'], root, env)
    const refLabel = parsed.to ? ` (${parsed.to})` : ` on ${targetBranch}`

    if (beforeCommit === afterCommit) {
      out(`Rebuilt ${afterCommit}${refLabel}.`)
    } else if (!parsed.to && behind > 0) {
      out(`Updated ${beforeCommit} -> ${afterCommit}${refLabel} (${behind} commit(s)).`)
      if (logOut) {
        for (const line of logOut.split('\n')) out(`  ${line}`)
      }
    } else {
      out(`Switched ${beforeCommit} -> ${afterCommit}${refLabel}.`)
    }
    out('If `milo serve` is running, restart it to load the new build.')
    return 0
  } catch (error) {
    err(errorMessage(error))
    return 1
  } finally {
    if (rollbackRoot) {
      rmSync(rollbackRoot, { recursive: true, force: true })
    }
  }
}
