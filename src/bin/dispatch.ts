import { isValidSessionId } from '../core/sessions/index.js'
import type { PermissionMode } from '../core/tools/permission.js'
import type { Args } from './args.js'

export type Command = 'serve' | 'model' | 'setup' | 'chat'

/** What the command line asks for, or the message to say instead of running. */
export function validateArgs(args: Args): string | null {
  if (args.mode && !['ask', 'auto', 'yolo'].includes(args.mode)) {
    return `Invalid --mode "${args.mode}". Use ask, auto or yolo.`
  }
  if (args.resume && !isValidSessionId(args.resume)) {
    return `Invalid session id "${args.resume}". Expected something like calm-otter-7.`
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
    case 'chat':
      return command
    default:
      return null
  }
}
