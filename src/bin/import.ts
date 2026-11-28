import process from 'node:process'
import { hasExistingInstallation, importInstallation, inspectInstallationArchive } from '../core/backup.js'
import { MILO_HOME } from '../core/config/paths.js'
import { errorMessage } from '../util/errors.js'
import { humanSize, plural, shortenPath } from '../util/format.js'
import { confirmOnTty } from '../util/terminal.js'

export interface ImportInstallIo {
  out(line: string): void
  err(line: string): void
  confirm(question: string): Promise<boolean>
}

export interface ImportInstallDeps {
  miloHome?: string
}

const USAGE = [
  'Usage:',
  '  milo import <archive.tar.gz>           Restore a Milo installation into ~/.milo',
  '  milo import <archive.tar.gz> --dry-run Inspect an archive without changing anything',
  '',
  'Options:',
  '  --dry-run   Inspect the backup manifest and exit',
  '  --yes, -y   Skip confirmation when replacing an existing ~/.milo',
  '  --no-backup Replace an existing ~/.milo without keeping a .bak-* copy',
].join('\n')

interface ParsedImportArgs {
  archivePath?: string
  dryRun: boolean
  yes: boolean
  backup: boolean
  help: boolean
  error?: string
}

function parseImportArgs(argv: string[]): ParsedImportArgs {
  const args = argv[0] === 'import' ? argv.slice(1) : argv
  const parsed: ParsedImportArgs = {
    dryRun: false,
    yes: false,
    backup: true,
    help: false,
  }

  for (const arg of args) {
    if (arg === '--help' || arg === '-h' || arg === 'help') {
      parsed.help = true
    } else if (arg === '--dry-run') {
      parsed.dryRun = true
    } else if (arg === '--yes' || arg === '-y') {
      parsed.yes = true
    } else if (arg === '--no-backup') {
      parsed.backup = false
    } else if (arg.startsWith('-')) {
      return {
        ...parsed,
        error: `Unknown option "${arg}". Valid options: --dry-run, --yes (-y), --no-backup, --help (-h).`,
      }
    } else if (!parsed.archivePath) {
      parsed.archivePath = arg
    } else {
      return {
        ...parsed,
        error: `Unexpected argument "${arg}". Give one archive path.`,
      }
    }
  }

  return parsed
}

/**
 * `milo import`: inspects and restores an exported installation archive into
 * `MILO_HOME`, keeping a `.bak-*` snapshot of any previous installation by default.
 */
export async function runImport(
  argv: string[] = [],
  io: Partial<ImportInstallIo> = {},
  deps: ImportInstallDeps = {},
): Promise<number> {
  const out = io.out ?? ((line: string) => console.log(line))
  const err = io.err ?? ((line: string) => console.error(line))
  const confirm = io.confirm ?? confirmOnTty

  const parsed = parseImportArgs(argv)
  if (parsed.help) {
    out(USAGE)
    return 0
  }
  if (parsed.error) {
    err(parsed.error)
    err(USAGE)
    return 1
  }
  if (!parsed.archivePath) {
    err('Give the path to a backup archive (for example `milo import milo-backup.tar.gz`).')
    err(USAGE)
    return 1
  }

  const miloHome = deps.miloHome ?? MILO_HOME
  const home = process.env.HOME ?? ''

  try {
    const inspected = inspectInstallationArchive(parsed.archivePath)
    if (!inspected.ok) {
      err(inspected.error)
      return 1
    }

    const { manifest } = inspected.result
    if (parsed.dryRun) {
      out(`Backup archive: ${shortenPath(parsed.archivePath, home)}`)
      out(`  Exported: ${manifest.exportedAt} (from ${manifest.hostname})`)
      out(`  Version:  ${manifest.appVersion}${manifest.commit ? ` (${manifest.commit})` : ''}`)
      out(`  Contents: ${plural(manifest.fileCount, 'file')} (${humanSize(manifest.rawBytes)} uncompressed)`)
      out(`  Target:   ${shortenPath(miloHome, home)}`)
      return 0
    }

    if (hasExistingInstallation(miloHome) && !parsed.yes) {
      const prompt = parsed.backup
        ? `Replace ${shortenPath(miloHome, home)} with this backup (previous data will be kept as .bak)? [y/N] `
        : `Permanently replace ${shortenPath(miloHome, home)} with this backup? [y/N] `
      if (!(await confirm(prompt))) {
        out('Import cancelled. Re-run with --yes to confirm non-interactively.')
        return 1
      }
    }

    const outcome = importInstallation({
      archivePath: parsed.archivePath,
      miloHome,
      backup: parsed.backup,
    })
    if (!outcome.ok) {
      err(outcome.error)
      return 1
    }

    const res = outcome.result
    out(`Imported ${plural(res.manifest.fileCount, 'file')} into ${shortenPath(res.miloHome, home)}`)
    if (res.backupPath) {
      out(`  Previous install saved at: ${shortenPath(res.backupPath, home)}`)
    }
    if (res.missingProjects.length > 0) {
      out(`Note: ${plural(res.missingProjects.length, 'project folder')} in projects.json do not exist on this machine:`)
      for (const project of res.missingProjects) {
        out(`  - ${project.name}: ${project.path}`)
      }
      out('  Update paths with `milo projects move <id|name> <folder>`.')
    }
    out('If `milo serve` is running, restart it so it picks up the restored state.')
    return 0
  } catch (error) {
    err(errorMessage(error))
    return 1
  }
}
