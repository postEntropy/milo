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
  }
  if (argv[0] && !argv[0].startsWith('-')) args.command = argv[0]

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === '--version' || flag === '-v') args.version = true
    else if (flag === '--help' || flag === '-h') args.help = true
    else if (flag === '--yolo') args.yolo = true
    else if (flag === '--mode') args.mode = argv[++i]
    else if (flag === '--provider') args.provider = argv[++i]
    else if (flag === '--model' || flag === '-m') args.model = argv[++i]
    else if (flag === '--resume') args.resume = argv[++i]
    else if (flag === '--continue' || flag === '-c') args.continueSession = true
  }
  return args
}
