import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  exportInstallation,
  importInstallation,
  inspectInstallationArchive,
} from '../src/core/backup.js'
import { loadSqlite } from '../src/core/memory/sql.js'
import { formatInstallVersion, readInstallVersion } from '../src/core/version.js'
import { runExport } from '../src/bin/export.js'
import { runImport } from '../src/bin/import.js'
import { runUpdate, type CommandOutcome } from '../src/bin/update.js'

const dirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('install version reading', () => {
  it('reads package version and git commit details for a git checkout', () => {
    const repo = makeTempDir('milo-ver-git-')
    writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'milo', version: '0.1.0' }))
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['add', 'package.json'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo, stdio: 'ignore' })

    const clean = readInstallVersion(repo)
    expect(clean.isGitRepo).toBe(true)
    expect(clean.version).toBe('0.1.0')
    expect(clean.branch).toBe('main')
    expect(clean.commit).toMatch(/^[0-9a-f]{7,}$/)
    expect(clean.dirty).toBe(false)
    expect(formatInstallVersion(clean)).toContain('0.1.0 (')
    expect(formatInstallVersion(clean)).toContain('main')

    writeFileSync(path.join(repo, 'extra.txt'), 'dirty')
    const dirty = readInstallVersion(repo)
    expect(dirty.dirty).toBe(true)
    expect(formatInstallVersion(dirty)).toContain('modified')
  })

  it('falls back to package version when .git is absent', () => {
    const dir = makeTempDir('milo-ver-nogit-')
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'milo', version: '0.1.0' }))

    const info = readInstallVersion(dir)
    expect(info.isGitRepo).toBe(false)
    expect(info.commit).toBeUndefined()
    expect(formatInstallVersion(info)).toBe('0.1.0')
  })
})

