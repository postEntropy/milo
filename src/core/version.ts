import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface InstallVersionInfo {
  version: string
  installRoot: string
  isGitRepo: boolean
  commit?: string
  fullCommit?: string
  branch?: string
  commitDate?: string
  dirty?: boolean
}

/**
 * Finds the Milo installation root by walking up from `fromDir` until
 * `package.json` for `milo` is found.
 */
export function findInstallRoot(fromDir = path.dirname(fileURLToPath(import.meta.url))): string {
  let current = path.resolve(fromDir)
  for (let depth = 0; depth < 8; depth += 1) {
    const pkgPath = path.join(current, 'package.json')
    if (existsSync(pkgPath)) {
      try {
        const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string }
        if (parsed.name === 'milo') return current
      } catch {
        // Keep walking if a stray package.json could not be parsed.
      }
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return path.resolve(fromDir, '../..')
}

function readPackageVersion(root: string): string {
  try {
    const parsed = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version?: string }
    return typeof parsed.version === 'string' && parsed.version.trim() ? parsed.version.trim() : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function runGit(root: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3_000,
    }).trim()
  } catch {
    return null
  }
}

/**
 * Reads the package version and, when running from a git checkout, the
 * checked-out commit hash, branch, commit date, and working tree status.
 */
export function readInstallVersion(installRoot = findInstallRoot()): InstallVersionInfo {
  const version = readPackageVersion(installRoot)
  if (!existsSync(path.join(installRoot, '.git'))) {
    return { version, installRoot, isGitRepo: false }
  }

  const commit = runGit(installRoot, ['rev-parse', '--short', 'HEAD'])
  if (!commit) {
    return { version, installRoot, isGitRepo: false }
  }

  const fullCommit = runGit(installRoot, ['rev-parse', 'HEAD']) ?? undefined
  const branch = runGit(installRoot, ['rev-parse', '--abbrev-ref', 'HEAD']) ?? undefined
  const commitDate = runGit(installRoot, ['show', '-s', '--format=%cI', 'HEAD']) ?? undefined
  const status = runGit(installRoot, ['status', '--porcelain'])
  const dirty = status !== null ? status.length > 0 : undefined

  return {
    version,
    installRoot,
    isGitRepo: true,
    commit,
    fullCommit,
    branch,
    commitDate,
    dirty,
  }
}

/** Formats install version info into one concise human-readable line. */
export function formatInstallVersion(info: InstallVersionInfo): string {
  if (!info.commit) return info.version
  const details = [
    info.commit,
    info.branch && info.branch !== 'HEAD' ? info.branch : null,
    info.commitDate ? info.commitDate.slice(0, 10) : null,
    info.dirty ? 'modified' : null,
  ].filter((part): part is string => Boolean(part))
  return `${info.version} (${details.join(' · ')})`
}
