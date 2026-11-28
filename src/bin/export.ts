import process from 'node:process'
import { exportInstallation } from '../core/backup.js'
import { MILO_HOME } from '../core/config/paths.js'
import { errorMessage } from '../util/errors.js'
import { humanSize, plural, shortenPath } from '../util/format.js'

export interface ExportInstallIo {
  out(line: string): void
  err(line: string): void
}

export interface ExportInstallDeps {
  miloHome?: string
}

const USAGE = [
  'Usage:',
  '  milo export [path]          Export this Milo installation (~/.milo) to a .tar.gz archive',
  '',
  'Options:',
  '  --include-browser           Include browser profiles (skips downloaded Chrome binary)',
  '  --include-embed             Include the local embedding engine and models',
  '  --include-caches            Include derived caches (models.json, mcp-cache.json)',
  '  --all                       Include browser profiles, embed engine, and caches',
  '  --no-secrets                Exclude auth.json and devices.json',
].join('\n')

interface ParsedExportArgs {
  outPath?: string
  includeBrowser: boolean
  includeEmbed: boolean
  includeCaches: boolean
  includeSecrets: boolean
  help: boolean
  error?: string
}

function parseExportArgs(argv: string[]): ParsedExportArgs {
  const args = argv[0] === 'export' ? argv.slice(1) : argv
  const parsed: ParsedExportArgs = {
    includeBrowser: false,
    includeEmbed: false,
    includeCaches: false,
    includeSecrets: true,
    help: false,
  }

  for (const arg of args) {
    if (arg === '--help' || arg === '-h' || arg === 'help') {
      parsed.help = true
    } else if (arg === '--include-browser') {
      parsed.includeBrowser = true
    } else if (arg === '--include-embed') {
      parsed.includeEmbed = true
    } else if (arg === '--include-caches') {
      parsed.includeCaches = true
    } else if (arg === '--all') {
      parsed.includeBrowser = true
      parsed.includeEmbed = true
      parsed.includeCaches = true
    } else if (arg === '--no-secrets') {
      parsed.includeSecrets = false
    } else if (arg.startsWith('-')) {
      return {
        ...parsed,
        error: `Unknown option "${arg}". Valid options: --include-browser, --include-embed, --include-caches, --all, --no-secrets, --help (-h).`,
      }
    } else if (!parsed.outPath) {
      parsed.outPath = arg
    } else {
      return {
        ...parsed,
        error: `Unexpected argument "${arg}". Give at most one output path.`,
      }
    }
  }

  return parsed
}

/**
 * `milo export`: writes a portable `.tar.gz` archive of `MILO_HOME`
 * (config, credentials, sessions, memory, history, skills, routines, crew, projects).
 */
export async function runExport(
  argv: string[] = [],
  io: Partial<ExportInstallIo> = {},
  deps: ExportInstallDeps = {},
): Promise<number> {
  const out = io.out ?? ((line: string) => console.log(line))
  const err = io.err ?? ((line: string) => console.error(line))

  const parsed = parseExportArgs(argv)
  if (parsed.help) {
    out(USAGE)
    return 0
  }
  if (parsed.error) {
    err(parsed.error)
    err(USAGE)
    return 1
  }

  try {
    const outcome = exportInstallation({
      miloHome: deps.miloHome ?? MILO_HOME,
      outPath: parsed.outPath,
      includeBrowser: parsed.includeBrowser,
      includeEmbed: parsed.includeEmbed,
      includeCaches: parsed.includeCaches,
      includeSecrets: parsed.includeSecrets,
    })
    if (!outcome.ok) {
      err(outcome.error)
      return 1
    }

    const { path: archivePath, bytes, manifest } = outcome.result
    const home = process.env.HOME ?? ''
    out(`Exported ${plural(manifest.fileCount, 'file')} (${humanSize(bytes)} compressed)`)
    out(`  Archive: ${shortenPath(archivePath, home)}`)
    out(`  Version: ${manifest.appVersion}${manifest.commit ? ` (${manifest.commit})` : ''}`)
    if (manifest.includes.secrets) {
      out('Note: archive contains API keys and tokens (mode 0600). Transfer it privately.')
    } else {
      out('Note: secrets excluded (--no-secrets). Re-run `milo setup` or restore auth.json on the target.')
    }
    return 0
  } catch (error) {
    err(errorMessage(error))
    return 1
  }
}
