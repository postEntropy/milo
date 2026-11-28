import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MILO_HOME } from './config/paths.js'
import { loadSqlite } from './memory/sql.js'
import { readInstallVersion } from './version.js'
import { errorMessage } from '../util/errors.js'
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from '../util/fs.js'

export interface InstallBackupManifest {
  format: 1
  appVersion: string
  commit?: string
  exportedAt: string
  hostname: string
  miloHome: string
  includes: {
    browser: boolean
    embed: boolean
    caches: boolean
    secrets: boolean
  }
  fileCount: number
  rawBytes: number
}

export interface ExportInstallOptions {
  miloHome?: string
  outPath?: string
  includeBrowser?: boolean
  includeEmbed?: boolean
  includeCaches?: boolean
  includeSecrets?: boolean
}

export interface ExportInstallResult {
  path: string
  bytes: number
  manifest: InstallBackupManifest
}

export interface InspectInstallResult {
  manifest: InstallBackupManifest
  entries: string[]
}

export interface ImportInstallOptions {
  archivePath: string
  miloHome?: string
  dryRun?: boolean
  backup?: boolean
}

export interface MissingProjectRef {
  id: string
  name: string
  path: string
}

export interface ImportInstallResult {
  dryRun: boolean
  miloHome: string
  backupPath?: string
  manifest: InstallBackupManifest
  missingProjects: MissingProjectRef[]
}

export type Outcome<T> = { ok: true; result: T } | { ok: false; error: string }

const EPHEMERAL_TOP_LEVEL = new Set(['pairing.json'])
const SECRET_TOP_LEVEL = new Set(['auth.json', 'devices.json'])
const CACHE_TOP_LEVEL = new Set(['models.json', 'mcp-cache.json'])
const PRIVATE_TOP_LEVEL_FILES = new Set(['auth.json', 'devices.json', 'config.yml', 'rules.yml', 'traces.jsonl'])

function timestampSlug(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('')
}

function isTransientFile(name: string): boolean {
  return name.endsWith('.lock') || name.endsWith('.pid') || name.endsWith('.tmp')
}

function isSqliteSidecar(dbName: string, entryName: string): boolean {
  return (
    entryName === dbName ||
    entryName === `${dbName}-wal` ||
    entryName === `${dbName}-shm` ||
    entryName === `${dbName}-journal`
  )
}

function snapshotSqlite(srcDb: string, destDb: string): void {
  const { DatabaseSync } = loadSqlite()
  mkdirSync(path.dirname(destDb), { recursive: true, mode: PRIVATE_DIR_MODE })
  const db = new DatabaseSync(srcDb)
  try {
    db.exec('pragma busy_timeout = 5000')
    const escaped = destDb.replace(/'/g, "''")
    db.exec(`VACUUM INTO '${escaped}'`)
  } finally {
    db.close()
  }
  chmodSync(destDb, PRIVATE_FILE_MODE)
}

function copyTreeFiltered(
  srcDir: string,
  destDir: string,
  options: { skipNames?: (name: string) => boolean; skipSubdir?: string },
): { fileCount: number; rawBytes: number } {
  mkdirSync(destDir, { recursive: true, mode: PRIVATE_DIR_MODE })
  let fileCount = 0
  let rawBytes = 0

  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (isTransientFile(entry.name)) continue
    if (options.skipNames?.(entry.name)) continue
    if (options.skipSubdir && entry.name === options.skipSubdir) continue

    const srcPath = path.join(srcDir, entry.name)
    const destPath = path.join(destDir, entry.name)
    const stat = lstatSync(srcPath)

    if (stat.isSymbolicLink()) {
      // Dereference valid symlinks inside skills/etc., skip broken ones.
      try {
        const targetStat = statSync(srcPath)
        if (targetStat.isDirectory()) {
          const sub = copyTreeFiltered(srcPath, destPath, {})
          fileCount += sub.fileCount
          rawBytes += sub.rawBytes
        } else if (targetStat.isFile()) {
          copyFileSync(srcPath, destPath)
          chmodSync(destPath, targetStat.mode & 0o777)
          fileCount += 1
          rawBytes += targetStat.size
        }
      } catch {
        // Broken symlink: skip rather than aborting backup.
      }
      continue
    }

    if (stat.isDirectory()) {
      const sub = copyTreeFiltered(srcPath, destPath, {})
      fileCount += sub.fileCount
      rawBytes += sub.rawBytes
      continue
    }

    if (stat.isFile()) {
      copyFileSync(srcPath, destPath)
      chmodSync(destPath, stat.mode & 0o777)
      fileCount += 1
      rawBytes += stat.size
    }
  }

  return { fileCount, rawBytes }
}

