/**
 * `milo google` — connecting the account, and looking at the connection.
 *
 * A plain command that prints and exits, like the other `milo <resource> <verb>`
 * ones. The connection needs somewhere to put a client id and a browser to open,
 * and a terminal is both; a setup row can come later and call this.
 */
import process from 'node:process'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { readAuth, readConfig, saveAuth } from '../core/config/load.js'
import { connectGoogle } from '../core/google/connect.js'
import { googleState } from '../core/google/state.js'
import {
  GOOGLE_TIERS,
  GoogleAccessSchema,
  accessLabel,
  describeAccess,
  type GoogleAccess,
} from '../core/google/tiers.js'
import { GOOGLE_SHORTCUT, googleStepsInWords } from '../core/google/walkthrough.js'
import { googleToolNames, googleWriteToolNames } from '../core/tools/index.js'
import { errorMessage } from '../util/errors.js'
import { hyperlink } from '../util/terminal.js'

const CLOUD = 'https://console.cloud.google.com/apis/credentials'

const USAGE = [
  'Usage:',
  '  milo google connect [--access <level>] [--client-id <id>] [--client-secret <secret>] [--credentials <file>]',
  '  milo google status         what is connected, or what is missing',
  '  milo google forget         drop the grant, keeping the app identity',
  '',
  '`connect` needs an OAuth client of the type "Desktop app" from a Cloud project',
  'of your own, with the Gmail and Drive APIs enabled — run it without arguments',
  'and it prints the steps, with the links.',
  '',
  `\`--access\` picks how much Milo may do: ${GOOGLE_TIERS.map((tier) => tier.id).join(', ')}.`,
  'Without it, connect asks — and a run with no terminal to ask on stops rather',
  'than choosing a level on its own.',
  '',
  'The shortcut Google documents creates the project, enables the Workspace APIs',
  `and downloads a credentials.json: ${GOOGLE_SHORTCUT}`,
  '',
  'While that Cloud app is in "Testing", Google kills its refresh token every seven',
  'days; publishing it (no review needed for one person) is what stops that.',
].join('\n')

export interface GoogleIo {
  out(line: string): void
  err(line: string): void
  ask(question: string): Promise<string>
  /** For the client secret: typing a secret in the open puts it in the scrollback. */
  askHidden(question: string): Promise<string>
}

export async function runGoogle(argv: string[], io: Partial<GoogleIo> = {}): Promise<number> {
  const out = io.out ?? ((line: string) => console.log(line))
  const err = io.err ?? ((line: string) => console.error(line))
  const ask = io.ask ?? askOnTty
  const askHidden = io.askHidden ?? askHiddenOnTty

  const args = argv[0] === 'google' ? argv.slice(1) : argv
  const [command, ...rest] = args

  try {
    switch (command ?? 'status') {
      case 'connect':
        return await connect(rest, { out, err, ask, askHidden })
      case 'status':
        return status(out)
      case 'forget':
        return forget(out)
      case 'help':
        out(USAGE)
        return 0
      default:
        // An argument it does not know answers with the ones it does.
        err(`Unknown: milo google ${command}`)
        err(USAGE)
        return 1
    }
  } catch (error) {
    err(errorMessage(error))
    return 1
  }
}

function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name)
  const value = at >= 0 ? argv[at + 1] : undefined
  return value && !value.startsWith('--') ? value : undefined
}

/**
 * Three states, and they are different things: off in the config, wanted but not
 * granted, and connected. Saying only two of them hides the one the person is in.
 */
function status(out: GoogleIo['out']): number {
  const auth = readAuth()
  const state = googleState(readConfig(), auth)

  if (state.kind === 'off') {
    out('Google is off. Turn it on with `milo google connect`, or in the config.')
    return 0
  }
  if (state.kind === 'wanted') {
    out('Google is on in the config, but no account is connected — run `milo google connect`.')
    return 0
  }
  const who = state.email ? ` as ${state.email}` : ''
  const when = state.connectedAt ? ` since ${state.connectedAt.slice(0, 10)}` : ''
  out(`Connected${who}${when}. Access: ${accessLabel(state.access)} — ${describeAccess(state.access)}`)
  // The tool names come off the factories that will actually answer, so this line
  // cannot go on naming one service after the grant has grown another.
  const tools = googleToolNames(auth.google ?? null)
  const writeTools = googleWriteToolNames(auth.google ?? null)
  out(`  Reading tools: ${tools.join(', ')}.`)
  out(`  Tools that can change mail or its labels: ${writeTools.join(', ')}.`)
  if (!state.enabled) out('…but the config says `google.enabled: false`, so the tools are not registered.')
  return 0
}

function forget(out: GoogleIo['out']): number {
  const auth = readAuth()
  if (!auth.google) {
    out('Nothing to forget — no Google grant is stored.')
    return 0
  }
  delete auth.google
  saveAuth(auth)
  out('Grant dropped. The tools will answer that Milo is not connected.')
  return 0
}

/**
 * The client id and secret out of the file Google's own shortcut downloads.
 *
 * Both shapes are accepted: a "Desktop app" client arrives under `installed`, and
 * a web one under `web` — refusing the second would be a rule about a file that
 * is not ours to police.
 */
export function clientFromCredentials(file: string): { clientId: string; clientSecret: string } {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  const entry = (parsed.installed ?? parsed.web ?? parsed) as Record<string, unknown>
  const clientId = typeof entry.client_id === 'string' ? entry.client_id : ''
  const clientSecret = typeof entry.client_secret === 'string' ? entry.client_secret : ''
  return { clientId, clientSecret }
}

