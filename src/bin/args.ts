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
  /** The bare words after the command — for `milo run`, the prompt. */
  prompt?: string
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
    else if (flag === '--web-port') args.webPort = Number(argv[++i])
    else if (flag === '--mode') args.mode = argv[++i]
    else if (flag === '--provider') args.provider = argv[++i]
    else if (flag === '--model' || flag === '-m') args.model = argv[++i]
    else if (flag === '--resume') args.resume = argv[++i]
    else if (flag === '--continue' || flag === '-c') args.continueSession = true
    else if (flag === '--project') args.project = argv[++i]
    else if (flag === '--cwd') args.cwd = argv[++i]
    else if (flag === '--session') args.session = argv[++i]
    else if (flag === '--allow') {
      const value = argv[++i]
      if (value) args.allow.push(...value.split(',').map((name) => name.trim()).filter(Boolean))
    } else if (!flag.startsWith('-')) words.push(flag)
  }

  if (words.length > 0) args.prompt = words.join(' ')
  return args
}
