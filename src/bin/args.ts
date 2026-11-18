export interface Args {
  command: string
  provider?: string
  model?: string
  mode?: string
  yolo: boolean
  version: boolean
  help: boolean
  resume?: string
  continueSession: boolean
  /** `milo serve` without the web UI. */
  noWeb: boolean
  /** The port `milo serve` puts the web UI on. */
  webPort?: number
  /**
   * The project a session works in, by id, name or folder. The terminal predates
   * projects, so this is how it reaches one.
   */
  project?: string
  /** A folder to work in, registered or not. Mutually exclusive with `project`. */
  cwd?: string
  /** `milo run --session <id>`: continue that session instead of a fresh one. */
  session?: string
  /** `milo run --json`: one JSON object per event. */
  json: boolean
  /** `milo run --allow tool,…`: tools this unattended run may use without asking. */
  allow: string[]
  unknownFlags: string[]
  /** First flag that expected a value at the end of argv and got none. */
  missingValue?: string
  /** The bare words after the command — for `milo run`, the prompt. */
  prompt?: string
}

function takeValue(argv: string[], next: number, flag: string, args: Args): string | undefined {
  if (next >= argv.length) {
    args.missingValue ??= flag
    return undefined
  }
  return argv[next]
}

/**
 * The command line, parsed. Kept out of the entry point so it can be tested
 * without starting a TUI, and so a bad flag is a value rather than a crash.
 */
export function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: 'chat',
    version: false,
    help: false,
    yolo: false,
    continueSession: false,
    noWeb: false,
    json: false,
    allow: [],
    unknownFlags: [],
  }
  const commandAt = argv[0] && !argv[0].startsWith('-') ? 0 : -1
  if (commandAt === 0) args.command = argv[0]!

  const words: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    if (i === commandAt) continue
    const flag = argv[i]!
    if (flag === '--version' || flag === '-v') args.version = true
    else if (flag === '--help' || flag === '-h') args.help = true
    else if (flag === '--yolo') args.yolo = true
    else if (flag === '--no-web') args.noWeb = true
    else if (flag === '--json') args.json = true
    else if (flag === '--web-port') {
      const value = takeValue(argv, ++i, flag, args)
      if (value !== undefined) args.webPort = Number(value)
    } else if (flag === '--mode') args.mode = takeValue(argv, ++i, flag, args)
    else if (flag === '--provider') args.provider = takeValue(argv, ++i, flag, args)
    else if (flag === '--model' || flag === '-m') args.model = takeValue(argv, ++i, flag, args)
    else if (flag === '--resume') args.resume = takeValue(argv, ++i, flag, args)
    else if (flag === '--continue' || flag === '-c') args.continueSession = true
    else if (flag === '--project') args.project = takeValue(argv, ++i, flag, args)
    else if (flag === '--cwd') args.cwd = takeValue(argv, ++i, flag, args)
    else if (flag === '--session') args.session = takeValue(argv, ++i, flag, args)
    else if (flag === '--allow') {
      const value = takeValue(argv, ++i, flag, args)
      if (value) args.allow.push(...value.split(',').map((name) => name.trim()).filter(Boolean))
    } else if (flag.startsWith('-')) args.unknownFlags.push(flag)
    else words.push(flag)
  }

  if (words.length > 0) args.prompt = words.join(' ')
  return args
}