function moveDirectory(src: string, dest: string): void {
  try {
    renameSync(src, dest)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code !== 'EXDEV') throw error
    // Cross-filesystem move (for example /tmp tmpfs -> ~/.milo on disk).
    cpSync(src, dest, { recursive: true, preserveTimestamps: true })
    rmSync(src, { recursive: true, force: true })
  }
}

function moveFile(src: string, dest: string): void {
  try {
    renameSync(src, dest)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code !== 'EXDEV') throw error
    copyFileSync(src, dest)
    rmSync(src, { force: true })
  }
}

function resolveExportPath(outPath?: string): string {
  const defaultName = `milo-backup-${timestampSlug()}.tar.gz`
  if (!outPath) return path.resolve(process.cwd(), defaultName)
  const resolved = path.resolve(outPath)
  if (existsSync(resolved) && statSync(resolved).isDirectory()) {
    return path.join(resolved, defaultName)
  }
  return resolved
}

/**
 * Packages the Milo installation data directory (`MILO_HOME`) into a `.tar.gz`
 * archive with consistent SQLite snapshots and a `manifest.json`.
 */
export function exportInstallation(options: ExportInstallOptions = {}): Outcome<ExportInstallResult> {
  const miloHome = path.resolve(options.miloHome ?? MILO_HOME)
  if (!existsSync(miloHome) || !statSync(miloHome).isDirectory()) {
    return { ok: false, error: `Milo data directory does not exist: ${miloHome}` }
  }

  const includeBrowser = Boolean(options.includeBrowser)
  const includeEmbed = Boolean(options.includeEmbed)
  const includeCaches = Boolean(options.includeCaches)
  const includeSecrets = options.includeSecrets !== false

  const targetPath = resolveExportPath(options.outPath)
  const stagingRoot = mkdtempSync(path.join(os.tmpdir(), 'milo-export-'))
  chmodSync(stagingRoot, PRIVATE_DIR_MODE)

  try {
    const dataStage = path.join(stagingRoot, 'data')
    mkdirSync(dataStage, { recursive: true, mode: PRIVATE_DIR_MODE })

    let fileCount = 0
    let rawBytes = 0

    for (const entry of readdirSync(miloHome, { withFileTypes: true })) {
      const name = entry.name
      if (EPHEMERAL_TOP_LEVEL.has(name) || isTransientFile(name)) continue
      if (!includeSecrets && SECRET_TOP_LEVEL.has(name)) continue
      if (!includeCaches && CACHE_TOP_LEVEL.has(name)) continue
      if (!includeBrowser && name === 'browser') continue
      if (!includeEmbed && name === 'embed') continue

      const srcPath = path.join(miloHome, name)
      const destPath = path.join(dataStage, name)
      const stat = lstatSync(srcPath)
      let effectiveStat = stat
      if (stat.isSymbolicLink()) {
        try {
          effectiveStat = statSync(srcPath)
        } catch {
          // Broken symlink: skip rather than aborting backup.
          continue
        }
      }

      if (name === 'memory' && effectiveStat.isDirectory()) {
        const sub = copyTreeFiltered(srcPath, destPath, {
          skipNames: (item) => isSqliteSidecar('memory.db', item),
        })
        fileCount += sub.fileCount
        rawBytes += sub.rawBytes
        const dbPath = path.join(srcPath, 'memory.db')
        if (existsSync(dbPath)) {
          const destDb = path.join(destPath, 'memory.db')
          snapshotSqlite(dbPath, destDb)
          fileCount += 1
          rawBytes += statSync(destDb).size
        }
        continue
      }

      if (name === 'history' && effectiveStat.isDirectory()) {
        const sub = copyTreeFiltered(srcPath, destPath, {
          skipNames: (item) => isSqliteSidecar('turns.db', item),
        })
        fileCount += sub.fileCount
        rawBytes += sub.rawBytes
        const dbPath = path.join(srcPath, 'turns.db')
        if (existsSync(dbPath)) {
          const destDb = path.join(destPath, 'turns.db')
          snapshotSqlite(dbPath, destDb)
          fileCount += 1
          rawBytes += statSync(destDb).size
        }
        continue
      }

      if (name === 'browser' && effectiveStat.isDirectory()) {
        // Never bundle downloaded browser/chrome binary; copy only browser profiles.
        const sub = copyTreeFiltered(srcPath, destPath, { skipSubdir: 'chrome' })
        fileCount += sub.fileCount
        rawBytes += sub.rawBytes
        continue
      }

      if (effectiveStat.isDirectory()) {
        const sub = copyTreeFiltered(srcPath, destPath, {})
        fileCount += sub.fileCount
        rawBytes += sub.rawBytes
      } else if (effectiveStat.isFile()) {
        copyFileSync(srcPath, destPath)
        chmodSync(destPath, effectiveStat.mode & 0o777)
        fileCount += 1
        rawBytes += effectiveStat.size
      }
    }

    if (fileCount === 0) {
      return { ok: false, error: `Nothing to export in ${miloHome}.` }
    }

    const versionInfo = readInstallVersion()
    const manifest: InstallBackupManifest = {
      format: 1,
      appVersion: versionInfo.version,
      ...(versionInfo.commit ? { commit: versionInfo.commit } : {}),
      exportedAt: new Date().toISOString(),
      hostname: os.hostname(),
      miloHome,
      includes: {
        browser: includeBrowser,
        embed: includeEmbed,
        caches: includeCaches,
        secrets: includeSecrets,
      },
      fileCount,
      rawBytes,
    }

    writeFileSync(path.join(stagingRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: PRIVATE_FILE_MODE,
    })

    const tmpArchive = path.join(stagingRoot, 'archive.tar.gz')
    execFileSync('tar', ['-czf', tmpArchive, '-C', stagingRoot, 'manifest.json', 'data'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    chmodSync(tmpArchive, PRIVATE_FILE_MODE)

    mkdirSync(path.dirname(targetPath), { recursive: true })
    moveFile(tmpArchive, targetPath)
    chmodSync(targetPath, PRIVATE_FILE_MODE)

    const bytes = statSync(targetPath).size
    return {
      ok: true,
      result: {
        path: targetPath,
        bytes,
        manifest,
      },
    }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true })
  }
}