describe('milo update', () => {
  it('refuses a non-git install root', async () => {
    const root = makeTempDir('milo-update-nogit-')
    const out: string[] = []
    const err: string[] = []
    const code = await runUpdate([], { out: (l) => out.push(l), err: (l) => err.push(l) }, { installRoot: root })
    expect(code).toBe(1)
    expect(err.join('\n')).toContain('not a git checkout')
  })

  it('refuses unknown options cleanly', async () => {
    const out: string[] = []
    const err: string[] = []
    const code = await runUpdate(['update', '--banana'], { out: (l) => out.push(l), err: (l) => err.push(l) })
    expect(code).toBe(1)
    expect(err.join('\n')).toContain('Unknown option "--banana"')
  })

  it('checks for incoming commits without modifying the repo', async () => {
    const root = makeTempDir('milo-update-check-')
    mkdirSync(path.join(root, '.git'))
    const calls: string[] = []
    const out: string[] = []
    const err: string[] = []

    const code = await runUpdate(
      ['update', '--check'],
      { out: (l) => out.push(l), err: (l) => err.push(l) },
      {
        installRoot: root,
        run: async (cmd, args): Promise<CommandOutcome> => {
          calls.push(`${cmd} ${args.join(' ')}`)
          if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return { code: 0, stdout: 'true\n', stderr: '' }
          if (args[0] === 'status') return { code: 0, stdout: '', stderr: '' }
          if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return { code: 0, stdout: 'main\n', stderr: '' }
          if (args[0] === 'rev-parse' && args[1] === '--short') return { code: 0, stdout: 'abc1234\n', stderr: '' }
          if (args[0] === 'fetch') return { code: 0, stdout: '', stderr: '' }
          if (args[0] === 'rev-list') return { code: 0, stdout: '2\n', stderr: '' }
          if (args[0] === 'log') return { code: 0, stdout: 'def5678 second\n999aaaa first\n', stderr: '' }
          return { code: 0, stdout: '', stderr: '' }
        },
      },
    )

    expect(code).toBe(0)
    expect(err).toEqual([])
    expect(out.join('\n')).toContain('2 new commit(s)')
    expect(out.join('\n')).toContain('def5678 second')
    expect(calls.some((call) => call.includes('pull'))).toBe(false)
    expect(calls.some((call) => call.includes('npm'))).toBe(false)
  })

  it('pulls new commits and rebuilds root and web with NODE_ENV=development', async () => {
    const root = makeTempDir('milo-update-pull-')
    mkdirSync(path.join(root, '.git'))
    mkdirSync(path.join(root, 'web'))
    writeFileSync(path.join(root, 'package-lock.json'), '{}')
    writeFileSync(path.join(root, 'web', 'package-lock.json'), '{}')

    const calls: Array<{ cmd: string; args: string[]; cwd: string; nodeEnv?: string }> = []
    const out: string[] = []
    const err: string[] = []
    let headCount = 0

    const code = await runUpdate(
      ['update'],
      { out: (l) => out.push(l), err: (l) => err.push(l) },
      {
        installRoot: root,
        run: async (cmd, args, opts): Promise<CommandOutcome> => {
          calls.push({ cmd, args, cwd: opts.cwd, nodeEnv: opts.env.NODE_ENV })
          if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return { code: 0, stdout: 'true\n', stderr: '' }
          if (args[0] === 'status') return { code: 0, stdout: '', stderr: '' }
          if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return { code: 0, stdout: 'main\n', stderr: '' }
          if (args[0] === 'rev-parse' && args[1] === '--short') {
            headCount += 1
            return { code: 0, stdout: headCount === 1 ? 'abc1234\n' : 'def5678\n', stderr: '' }
          }
          if (args[0] === 'rev-list') return { code: 0, stdout: '1\n', stderr: '' }
          if (args[0] === 'log') return { code: 0, stdout: 'def5678 fix bug\n', stderr: '' }
          return { code: 0, stdout: '', stderr: '' }
        },
      },
    )

    expect(code).toBe(0)
    expect(err).toEqual([])
    expect(out.join('\n')).toContain('Updated abc1234 -> def5678 on main (1 commit(s))')
    const npmCalls = calls.filter((c) => c.cmd.startsWith('npm'))
    expect(npmCalls.map((c) => [path.relative(root, c.cwd) || '.', ...c.args])).toEqual([
      ['.', 'ci', '--include=dev'],
      ['.', 'run', 'build'],
      ['web', 'ci', '--include=dev'],
      ['web', 'run', 'build'],
    ])
    expect(npmCalls.every((c) => c.nodeEnv === 'development')).toBe(true)
  })

  it('rejects --branch and --to together', async () => {
    const out: string[] = []
    const err: string[] = []
    const code = await runUpdate(
      ['update', '--branch', 'main', '--to', 'abc1234'],
      { out: (l) => out.push(l), err: (l) => err.push(l) },
    )
    expect(code).toBe(1)
    expect(err.join('\n')).toContain('Use either --branch or --to, not both.')
  })

  it('checks out a specific commit or tag with --to', async () => {
    const root = makeTempDir('milo-update-to-')
    mkdirSync(path.join(root, '.git'))
    mkdirSync(path.join(root, 'web'))
    const calls: string[] = []
    const out: string[] = []
    const err: string[] = []
    let shortCalls = 0

    const code = await runUpdate(
      ['update', '--to', 'v0.1.0'],
      { out: (l) => out.push(l), err: (l) => err.push(l) },
      {
        installRoot: root,
        run: async (cmd, args): Promise<CommandOutcome> => {
          calls.push(`${cmd} ${args.join(' ')}`)
          if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return { code: 0, stdout: 'true\n', stderr: '' }
          if (args[0] === 'status') return { code: 0, stdout: '', stderr: '' }
          if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return { code: 0, stdout: 'main\n', stderr: '' }
          if (args[0] === 'rev-parse' && args[1] === '--short') {
            shortCalls += 1
            if (shortCalls === 1) return { code: 0, stdout: 'abc1234\n', stderr: '' }
            return { code: 0, stdout: '111aaaa\n', stderr: '' }
          }
          if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { code: 0, stdout: 'abc12340000\n', stderr: '' }
          if (args[0] === 'rev-parse' && args[1] === '--verify') return { code: 0, stdout: '111aaaa0000\n', stderr: '' }
          return { code: 0, stdout: '', stderr: '' }
        },
      },
    )

    expect(code).toBe(0)
    expect(err).toEqual([])
    expect(calls).toContain('git checkout --detach 111aaaa0000')
    expect(out.join('\n')).toContain('Switched abc1234 -> 111aaaa (v0.1.0)')
  })

  it('prints Switched instead of (0 commit(s)) when switching branches without ahead commits', async () => {
    const root = makeTempDir('milo-update-switch-')
    mkdirSync(path.join(root, '.git'))
    mkdirSync(path.join(root, 'web'))
    const out: string[] = []
    const err: string[] = []
    let shortCalls = 0

    const code = await runUpdate(
      ['update', '--branch', 'main'],
      { out: (l) => out.push(l), err: (l) => err.push(l) },
      {
        installRoot: root,
        run: async (_cmd, args): Promise<CommandOutcome> => {
          if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return { code: 0, stdout: 'true\n', stderr: '' }
          if (args[0] === 'status') return { code: 0, stdout: '', stderr: '' }
          if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return { code: 0, stdout: 'feat-x\n', stderr: '' }
          if (args[0] === 'rev-parse' && args[1] === '--short') {
            shortCalls += 1
            return { code: 0, stdout: shortCalls === 1 ? 'fff9999\n' : 'aaa1111\n', stderr: '' }
          }
          if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { code: 0, stdout: 'fff99990000\n', stderr: '' }
          if (args[0] === 'rev-list') return { code: 0, stdout: '0\n', stderr: '' }
          return { code: 0, stdout: '', stderr: '' }
        },
      },
    )

    expect(code).toBe(0)
    expect(err).toEqual([])
    expect(out.join('\n')).toContain('Switched fff9999 -> aaa1111 on main.')
    expect(out.join('\n')).not.toContain('0 commit(s)')
  })

  it('restores dist/, git HEAD, and dependencies when build fails', async () => {
    const root = makeTempDir('milo-update-rollback-')
    mkdirSync(path.join(root, '.git'))
    mkdirSync(path.join(root, 'dist', 'bin'), { recursive: true })
    mkdirSync(path.join(root, 'web', 'dist'), { recursive: true })
    writeFileSync(path.join(root, 'package-lock.json'), '{}')
    writeFileSync(path.join(root, 'dist', 'bin', 'cli.js'), 'previous-cli-build')
    writeFileSync(path.join(root, 'web', 'dist', 'index.html'), 'previous-web-build')

    const calls: string[] = []
    const out: string[] = []
    const err: string[] = []

    const code = await runUpdate(
      ['update'],
      { out: (l) => out.push(l), err: (l) => err.push(l) },
      {
        installRoot: root,
        run: async (cmd, args): Promise<CommandOutcome> => {
          calls.push(`${cmd} ${args.join(' ')}`)
          if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return { code: 0, stdout: 'true\n', stderr: '' }
          if (args[0] === 'status') return { code: 0, stdout: '', stderr: '' }
          if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return { code: 0, stdout: 'main\n', stderr: '' }
          if (args[0] === 'rev-parse' && args[1] === '--short') return { code: 0, stdout: 'abc1234\n', stderr: '' }
          if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { code: 0, stdout: 'abc12340000\n', stderr: '' }
          if (args[0] === 'rev-list') return { code: 0, stdout: '1\n', stderr: '' }
          if (args[0] === 'log') return { code: 0, stdout: 'def5678 broken\n', stderr: '' }
          if (cmd.startsWith('npm') && args[0] === 'run' && args[1] === 'build') {
            rmSync(path.join(root, 'dist'), { recursive: true, force: true })
            return { code: 1, stdout: '', stderr: 'tsup out of memory' }
          }
          return { code: 0, stdout: '', stderr: '' }
        },
      },
    )

    expect(code).toBe(1)
    expect(err.join('\n')).toContain('restored git state (abc1234) and previous build')
    expect(calls).toContain('git reset --hard abc12340000')
    expect(calls).toContain('npm ci --prefer-offline --include=dev')
    expect(readFileSync(path.join(root, 'dist', 'bin', 'cli.js'), 'utf8')).toBe('previous-cli-build')
    expect(readFileSync(path.join(root, 'web', 'dist', 'index.html'), 'utf8')).toBe('previous-web-build')
  })
})

