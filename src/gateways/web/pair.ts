import { randomInt, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { MILO_HOME, pairingFile } from '../../core/config/paths.js'
import { errorMessage } from '../../util/errors.js'
import { logWarn } from '../../util/log.js'

/**
 * How long a code is good for. Short on purpose: it is read off one screen and
 * typed into another in the same minute, or it is not used at all.
 */
export const PAIRING_TTL_MS = 2 * 60 * 1000

export interface OpenPairing {
  code: string
  /** Epoch ms. */
  expiresAt: number
}

/**
 * Opens the one code, replacing whatever was there. `milo pair` prints it and the
 * daemon redeems it, so it is written rather than held: the two are separate
 * processes. One at a time, so "the code on the screen" is never ambiguous.
 */
export function openPairing(now = Date.now()): OpenPairing {
  const open: OpenPairing = {
    code: String(randomInt(0, 1_000_000)).padStart(6, '0'),
    expiresAt: now + PAIRING_TTL_MS,
  }
  mkdirSync(MILO_HOME, { recursive: true })
  writeFileSync(pairingFile(), `${JSON.stringify(open)}\n`, { mode: 0o600 })
  try {
    chmodSync(pairingFile(), 0o600)
  } catch {
    // best effort on platforms without chmod
  }
  return open
}

/** The code still open, or null when there is none or it has run out of time. */
export function currentPairing(now = Date.now()): OpenPairing | null {
  if (!existsSync(pairingFile())) return null
  try {
    const open = JSON.parse(readFileSync(pairingFile(), 'utf8')) as Partial<OpenPairing>
    if (typeof open.code !== 'string' || typeof open.expiresAt !== 'number' || open.expiresAt <= now) return null
    return { code: open.code, expiresAt: open.expiresAt }
  } catch (error) {
    logWarn(`could not read ${pairingFile()}: ${errorMessage(error)}`)
    return null
  }
}

/**
 * Spends a code: the right one, still open, once. The file goes whether it matched
 * or not only when it did — a wrong guess leaves the code for its owner to use.
 */
export function redeemPairing(code: string, now = Date.now()): boolean {
  const open = currentPairing(now)
  if (!open) return false
  const given = Buffer.from(code)
  const expected = Buffer.from(open.code)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false
  clearPairing()
  return true
}

export function clearPairing(): void {
  rmSync(pairingFile(), { force: true })
}

/**
 * How many times one address may try a code before it is left out for a while.
 * Six digits is a million forms and the code lives two minutes — but a million
 * guesses do not fit in two minutes only if the tries are capped, so they are.
 */
export class ClaimLimiter {
  private readonly seen = new Map<string, { count: number; resetAt: number }>()

  constructor(
    private readonly max = 10,
    private readonly windowMs = 60 * 1000,
  ) {}

  /** Whether another try from this address is allowed, counting this one. */
  allow(from: string, now = Date.now()): boolean {
    const entry = this.seen.get(from)
    if (!entry || entry.resetAt <= now) {
      this.seen.set(from, { count: 1, resetAt: now + this.windowMs })
      return true
    }
    entry.count += 1
    return entry.count <= this.max
  }
}
