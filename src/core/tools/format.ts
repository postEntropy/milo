import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { Tool, ToolResult } from './types.js'
import { clipMiddle } from './output.js'
import { resolveWritePath } from './walk.js'

/**
 * Formatting is a tool the model calls, not something that happens behind its
 * back: reformatting a file nobody asked about is a change in the diff, and a
 * change in the diff is the person's to approve. The tool detects what the
 * project already uses and runs that — it never invents a formatter the folder
 * does not have.
 */

const schema = z.object({
  path: z
    .string()
    .optional()
    .describe('A file or folder to format, relative to the working directory. Absent, the changed files are formatted.'),
  check: z
    .boolean()
    .optional()
    .describe('Report what would change instead of writing it.'),
})

export type FormatArgs = z.infer<typeof schema>

export interface Formatter {
  name: 'biome' | 'prettier' | 'ruff' | 'cargo' | 'gofmt'
  command: string
  /** Extensions it owns; a changed file in another language is left alone. */
  extensions: string[]
  /** Whether the command formats the whole project and takes no file list. */
  wholeProject?: boolean
}

function exists(folder: string, name: string): boolean {
  return existsSync(path.join(folder, name))
}

/**
 * What this folder already formats with. The first configured one wins, so a
 * repository that carries both a Biome and a Prettier config is formatted by the
 * one it named first rather than by both in turn.
 */
export function detectFormatter(cwd: string): Formatter | null {
  const biome = exists(cwd, 'node_modules/.bin/biome') ? path.join(cwd, 'node_modules/.bin/biome') : 'biome'
  if (exists(cwd, 'biome.json') || exists(cwd, 'biome.jsonc')) {
    return {
      name: 'biome',
      command: biome,
      extensions: ['.js', '.jsx', '.ts', '.tsx', '.json', '.jsonc', '.css', '.md', '.yaml', '.yml', '.html'],
    }
  }

  const prettier = exists(cwd, 'node_modules/.bin/prettier') ? path.join(cwd, 'node_modules/.bin/prettier') : 'prettier'
  const prettierConfigured =
    exists(cwd, '.prettierrc') ||
    exists(cwd, '.prettierrc.json') ||
    exists(cwd, '.prettierrc.yml') ||
    exists(cwd, '.prettierrc.yaml') ||
    exists(cwd, '.prettierrc.js') ||
    exists(cwd, 'prettier.config.js') ||
    exists(cwd, 'prettier.config.mjs') ||
    exists(cwd, 'prettier.config.cjs')
  if (prettierConfigured) {
    return {
      name: 'prettier',
      command: prettier,
      extensions: ['.js', '.jsx', '.ts', '.tsx', '.json', '.css', '.md', '.yaml', '.yml', '.html'],
    }
  }

  if (exists(cwd, 'ruff.toml') || exists(cwd, '.ruff.toml') || exists(cwd, 'pyproject.toml')) {
    return { name: 'ruff', command: 'ruff', extensions: ['.py'] }
  }

  if (exists(cwd, 'Cargo.toml')) {
    return { name: 'cargo', command: 'cargo', extensions: ['.rs'], wholeProject: true }
  }

  if (exists(cwd, 'go.mod')) {
    return { name: 'gofmt', command: 'gofmt', extensions: ['.go'] }
  }

  return null
}

/** The command and arguments for one run, so what it does can be read and tested. */
export function formatCommand(
  formatter: Formatter,
  files: string[],
  check: boolean,
): { command: string; args: string[] } {
  switch (formatter.name) {
    case 'biome':
      return { command: formatter.command, args: ['format', ...(check ? [] : ['--write']), ...files] }
    case 'prettier':
      return { command: formatter.command, args: [...(check ? ['--check'] : ['--write']), ...files] }
    case 'ruff':
      return { command: formatter.command, args: ['format', ...(check ? ['--check'] : []), ...files] }
    case 'cargo':
      return { command: formatter.command, args: ['fmt', ...(check ? ['--check'] : [])] }
    case 'gofmt':
      return { command: formatter.command, args: [...(check ? ['-l'] : ['-w']), ...files] }
  }
}

