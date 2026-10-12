/**
 * `milo pair` — hands a phone the code that lets it in.
 *
 * A plain command that prints and exits, like the other `milo <resource> <verb>`
 * ones. It opens the one code where the daemon will look for it and prints it —
 * as a QR the app can scan, and in words for a phone that cannot — with the
 * addresses the daemon answers on. The app redeems the code at `/pair/claim` and
 * is handed a token of its own.
 */
import { readConfig } from '../core/config/load.js'
import { MILO_HOME } from '../core/config/paths.js'
import { qrMatrix, qrText } from '../core/qr.js'
import { isWildcardHost, reachableHosts } from '../gateways/web/http.js'
import { openPairing, PAIRING_TTL_MS } from '../gateways/web/pair.js'
import { errorMessage } from '../util/errors.js'

export interface PairIo {
  out(line: string): void
  err(line: string): void
}

const USAGE = [
  'Usage:',
  '  milo pair        Open a one-time code and print it as a QR to scan',
  '',
  'The code is good for two minutes and works once. A phone can only reach this',
  'machine at an address of its own — the tailnet or LAN one, never 127.0.0.1 — so',
  '`web.host` in ~/.milo/config.yml must name one (0.0.0.0 covers them all), and',
  '`milo serve` must be running to redeem the code.',
].join('\n')

/** What the app scans: the address, the port and the code in one link. */
export function pairingUrl(host: string, port: number, code: string): string {
  return `milo://pair?v=1&host=${encodeURIComponent(host)}&port=${port}&code=${code}`
}

export async function runPair(argv: string[] = [], io: Partial<PairIo> = {}): Promise<number> {
  const out = io.out ?? ((line: string) => console.log(line))
  const err = io.err ?? ((line: string) => console.error(line))

  const args = argv[0] === 'pair' ? argv.slice(1) : argv
  if (args.some((arg) => arg === 'help' || arg === '--help' || arg === '-h')) {
    out(USAGE)
    return 0
  }
  // An argument it does not know answers with the ones it does.
  if (args.length > 0) {
    err(`Unknown: milo pair ${args.join(' ')}`)
    err(USAGE)
    return 1
  }

  try {
    const config = readConfig()
    if (!config) {
      err('Milo is not configured. Run `milo` first to set things up.')
      return 1
    }
    const hosts = addressesFor(config.web.host)
    const open = openPairing()
    // The QR is worth drawing only for an address another device can open.
    const address = hosts.find((host) => !isLoopback(host))

    out('Pair a device with Milo')
    out('')
    if (address) {
      const scanned = qrMatrix(pairingUrl(address, config.web.port, open.code))
      if (scanned.ok) {
        for (const line of qrText(scanned.matrix)) out(line)
        out('')
        out('Scan this in the Milo app, or type the address and the code below.')
      } else {
        out(`(no QR: ${scanned.error}) — type the address and the code below.`)
      }
    } else {
      out('This machine offers only a loopback address, which no phone can reach.')
      out('Set `web.host` to 0.0.0.0 (or its tailnet address) in ~/.milo/config.yml,')
      out('restart `milo serve`, then run this again.')
    }
    out('')
    out(`  Address   ${describeAddresses(hosts, config.web.port)}`)
    out(`  Code      ${spacedCode(open.code)}`)
    out(`  Expires   in ${Math.round(PAIRING_TTL_MS / 60_000)} minutes, once`)
    out('')
    out(`The daemon must be running to redeem the code. (Codes live in ${MILO_HOME}.)`)
    return 0
  } catch (error) {
    err(errorMessage(error))
    return 1
  }
}

/**
 * The addresses to offer the app. A fixed bind names itself; bound to every
 * interface there is no such name, so the ones the machine answers on are listed.
 */
function addressesFor(bind: string): string[] {
  return isWildcardHost(bind) ? preferTailnet(reachableHosts()) : [bind.trim()]
}

/**
 * The addresses in the order to offer them, the tailnet first.
 *
 * Tailscale hands out addresses in the CGNAT range (100.64.0.0/10), and those are
 * the ones to lead with: the tailnet reaches this machine from anywhere, and a
 * phone is usually already allowed through to it — where a plain LAN address may
 * sit behind a host firewall that only the tailnet is let past.
 */
export function preferTailnet(hosts: string[]): string[] {
  const onTailnet = (host: string): boolean => {
    const [first, second] = host.split('.').map(Number)
    return first === 100 && second >= 64 && second <= 127
  }
  return [...hosts.filter(onTailnet), ...hosts.filter((host) => !onTailnet(host))]
}

function describeAddresses(hosts: string[], port: number): string {
  if (hosts.length === 0) return `(no address of its own) · port ${port}`
  const [first, ...rest] = hosts
  const also = rest.length > 0 ? `   (also ${rest.map((host) => withPort(host, port)).join(', ')})` : ''
  return `${withPort(first, port)}${also}`
}

const withPort = (host: string, port: number): string => `${host.includes(':') ? `[${host}]` : host}:${port}`

const isLoopback = (host: string): boolean => ['127.0.0.1', '::1', 'localhost'].includes(host.trim().toLowerCase())

/** `482913` reads as `482 913`, which is how it is said out loud. */
const spacedCode = (code: string): string => `${code.slice(0, 3)} ${code.slice(3)}`
