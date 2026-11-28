import { isValidSessionId } from '../core/sessions/index.js'
import type { PermissionMode } from '../core/tools/permission.js'
import type { Args } from './args.js'

export type Command =
  | 'serve'
  | 'model'
  | 'setup'
  | 'chat'
  | 'skills'
  | 'history'
  | 'log'
  | 'routines'
  | 'projects'
  | 'google'
  | 'chatgpt'
  | 'mcp'
  | 'web'
  | 'spotlight'
  | 'pair'
  | 'devices'
  | 'version'
  | 'update'
  | 'export'
  | 'import'
  | 'run'

export const SERVE_USAGE = [
  'Usage:',
  '  milo serve                 Run the enabled bot gateways and the web UI',
  '  milo serve --no-web        Run the bot gateways without the web UI',
  '  milo serve --web-port <n>  Port for the web UI (default 7717)',
].join('\n')

const RESOURCE_COMMANDS = new Set<Command>([
  'skills',
  'history',
  'log',
  'routines',
  'projects',
  'mcp',
  'google',
  'chatgpt',
  'pair',
  'devices',
  'web',
  'spotlight',
  'version',
  'update',
  'export',
  'import',
])

export function isResourceCommand(command: Command | null): command is Command {
  return command !== null && RESOURCE_COMMANDS.has(command)
}

/**
 * Flags a resource command reads itself. The global parser does not know them,
 * so they are kept out of the unknown list for the command that owns them
 * rather than added to every command's vocabulary.
 */
const RESOURCE_FLAGS: Record<string, readonly string[]> = {
  chatgpt: ['--device', '--new'],
  export: ['--include-browser', '--include-embed', '--include-caches', '--all', '--no-secrets'],
  google: ['--access', '--client-id', '--client-secret', '--credentials'],
  history: ['--older-than', '--before', '--yes', '-y'],
  import: ['--dry-run', '--yes', '-y', '--no-backup'],
  log: ['-f', '--follow', '--older-than', '--before', '--yes', '-y'],
  projects: ['--name', '--icon'],
  routines: ['--every', '--at', '--days', '--day-of-month', '--month', '--gateway', '--to', '--chat', '--limit', '--silent', '--name', '--yes'],
  skills: ['--skill', '-s', '--yes', '-y'],
  update: ['--check', '--branch', '--to', '--force'],
  web: ['--no-open', '--host', '--port'],
}

/** What the command line asks for, or the message to say instead of running. */
export function validateArgs(args: Args): string | null {
  if (args.missingValue) {
    return `Missing value for "${args.missingValue}".`
  }
  const unknown = args.unknownFlags.filter((flag) => !RESOURCE_FLAGS[args.command]?.includes(flag))
  if (unknown.length > 0) {
    const valid = '--version (-v), --help (-h), --yolo, --no-web, --json, --web-port, --mode, --provider, --model (-m), --resume, --continue (-c), --project, --cwd, --session, --allow'
    return `Unknown option "${unknown[0]}". Valid options: ${valid}.`
  }
  if (args.mode && !['ask', 'auto', 'yolo'].includes(args.mode)) {
    return `Invalid --mode "${args.mode}". Use ask, auto or yolo.`
  }
  if (args.resume && !isValidSessionId(args.resume)) {
    return `Invalid session id "${args.resume}". Expected something like calm-otter-7.`
  }
  if (args.webPort !== undefined && (!Number.isInteger(args.webPort) || args.webPort < 0 || args.webPort > 65535)) {
    return `Invalid --web-port "${args.webPort}". Expected a port between 0 and 65535.`
  }
  if (args.project && args.cwd) {
    return 'Use one of --project or --cwd, not both: a project is a folder with a name, and --cwd is a folder as it is.'
  }
  if (args.session && !isValidSessionId(args.session)) {
    return `Invalid session id "${args.session}". Expected something like calm-otter-7.`
  }
  return null
}

/** `--yolo` is shorthand for `--mode yolo`. */
export function resolveInitialMode(args: Args): PermissionMode | undefined {
  return args.yolo ? 'yolo' : (args.mode as PermissionMode | undefined)
}

/** Maps the bare word on the command line to a known command. */
export function resolveCommand(command: string): Command | null {
  switch (command) {
    case 'serve':
    case 'model':
    case 'setup':
    case 'skills':
    case 'history':
    case 'log':
    case 'routines':
    case 'projects':
    case 'google':
    case 'chatgpt':
    case 'mcp':
    case 'web':
    case 'spotlight':
    case 'pair':
    case 'devices':
    case 'version':
    case 'update':
    case 'export':
    case 'import':
    case 'run':
    case 'chat':
      return command
    default:
      return null
  }
}
