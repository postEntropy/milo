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
  | 'mcp'
  | 'web'
  | 'spotlight'
  | 'pair'
  | 'devices'
  | 'run'

/** What the command line asks for, or the message to say instead of running. */
export function validateArgs(args: Args): string | null {
  if (args.unknownFlags.length > 0) {
    const valid = '--version (-v), --help (-h), --yolo, --no-web, --json, --web-port, --mode, --provider, --model (-m), --resume, --continue (-c), --project, --cwd, --session, --allow'
    return `Unknown option "${args.unknownFlags[0]}". Valid options: ${valid}.`
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
    case 'mcp':
    case 'web':
    case 'spotlight':
    case 'pair':
    case 'devices':
    case 'run':
    case 'chat':
      return command
    default:
      return null
  }
}