function isUnsafeArchiveEntry(entry: string): boolean {
  const normalized = entry.replace(/^\.\//, '')
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) return true
  const parts = normalized.split('/').filter(Boolean)
  if (parts.includes('..')) return true
  const root = parts[0]
  return root !== 'manifest.json' && root !== 'data'
}

/**
 * Verifies an installation backup archive without extracting it to `MILO_HOME`
 * and returns its parsed manifest and entry list.
 */
export function inspectInstallationArchive(archivePath: string): Outcome<InspectInstallResult> {
  const resolved = path.resolve(archivePath)
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    return { ok: false, error: `Backup archive not found: ${resolved}` }
  }

  try {
    const verboseList = execFileSync('tar', ['-tvzf', resolved], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    })
    for (const line of verboseList.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const typeChar = trimmed[0]
      if (typeChar !== '-' && typeChar !== 'd') {
        return { ok: false, error: `Refusing archive containing unsupported entry type "${typeChar}": ${trimmed}` }
      }
    }

    const rawEntries = execFileSync('tar', ['-tzf', resolved], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    })
    const entries = rawEntries
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)

    if (entries.length === 0) {
      return { ok: false, error: 'Archive is empty.' }
    }

    for (const entry of entries) {
      if (isUnsafeArchiveEntry(entry)) {
        return { ok: false, error: `Refusing unsafe archive entry: ${entry}` }
      }
    }

    const hasManifest = entries.some((entry) => entry.replace(/^\.\//, '') === 'manifest.json')
    const hasData = entries.some((entry) => {
      const clean = entry.replace(/^\.\//, '')
      return clean === 'data' || clean.startsWith('data/')
    })
    if (!hasManifest || !hasData) {
      return { ok: false, error: 'Not a valid Milo installation backup (missing manifest.json or data/).' }
    }

    const manifestRaw = execFileSync('tar', ['-xOzf', resolved, 'manifest.json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024,
    })
    const manifest = JSON.parse(manifestRaw) as InstallBackupManifest
    if (manifest?.format !== 1 || typeof manifest.exportedAt !== 'string') {
      return { ok: false, error: `Unsupported backup format: ${String((manifest as { format?: unknown })?.format)}` }
    }

    return { ok: true, result: { manifest, entries } }
  } catch (error) {
    return { ok: false, error: `Could not read backup archive: ${errorMessage(error)}` }
  }
}

function chmodPrivateTree(dirPath: string): void {
  chmodSync(dirPath, PRIVATE_DIR_MODE)
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      chmodPrivateTree(full)
    } else if (entry.isFile()) {
      chmodSync(full, PRIVATE_FILE_MODE)
    }
  }
}

