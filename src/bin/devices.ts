/**
 * `milo devices` — the phones and machines that have paired with this Milo, and
 * the way to take one back. A plain command that prints and exits.
 */
import { readDevices, revokeDevice } from '../gateways/web/devices.js'
import { errorMessage } from '../util/errors.js'

export interface DevicesIo {
  out(line: string): void
  err(line: string): void
}

const USAGE = [
  'Usage:',
  '  milo devices              the devices paired with this Milo',
  '  milo devices revoke <id>  forget one — its token stops working at once',
].join('\n')

export async function runDevices(argv: string[] = [], io: Partial<DevicesIo> = {}): Promise<number> {
  const out = io.out ?? ((line: string) => console.log(line))
  const err = io.err ?? ((line: string) => console.error(line))

  const args = argv[0] === 'devices' ? argv.slice(1) : argv
  const [command, ...rest] = args

  try {
    switch (command ?? 'list') {
      case 'list':
        return list(out)
      case 'revoke':
        return revoke(rest[0], out, err)
      case 'help':
        out(USAGE)
        return 0
      default:
        // An argument it does not know answers with the ones it does.
        err(`Unknown: milo devices ${command}`)
        err(USAGE)
        return 1
    }
  } catch (error) {
    err(errorMessage(error))
    return 1
  }
}

function list(out: DevicesIo['out']): number {
  const devices = readDevices()
  if (devices.length === 0) {
    out('No devices are paired. Run `milo pair` to add one.')
    return 0
  }
  out('Paired devices:')
  for (const device of devices) {
    out(`  ${shortId(device.id)}  ${device.name}  ·  ${device.platform}  ·  paired ${device.createdAt.slice(0, 10)}`)
  }
  out('')
  out('Take one back with `milo devices revoke <id>`.')
  return 0
}

function revoke(wanted: string | undefined, out: DevicesIo['out'], err: DevicesIo['err']): number {
  if (!wanted) {
    err('Which device? Give its id (see `milo devices`).')
    return 1
  }
  const matches = readDevices().filter((device) => device.id === wanted || device.id.startsWith(wanted))
  if (matches.length === 0) {
    err(`No paired device matches "${wanted}".`)
    return 1
  }
  if (matches.length > 1) {
    err(`"${wanted}" matches more than one device:`)
    for (const device of matches) err(`  ${shortId(device.id)}  ${device.name}`)
    return 1
  }
  revokeDevice(matches[0].id)
  out(`Revoked ${matches[0].name}. Its token no longer opens anything.`)
  return 0
}

/** The id as it is printed: enough to name a device without the whole uuid. */
const shortId = (id: string): string => id.slice(0, 8)
