import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { MILO_HOME, devicesFile } from '../../core/config/paths.js'
import { errorMessage } from '../../util/errors.js'
import { logWarn } from '../../util/log.js'

/**
 * A phone or another machine that has paired with this Milo. The token itself is
 * never written down — only its hash, the way a password is kept — so the file can
 * be read without handing anyone the credential it stands for.
 */
export interface PairedDevice {
  id: string
  name: string
  platform: string
  tokenHash: string
  createdAt: string
}

let cached: { file: string; mtimeNs: bigint; size: bigint; devices: PairedDevice[] } | null = null

export function readDevices(): PairedDevice[] {
  const file = devicesFile()
  const stats = statSync(file, { bigint: true, throwIfNoEntry: false })
  if (!stats) {
    cached = null
    return []
  }
  if (cached && cached.file === file && cached.mtimeNs === stats.mtimeNs && cached.size === stats.size) {
    return cached.devices
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { devices?: unknown }
    const devices = Array.isArray(parsed.devices) ? parsed.devices.filter(isDevice) : []
    cached = { file, mtimeNs: stats.mtimeNs, size: stats.size, devices }
    return devices
  } catch (error) {
    cached = null
    logWarn(`could not read ${file} (ignoring it): ${errorMessage(error)}`)
    return []
  }
}

/** `0600`, like `auth.json`: it holds a credential, even hashed. */
function writeDevices(devices: PairedDevice[]): void {
  const file = devicesFile()
  mkdirSync(MILO_HOME, { recursive: true })
  writeFileSync(file, `${JSON.stringify({ devices }, null, 2)}\n`, { mode: 0o600 })
  try {
    chmodSync(file, 0o600)
  } catch {
    // best effort on platforms without chmod
  }
  const stats = statSync(file, { bigint: true, throwIfNoEntry: false })
  cached = stats ? { file, mtimeNs: stats.mtimeNs, size: stats.size, devices } : null
}

/** The digest a token is recognised by, kept in place of the token itself. */
const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex')

/** Mints a token for a device that has just paired, and remembers only its hash. */
export function addDevice(input: { name: string; platform: string }): { device: PairedDevice; token: string } {
  const token = randomBytes(32).toString('base64url')
  const device: PairedDevice = {
    id: randomUUID(),
    name: input.name,
    platform: input.platform,
    tokenHash: hashToken(token),
    createdAt: new Date().toISOString(),
  }
  writeDevices([...readDevices(), device])
  return { device, token }
}

/** Forgets a device; its token stops opening the gate at once. False if it was not there. */
export function revokeDevice(id: string): boolean {
  const devices = readDevices()
  const kept = devices.filter((device) => device.id !== id)
  if (kept.length === devices.length) return false
  writeDevices(kept)
  return true
}

/**
 * The device a token belongs to, if any. The digests are compared as bytes, so
 * the lookup tells a reader nothing about how far a wrong token got.
 */
export function deviceForToken(token: string): PairedDevice | undefined {
  if (!token) return undefined
  const hashed = Buffer.from(hashToken(token))
  return readDevices().find((device) => {
    const known = Buffer.from(device.tokenHash)
    return known.length === hashed.length && timingSafeEqual(known, hashed)
  })
}

function isDevice(value: unknown): value is PairedDevice {
  if (!value || typeof value !== 'object') return false
  const device = value as Record<string, unknown>
  return (
    typeof device.id === 'string' &&
    typeof device.name === 'string' &&
    typeof device.platform === 'string' &&
    typeof device.tokenHash === 'string' &&
    typeof device.createdAt === 'string'
  )
}