function enforceImportedPermissions(miloHome: string): void {
  chmodSync(miloHome, PRIVATE_DIR_MODE)
  for (const name of PRIVATE_TOP_LEVEL_FILES) {
    const file = path.join(miloHome, name)
    if (existsSync(file) && statSync(file).isFile()) {
      chmodSync(file, PRIVATE_FILE_MODE)
    }
  }
  for (const dirName of ['sessions', 'exports']) {
    const dirPath = path.join(miloHome, dirName)
    if (existsSync(dirPath) && statSync(dirPath).isDirectory()) {
      chmodPrivateTree(dirPath)
    }
  }
  for (const dirName of ['memory', 'history']) {
    const dirPath = path.join(miloHome, dirName)
    if (existsSync(dirPath) && statSync(dirPath).isDirectory()) {
      chmodSync(dirPath, PRIVATE_DIR_MODE)
    }
  }
}

function uniqueBackupPath(miloHome: string): string {
  const base = `${miloHome}.bak-${timestampSlug()}`
  if (!existsSync(base)) return base
  for (let i = 1; ; i += 1) {
    const candidate = `${base}-${i}`
    if (!existsSync(candidate)) return candidate
  }
}

function findMissingProjects(miloHome: string): MissingProjectRef[] {
  const file = path.join(miloHome, 'projects.json')
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Array<{ id?: string; name?: string; path?: string }> | { projects?: Array<{ id?: string; name?: string; path?: string }> }
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.projects) ? parsed.projects : []
    const missing: MissingProjectRef[] = []
    for (const item of list) {
      if (typeof item?.path === 'string' && !existsSync(item.path)) {
        missing.push({
          id: String(item.id ?? ''),
          name: String(item.name ?? item.path),
          path: item.path,
        })
      }
    }
    return missing
  } catch {
    return []
  }
}

export function hasExistingInstallation(miloHome = MILO_HOME): boolean {
  const resolved = path.resolve(miloHome)
  if (!existsSync(resolved)) return false
  try {
    return readdirSync(resolved).length > 0
  } catch {
    return false
  }
}

/**
 * Restores an exported installation archive into `MILO_HOME`, safely backing up
 * any existing installation directory first unless `backup: false`.
 */
export function importInstallation(options: ImportInstallOptions): Outcome<ImportInstallResult> {
  const miloHome = path.resolve(options.miloHome ?? MILO_HOME)
  const inspected = inspectInstallationArchive(options.archivePath)
  if (!inspected.ok) return inspected

  if (options.dryRun) {
    return {
      ok: true,
      result: {
        dryRun: true,
        miloHome,
        manifest: inspected.result.manifest,
        missingProjects: [],
      },
    }
  }

  const stagingRoot = mkdtempSync(path.join(os.tmpdir(), 'milo-import-'))
  chmodSync(stagingRoot, PRIVATE_DIR_MODE)

  try {
    const archive = path.resolve(options.archivePath)
    execFileSync('tar', ['-xzf', archive, '-C', stagingRoot], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const stagedData = path.join(stagingRoot, 'data')
    if (!existsSync(stagedData) || !statSync(stagedData).isDirectory()) {
      return { ok: false, error: 'Archive did not unpack a data/ directory.' }
    }

    let backupPath: string | undefined
    if (existsSync(miloHome)) {
      if (hasExistingInstallation(miloHome) && options.backup !== false) {
        const candidate = uniqueBackupPath(miloHome)
        moveDirectory(miloHome, candidate)
        chmodSync(candidate, PRIVATE_DIR_MODE)
        backupPath = candidate
      } else {
        rmSync(miloHome, { recursive: true, force: true })
      }
    }

    mkdirSync(path.dirname(miloHome), { recursive: true })
    moveDirectory(stagedData, miloHome)
    enforceImportedPermissions(miloHome)
    const missingProjects = findMissingProjects(miloHome)

    return {
      ok: true,
      result: {
        dryRun: false,
        miloHome,
        ...(backupPath ? { backupPath } : {}),
        manifest: inspected.result.manifest,
        missingProjects,
      },
    }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true })
  }
}