describe('installation export and import', () => {
  function seedMiloHome(home: string): void {
    mkdirSync(path.join(home, 'sessions'), { recursive: true })
    mkdirSync(path.join(home, 'skills', 'demo'), { recursive: true })
    mkdirSync(path.join(home, 'memory'), { recursive: true })
    mkdirSync(path.join(home, 'history'), { recursive: true })
    mkdirSync(path.join(home, 'browser', 'profile'), { recursive: true })
    mkdirSync(path.join(home, 'browser', 'chrome'), { recursive: true })
    mkdirSync(path.join(home, 'embed'), { recursive: true })

    writeFileSync(path.join(home, 'config.yml'), 'provider: openrouter\n', { mode: 0o600 })
    writeFileSync(path.join(home, 'auth.json'), '{"openrouter":"sk-secret"}\n', { mode: 0o600 })
    writeFileSync(path.join(home, 'devices.json'), '{"devices":[]}\n', { mode: 0o600 })
    writeFileSync(path.join(home, 'pairing.json'), '{"code":"123456"}\n', { mode: 0o600 })
    writeFileSync(path.join(home, 'models.json'), '{"cached":true}\n')
    writeFileSync(path.join(home, 'mcp-cache.json'), '{"cached":true}\n')
    writeFileSync(path.join(home, 'sessions', 'calm-otter-7.json'), '{"id":"calm-otter-7"}\n')
    writeFileSync(path.join(home, 'sessions', 'calm-otter-7.lock'), '123\n')
    writeFileSync(path.join(home, 'skills', 'demo', 'SKILL.md'), '# Demo skill\n')
    writeFileSync(path.join(home, 'browser', 'profile', 'Cookies'), 'cookie-data\n')
    writeFileSync(path.join(home, 'browser', 'chrome', 'chrome-bin'), 'huge-binary\n')
    writeFileSync(path.join(home, 'embed', 'ollama-bin'), 'huge-model\n')

    const { DatabaseSync } = loadSqlite()
    const memDb = new DatabaseSync(path.join(home, 'memory', 'memory.db'))
    memDb.exec('pragma journal_mode = WAL; create table memories(id integer primary key, fact text); insert into memories(fact) values (\'likes coffee\');')
    memDb.close()

    const histDb = new DatabaseSync(path.join(home, 'history', 'turns.db'))
    histDb.exec('pragma journal_mode = WAL; create table turns(id integer primary key, text text); insert into turns(text) values (\'hello world\');')
    histDb.close()
  }

  it('exports portable state with SQLite snapshots and restores into a fresh home', () => {
    const srcHome = makeTempDir('milo-exp-src-')
    const outDir = makeTempDir('milo-exp-out-')
    const destHome = path.join(makeTempDir('milo-imp-parent-'), '.milo')
    seedMiloHome(srcHome)

    const archivePath = path.join(outDir, 'backup.tar.gz')
    const exported = exportInstallation({ miloHome: srcHome, outPath: archivePath })
    expect(exported.ok).toBe(true)
    if (!exported.ok) return

    expect(statSync(archivePath).mode & 0o777).toBe(0o600)

    const inspected = inspectInstallationArchive(archivePath)
    expect(inspected.ok).toBe(true)
    if (!inspected.ok) return
    expect(inspected.result.manifest.format).toBe(1)
    expect(inspected.result.entries).toContain('data/config.yml')
    expect(inspected.result.entries).toContain('data/auth.json')
    expect(inspected.result.entries).toContain('data/memory/memory.db')
    expect(inspected.result.entries).toContain('data/history/turns.db')
    expect(inspected.result.entries).not.toContain('data/pairing.json')
    expect(inspected.result.entries).not.toContain('data/models.json')
    expect(inspected.result.entries).not.toContain('data/mcp-cache.json')
    expect(inspected.result.entries).not.toContain('data/sessions/calm-otter-7.lock')
    expect(inspected.result.entries.some((e) => e.startsWith('data/browser'))).toBe(false)
    expect(inspected.result.entries.some((e) => e.startsWith('data/embed'))).toBe(false)

    const imported = importInstallation({ archivePath, miloHome: destHome })
    expect(imported.ok).toBe(true)
    if (!imported.ok) return

    expect(statSync(destHome).mode & 0o777).toBe(0o700)
    expect(statSync(path.join(destHome, 'auth.json')).mode & 0o777).toBe(0o600)
    expect(readFileSync(path.join(destHome, 'config.yml'), 'utf8')).toBe('provider: openrouter\n')
    expect(readFileSync(path.join(destHome, 'skills', 'demo', 'SKILL.md'), 'utf8')).toBe('# Demo skill\n')

    const { DatabaseSync } = loadSqlite()
    const restoredMem = new DatabaseSync(path.join(destHome, 'memory', 'memory.db'))
    expect(restoredMem.prepare('select fact from memories').all()).toEqual([{ fact: 'likes coffee' }])
    restoredMem.close()

    const restoredTurns = new DatabaseSync(path.join(destHome, 'history', 'turns.db'))
    expect(restoredTurns.prepare('select text from turns').all()).toEqual([{ text: 'hello world' }])
    restoredTurns.close()
  })

  it('supports --no-secrets and --include-browser without bundling chrome binary', () => {
    const srcHome = makeTempDir('milo-exp-flags-')
    const outDir = makeTempDir('milo-exp-flags-out-')
    seedMiloHome(srcHome)

    const archivePath = path.join(outDir, 'no-secrets.tar.gz')
    const exported = exportInstallation({
      miloHome: srcHome,
      outPath: archivePath,
      includeBrowser: true,
      includeSecrets: false,
    })
    expect(exported.ok).toBe(true)
    if (!exported.ok) return

    const inspected = inspectInstallationArchive(archivePath)
    expect(inspected.ok).toBe(true)
    if (!inspected.ok) return

    expect(inspected.result.entries).not.toContain('data/auth.json')
    expect(inspected.result.entries).not.toContain('data/devices.json')
    expect(inspected.result.entries).toContain('data/browser/profile/Cookies')
    expect(inspected.result.entries.some((e) => e.includes('chrome'))).toBe(false)
  })

  it('rejects archives with symlinks or unsafe paths before unpacking', () => {
    const work = makeTempDir('milo-bad-tar-')
    mkdirSync(path.join(work, 'data'))
    writeFileSync(path.join(work, 'manifest.json'), JSON.stringify({ format: 1, exportedAt: new Date().toISOString() }))
    symlinkSync('/etc/passwd', path.join(work, 'data', 'link'))

    const archive = path.join(work, 'evil.tar.gz')
    execFileSync('tar', ['-czf', archive, '-C', work, 'manifest.json', 'data'])

    const inspected = inspectInstallationArchive(archive)
    expect(inspected.ok).toBe(false)
    if (!inspected.ok) {
      expect(inspected.error).toContain('unsupported entry type')
    }
  })

  it('backs up an existing install on import and warns on missing project paths', async () => {
    const srcHome = makeTempDir('milo-cli-src-')
    const destHome = makeTempDir('milo-cli-dest-')
    const outDir = makeTempDir('milo-cli-out-')
    seedMiloHome(srcHome)
    writeFileSync(
      path.join(srcHome, 'projects.json'),
      JSON.stringify([{ id: 'p1', name: 'Missing', path: '/nonexistent/path/for/test' }]),
    )
    writeFileSync(path.join(destHome, 'config.yml'), 'provider: old\n')

    const archive = path.join(outDir, 'cli.tar.gz')
    const exportOut: string[] = []
    const exportErr: string[] = []
    expect(await runExport(['export', archive], { out: (l) => exportOut.push(l), err: (l) => exportErr.push(l) }, { miloHome: srcHome })).toBe(0)
    expect(exportErr).toEqual([])

    const dryOut: string[] = []
    expect(await runImport(['import', archive, '--dry-run'], { out: (l) => dryOut.push(l), err: () => {} }, { miloHome: destHome })).toBe(0)
    expect(dryOut.join('\n')).toContain('Backup archive:')
    expect(readFileSync(path.join(destHome, 'config.yml'), 'utf8')).toBe('provider: old\n')

    const declined = await runImport(
      ['import', archive],
      { out: () => {}, err: () => {}, confirm: async () => false },
      { miloHome: destHome },
    )
    expect(declined).toBe(1)
    expect(readFileSync(path.join(destHome, 'config.yml'), 'utf8')).toBe('provider: old\n')

    const impOut: string[] = []
    const impErr: string[] = []
    expect(
      await runImport(
        ['import', archive, '--yes'],
        { out: (l) => impOut.push(l), err: (l) => impErr.push(l) },
        { miloHome: destHome },
      ),
    ).toBe(0)
    expect(impErr).toEqual([])
    expect(readFileSync(path.join(destHome, 'config.yml'), 'utf8')).toBe('provider: openrouter\n')
    expect(impOut.join('\n')).toContain('Previous install saved at:')
    expect(impOut.join('\n')).toContain('do not exist on this machine')
    expect(existsSync(destHome)).toBe(true)
  })

  it('includes top-level and nested symlinks with target permissions and skips broken symlinks', () => {
    const srcHome = makeTempDir('milo-sym-src-')
    const externalDir = makeTempDir('milo-sym-ext-')
    const outDir = makeTempDir('milo-sym-out-')
    const destHome = path.join(makeTempDir('milo-sym-dest-'), '.milo')

    writeFileSync(path.join(externalDir, 'AGENTS.md'), '# Global rules\n', { mode: 0o600 })
    mkdirSync(path.join(externalDir, 'linked-skill'), { recursive: true })
    writeFileSync(path.join(externalDir, 'linked-skill', 'SKILL.md'), '# Linked\n', { mode: 0o640 })

    mkdirSync(path.join(srcHome, 'skills'), { recursive: true })
    symlinkSync(path.join(externalDir, 'AGENTS.md'), path.join(srcHome, 'AGENTS.md'))
    symlinkSync(path.join(externalDir, 'linked-skill'), path.join(srcHome, 'skills', 'linked-skill'))
    symlinkSync(path.join(externalDir, 'does-not-exist'), path.join(srcHome, 'broken-link'))

    const archivePath = path.join(outDir, 'symlinks.tar.gz')
    const exported = exportInstallation({ miloHome: srcHome, outPath: archivePath })
    expect(exported.ok).toBe(true)

    const imported = importInstallation({ archivePath, miloHome: destHome })
    expect(imported.ok).toBe(true)
    expect(readFileSync(path.join(destHome, 'AGENTS.md'), 'utf8')).toBe('# Global rules\n')
    expect(statSync(path.join(destHome, 'AGENTS.md')).mode & 0o777).toBe(0o600)
    expect(readFileSync(path.join(destHome, 'skills', 'linked-skill', 'SKILL.md'), 'utf8')).toBe('# Linked\n')
    expect(statSync(path.join(destHome, 'skills', 'linked-skill', 'SKILL.md')).mode & 0o777).toBe(0o640)
    expect(existsSync(path.join(destHome, 'broken-link'))).toBe(false)
  })

  it('enforces 0600 inside restored sessions/exports and avoids backup path collisions', () => {
    const srcHome = makeTempDir('milo-perm-src-')
    const destParent = makeTempDir('milo-perm-dest-')
    const destHome = path.join(destParent, '.milo')
    const outDir = makeTempDir('milo-perm-out-')

    mkdirSync(path.join(srcHome, 'sessions', 'recaps'), { recursive: true })
    mkdirSync(path.join(srcHome, 'exports'), { recursive: true })
    writeFileSync(path.join(srcHome, 'sessions', 's1.json'), '{"id":"s1"}', { mode: 0o644 })
    writeFileSync(path.join(srcHome, 'sessions', 'recaps', 's1.json'), '{"summary":"ok"}', { mode: 0o644 })
    writeFileSync(path.join(srcHome, 'exports', 's1.md'), '# export', { mode: 0o644 })

    const archivePath = path.join(outDir, 'perms.tar.gz')
    expect(exportInstallation({ miloHome: srcHome, outPath: archivePath }).ok).toBe(true)

    mkdirSync(destHome, { recursive: true })
    writeFileSync(path.join(destHome, 'config.yml'), 'v: 1\n')
    const first = importInstallation({ archivePath, miloHome: destHome })
    expect(first.ok).toBe(true)

    const second = importInstallation({ archivePath, miloHome: destHome })
    expect(second.ok).toBe(true)
    if (first.ok && second.ok) {
      expect(first.result.backupPath).toBeTruthy()
      expect(second.result.backupPath).toBeTruthy()
      expect(second.result.backupPath).not.toBe(first.result.backupPath)
    }

    expect(statSync(path.join(destHome, 'sessions', 's1.json')).mode & 0o777).toBe(0o600)
    expect(statSync(path.join(destHome, 'sessions', 'recaps', 's1.json')).mode & 0o777).toBe(0o600)
    expect(statSync(path.join(destHome, 'exports', 's1.md')).mode & 0o777).toBe(0o600)
  })
})