/** The files a working tree has changed, relative to `cwd`. Deleted files are not formatted. */
async function changedFiles(cwd: string, signal: AbortSignal): Promise<string[]> {
  const output = await new Promise<string>((resolve, reject) => {
    execFile('git', ['status', '--porcelain'], { cwd, signal, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })

  const files: string[] = []
  for (const line of output.split('\n')) {
    if (line.trim() === '') continue
    const status = line.slice(0, 2)
    if (status.includes('D')) continue
    const name = line.slice(3).split(' -> ').pop()?.trim()
    if (name) files.push(name)
  }
  return files
}

function owned(formatter: Formatter, file: string): boolean {
  return formatter.extensions.includes(path.extname(file).toLowerCase())
}

const MAX_OUTPUT = 8_000
const TIMEOUT_MS = 120_000

export const formatTool: Tool<FormatArgs> = {
  name: 'format',
  description:
    'Run the formatter this project already uses (Biome, Prettier, Ruff, Cargo or gofmt) over the files you changed, or over one path. Use `check` to see what it would change without writing. It never picks a formatter the folder does not have.',
  schema,
  readOnly: false,
  async execute(args, ctx): Promise<ToolResult> {
    const formatter = detectFormatter(ctx.cwd)
    if (!formatter) {
      return {
        content: 'No formatter is configured here: none of biome, prettier, ruff, cargo or gofmt found in the project folder.',
        isError: true,
      }
    }

    let files: string[]
    if (args.path) {
      const resolved = resolveWritePath(ctx.cwd, args.path, ctx.confineTo)
      if (!resolved.ok) return { content: resolved.error, isError: true }
      const info = statSync(resolved.path, { throwIfNoEntry: false })
      if (!info) return { content: `${args.path} does not exist.`, isError: true }
      if (info.isDirectory()) {
        if (formatter.wholeProject) {
          files = []
        } else {
          // The formatter takes a folder as its subject; the extension filter
          // below only applies to a list this tool gathered itself.
          files = [path.relative(ctx.cwd, resolved.path) || '.']
        }
      } else {
        if (!owned(formatter, resolved.path)) {
          return {
            content: `${args.path} is not one of the files ${formatter.name} formats.`,
            isError: true,
          }
        }
        files = [path.relative(ctx.cwd, resolved.path)]
      }
    } else if (formatter.wholeProject) {
      files = []
    } else {
      try {
        files = (await changedFiles(ctx.cwd, ctx.signal)).filter((file) => owned(formatter, file))
      } catch {
        return {
          content: 'Could not read the changes here: this folder is not a git repository.',
          isError: true,
        }
      }
      if (files.length === 0) {
        return { content: `No changed files for ${formatter.name}.` }
      }
    }

    const { command, args: commandArgs } = formatCommand(formatter, files, args.check === true)
    const shown = `${command} ${commandArgs.join(' ')}`

    return new Promise<ToolResult>((resolve) => {
      execFile(
        command,
        commandArgs,
        { cwd: ctx.cwd, timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, signal: ctx.signal },
        (error, stdout, stderr) => {
          const output = clipMiddle(`${stdout}${stderr ? `\n${stderr}` : ''}`.trim(), MAX_OUTPUT)
          if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
            resolve({
              content: `${formatter.name} is configured, but \`${command}\` was not found on this machine.`,
              isError: true,
            })
            return
          }
          if (error) {
            const code = typeof error.code === 'number' ? error.code : 1
            resolve({
              content: `${shown}\nexit ${code}${output ? `\n${output}` : ''}`,
              isError: true,
            })
            return
          }
          resolve({
            content: `${args.check ? 'Checked' : 'Formatted'} with ${formatter.name}${
              files.length > 0 ? `: ${files.join(', ')}` : ''
            }.${output ? `\n${output}` : ''}`,
          })
        },
      )
    })
  },
}
