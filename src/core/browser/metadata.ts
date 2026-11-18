import { lookup } from 'node:dns/promises'

const METADATA_HOSTS = new Set(['metadata.google.internal', 'metadata.goog'])
const DNS_CACHE_TTL_MS = 30_000
const dnsCache = new Map<string, { blocked: boolean; expiresAt: number }>()

/** Strips brackets, zone suffixes (`%eth0`), and trailing dots from a URL hostname. */
function normalizeHost(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/%[^/]*$/, '')
    .replace(/\.+$/, '')
}

/** Extracts an IPv4 dotted address from an IPv4-mapped IPv6 form (`::ffff:a9fe:a9fe` or `::ffff:169.254.169.254`). */
function extractMappedIpv4(host: string): string | null {
  const expanded = host.startsWith('0:0:0:0:0:ffff:') ? `::ffff:${host.slice(15)}` : host
  if (!expanded.startsWith('::ffff:')) return null
  const tail = expanded.slice(7)
  if (/^\d+\.\d+\.\d+\.\d+$/.test(tail)) return tail
  const match = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail)
  if (!match) return null
  const hi = Number.parseInt(match[1]!, 16)
  const lo = Number.parseInt(match[2]!, 16)
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`
}

/**
 * Whether a hostname or literal IP targets a cloud instance metadata service or
 * IPv6 link-local space (`169.254.0.0/16`, `100.100.100.200`, `fd00:ec2::254`,
 * `fe80::/10`, and IPv4-mapped IPv6 forms). Loopback remains allowed for local servers.
 */
export function isMetadataHost(hostname: string): boolean {
  const host = normalizeHost(hostname)
  if (!host) return false
  if (METADATA_HOSTS.has(host)) return true

  const mapped = extractMappedIpv4(host)
  const ipv4 = mapped ?? (/^\d+\.\d+\.\d+\.\d+$/.test(host) ? host : null)
  if (ipv4) {
    return ipv4.startsWith('169.254.') || ipv4 === '100.100.100.200'
  }

  return host === 'fd00:ec2::254' || /^fe[89ab][0-9a-f]?:/.test(host)
}

/** Synchronous literal check on a URL string for metadata endpoints. */
export function isMetadataUrl(rawUrl: string): boolean {
  try {
    return isMetadataHost(new URL(rawUrl).hostname)
  } catch {
    return false
  }
}

/** Checks literal hostnames and resolved DNS records (cached briefly) for metadata IPs. */
export async function resolvesToMetadataHost(hostname: string): Promise<boolean> {
  const host = normalizeHost(hostname)
  if (!host) return false
  if (isMetadataHost(host)) return true
  if (host === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) return false

  const now = Date.now()
  const cached = dnsCache.get(host)
  if (cached && cached.expiresAt > now) return cached.blocked

  let blocked = false
  try {
    const records = await lookup(host, { all: true })
    blocked = records.some((record) => isMetadataHost(record.address))
  } catch {
    blocked = false
  }
  if (dnsCache.size >= 512) dnsCache.clear()
  dnsCache.set(host, { blocked, expiresAt: now + DNS_CACHE_TTL_MS })
  return blocked
}