async function connect(argv: string[], io: Required<GoogleIo>): Promise<number> {
  const existing = readAuth().google
  const file = flag(argv, '--credentials')
  let fromFile: { clientId: string; clientSecret: string } | null = null
  if (file) {
    try {
      fromFile = clientFromCredentials(file)
    } catch (error) {
      io.err(`Could not read ${file}: ${errorMessage(error)}`)
      return 1
    }
  }

  // The walkthrough only when there is nothing yet: someone reconnecting does not
  // need the console explained again.
  if (!existing?.clientId && !file && !flag(argv, '--client-id')) {
    io.out('Google needs an OAuth client of your own. Once, at this machine:')
    io.out('')
    for (const line of googleStepsInWords()) io.out(line.startsWith('     http') ? `     ${hyperlink(line.trim())}` : line)
    io.out('')
    io.out('Or use the shortcut above and pass the downloaded file: --credentials <file>')
    io.out('')
  }

  const clientId = (
    flag(argv, '--client-id') ??
    fromFile?.clientId ??
    existing?.clientId ??
    (await io.ask('OAuth client id: '))
  ).trim()
  const clientSecret = (
    flag(argv, '--client-secret') ??
    fromFile?.clientSecret ??
    existing?.clientSecret ??
    (await io.askHidden('OAuth client secret (not echoed): '))
  ).trim()

  if (!clientId || !clientSecret) {
    io.err('A client id and a client secret are both needed.')
    io.err(USAGE)
    return 1
  }

  // Asked, never assumed: the level is a decision and there is no default. A run
  // with no terminal answers nothing, and that stops rather than choosing.
  const access = await chooseAccess(argv, existing?.access, io)
  if (!access) return 1

  const connected = await connectGoogle({
    clientId,
    clientSecret,
    access,
    onUrl: (url) => {
      io.out('Open this in a browser and allow the access Milo asked for:')
      io.out(`  ${hyperlink(url)}`)
      io.out('(waiting for Google to answer on this machine…)')
    },
  })
  if (!connected.ok) {
    io.err(connected.error)
    return 1
  }
  if (connected.value.warning) io.err(connected.value.warning)
  if (connected.value.enabledInConfig) io.out('Turned `google.enabled` on in the config.')

  const who = connected.value.account.email
  io.out(`Connected${who ? ` as ${who}` : ''} — access: ${accessLabel(access)}.`)
  io.out(`  ${describeAccess(access)}`)
  io.out('  gmail_search/gmail_read for mail, drive_search/drive_read for files.')
  io.out(
    '  If it stops working in about a week, the Cloud app is still in "Testing": publishing it ' +
      `(OAuth consent screen, at ${CLOUD}) stops the seven-day expiry.`,
  )
  return 0
}

/**
 * The access level for this connection: `--access` when it was given, otherwise a
 * question. An answer that is neither is refused with the valid ones listed — a
 * default picked silently here would be a grant nobody chose.
 */
async function chooseAccess(
  argv: string[],
  current: GoogleAccess | undefined,
  io: Required<GoogleIo>,
): Promise<GoogleAccess | null> {
  const given = flag(argv, '--access')
  if (given !== undefined) {
    const parsed = GoogleAccessSchema.safeParse(given)
    if (parsed.success) return parsed.data
    io.err(`Unknown access level: ${given}`)
    io.err(`Valid levels: ${GOOGLE_TIERS.map((tier) => tier.id).join(', ')}`)
    return null
  }

  io.out('')
  io.out('How much should Milo be allowed to do with this account?')
  for (const [index, tier] of GOOGLE_TIERS.entries()) {
    const marker = tier.id === current ? '  (current)' : ''
    io.out(`  ${index + 1}. ${tier.label} — ${tier.description}${marker}`)
  }
  const answer = (await io.ask(`Access level (1-${GOOGLE_TIERS.length}, or the name): `)).trim().toLowerCase()
  const byNumber = /^\d+$/.test(answer) ? GOOGLE_TIERS[Number(answer) - 1]?.id : undefined
  const parsed = GoogleAccessSchema.safeParse(byNumber ?? answer)
  if (parsed.success) return parsed.data

  io.err('No access level was chosen.')
  io.err(`Pick one of: ${GOOGLE_TIERS.map((tier) => tier.id).join(', ')}`)
  return null
}

async function askOnTty(question: string): Promise<string> {
  if (!process.stdin.isTTY) return ''
  const readline = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await readline.question(question)
  } finally {
    readline.close()
  }
}

/**
 * Reads a secret without echoing it. A client secret that is printed as it is
 * typed is a client secret in the scrollback of every terminal it was typed in.
 */
function askHiddenOnTty(question: string): Promise<string> {
  if (!process.stdin.isTTY) return Promise.resolve('')
  const stdin = process.stdin
  const wasRaw = stdin.isRaw
  process.stdout.write(question)
  return new Promise<string>((resolve) => {
    let value = ''
    const done = (): void => {
      stdin.removeListener('data', onData)
      stdin.setRawMode?.(wasRaw ?? false)
      stdin.pause()
      process.stdout.write('\n')
      resolve(value)
    }
    const onData = (chunk: Buffer): void => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n' || char === '\u0003') {
          done()
          return
        }
        if (char === '\u007f') {
          value = value.slice(0, -1)
          continue
        }
        value += char
        process.stdout.write('*')
      }
    }
    stdin.setRawMode?.(true)
    stdin.resume()
    stdin.on('data', onData)
  })
}
