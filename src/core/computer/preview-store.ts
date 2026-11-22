import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import type { ImageMime } from '../providers/types.js'
import type { ComputerToolPreview } from './types.js'

export const PREVIEW_MAX_LONG_EDGE = 768
export const PREVIEW_MAX_BYTES = 100 * 1024
export const PREVIEW_TTL_MS = 10 * 60 * 1000
export const PREVIEW_MAX_ENTRIES = 64
export const PREVIEW_MAX_TOTAL_BYTES = 4 * 1024 * 1024

export interface PreviewEntry {
  id: string
  callId: string
  sessionId: string
  ownerPrincipal: string
  mimeType: ImageMime
  bytes: Buffer
  width: number
  height: number
  expiresAt: number
}

export interface PreviewPutInput {
  callId: string
  sessionId: string
  ownerPrincipal: string
  mimeType: ImageMime
  data: string
  width: number
  height: number
}

export type PreviewLookupResult =
  | { ok: true; entry: PreviewEntry }
  | { ok: false; status: 400 | 403 | 404 | 410; reason: 'bad_request' | 'forbidden' | 'not_found' | 'expired' }

function scaledDimensions(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round(height))
  const longest = Math.max(w, h)
  if (longest <= maxEdge) return { width: w, height: h }
  const ratio = maxEdge / longest
  return {
    width: Math.max(1, Math.round(w * ratio)),
    height: Math.max(1, Math.round(h * ratio)),
  }
}

function runFfmpegThumbnail(input: Buffer, maxEdge: number, qscale: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const scale = `scale='if(gte(iw,ih),min(${maxEdge},iw),-2)':'if(gte(iw,ih),-2,min(${maxEdge},ih))'`
    const child = spawn(
      'ffmpeg',
      ['-v', 'error', '-i', 'pipe:0', '-vf', scale, '-frames:v', '1', '-q:v', String(qscale), '-f', 'mjpeg', 'pipe:1'],
      { stdio: ['pipe', 'pipe', 'ignore'] },
    )
    const chunks: Buffer[] = []
    let total = 0
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve(null)
    }, 4000)

    child.stdout.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total <= PREVIEW_MAX_BYTES * 4) chunks.push(chunk)
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0 || chunks.length === 0) {
        resolve(null)
        return
      }
      resolve(Buffer.concat(chunks))
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(input)
  })
}

/**
 * Produces an in-memory thumbnail guaranteed to fit within 768 px long edge and
 * 100 KiB. Never writes bytes to disk.
 */
export async function buildThumbnail(input: {
  mimeType: ImageMime
  data: string
  width: number
  height: number
}): Promise<{ mimeType: ImageMime; bytes: Buffer; width: number; height: number } | null> {
  if (!input.data) return null
  let raw: Buffer
  try {
    raw = Buffer.from(input.data, 'base64')
  } catch {
    return null
  }
  if (raw.length === 0) return null

  const dims = scaledDimensions(input.width, input.height, PREVIEW_MAX_LONG_EDGE)
  const needsResize = Math.max(input.width, input.height) > PREVIEW_MAX_LONG_EDGE
  const needsShrink = raw.length > PREVIEW_MAX_BYTES

  if (needsResize || needsShrink) {
    for (const qscale of [6, 10, 15, 22, 28]) {
      const encoded = await runFfmpegThumbnail(raw, PREVIEW_MAX_LONG_EDGE, qscale)
      if (encoded && encoded.length > 0 && encoded.length <= PREVIEW_MAX_BYTES) {
        return { mimeType: 'image/jpeg', bytes: encoded, width: dims.width, height: dims.height }
      }
    }
    return null
  }

  return { mimeType: input.mimeType, bytes: raw, width: dims.width, height: dims.height }
}

/**
 * Bounded, in-memory-only thumbnail cache for expanded Computer Use tool rows.
 * Every entry expires after 10 minutes and is scoped to its exact tool call,
 * Session, and originating client authorization principal.
 */
export class ComputerPreviewStore {
  private readonly entries = new Map<string, PreviewEntry>()
  private readonly expiredIds = new Set<string>()
  private totalBytes = 0
  private readonly ttlMs: number
  private readonly maxEntries: number
  private readonly maxTotalBytes: number
  private readonly now: () => number
  private sweepTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false

  constructor(options: {
    ttlMs?: number
    maxEntries?: number
    maxTotalBytes?: number
    now?: () => number
  } = {}) {
    this.ttlMs = options.ttlMs ?? PREVIEW_TTL_MS
    this.maxEntries = options.maxEntries ?? PREVIEW_MAX_ENTRIES
    this.maxTotalBytes = options.maxTotalBytes ?? PREVIEW_MAX_TOTAL_BYTES
    this.now = options.now ?? (() => Date.now())
  }

  async put(input: PreviewPutInput): Promise<ComputerToolPreview | null> {
    if (this.closed) return null
    this.prune()
    const thumb = await buildThumbnail({
      mimeType: input.mimeType,
      data: input.data,
      width: input.width,
      height: input.height,
    })
    if (this.closed || !thumb || thumb.bytes.length > PREVIEW_MAX_BYTES) return null

    const id = randomBytes(24).toString('base64url')
    const entry: PreviewEntry = {
      id,
      callId: input.callId,
      sessionId: input.sessionId,
      ownerPrincipal: input.ownerPrincipal,
      mimeType: thumb.mimeType,
      bytes: thumb.bytes,
      width: thumb.width,
      height: thumb.height,
      expiresAt: this.now() + this.ttlMs,
    }

    while (
      this.entries.size >= this.maxEntries ||
      this.totalBytes + entry.bytes.length > this.maxTotalBytes
    ) {
      const oldestKey = this.entries.keys().next().value
      if (!oldestKey) break
      this.evict(oldestKey)
    }

    this.entries.set(id, entry)
    this.totalBytes += entry.bytes.length
    this.scheduleSweep()
    return { id, width: entry.width, height: entry.height }
  }

  get(
    id: string,
    check: {
      principal: string
      callId: string | null | undefined
      sessionId: string | null | undefined
      canAccessSession: (sessionId: string) => boolean
    },
  ): PreviewLookupResult {
    this.prune()
    if (!check.callId?.trim() || !check.sessionId?.trim()) {
      return { ok: false, status: 400, reason: 'bad_request' }
    }
    const entry = this.entries.get(id)
    if (!entry) {
      if (this.expiredIds.has(id)) {
        return { ok: false, status: 410, reason: 'expired' }
      }
      return { ok: false, status: 404, reason: 'not_found' }
    }
    if (entry.expiresAt <= this.now()) {
      this.evict(id)
      this.scheduleSweep()
      return { ok: false, status: 410, reason: 'expired' }
    }
    if (entry.ownerPrincipal !== check.principal) {
      return { ok: false, status: 403, reason: 'forbidden' }
    }
    if (entry.callId !== check.callId) {
      return { ok: false, status: 403, reason: 'forbidden' }
    }
    if (entry.sessionId !== check.sessionId) {
      return { ok: false, status: 403, reason: 'forbidden' }
    }
    if (!check.canAccessSession(entry.sessionId)) {
      return { ok: false, status: 403, reason: 'forbidden' }
    }
    // Refresh LRU position without extending expiry.
    this.entries.delete(id)
    this.entries.set(id, entry)
    return { ok: true, entry }
  }

  revokePrincipal(principal: string): void {
    for (const [id, entry] of this.entries) {
      if (entry.ownerPrincipal === principal) this.evict(id)
    }
    this.scheduleSweep()
  }

  revokeSession(sessionId: string): void {
    for (const [id, entry] of this.entries) {
      if (entry.sessionId === sessionId) this.evict(id)
    }
    this.scheduleSweep()
  }

  clear(): void {
    for (const id of [...this.entries.keys()]) {
      this.evict(id)
    }
    this.clearSweepTimer()
  }

  /** Releases all cached preview bytes and cancels the background expiry timer on shutdown. */
  close(): void {
    this.closed = true
    this.clearSweepTimer()
    this.entries.clear()
    this.expiredIds.clear()
    this.totalBytes = 0
  }

  get size(): number {
    return this.entries.size
  }

  get bytes(): number {
    return this.totalBytes
  }

  private prune(): void {
    const now = this.now()
    let evicted = false
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.evict(id)
        evicted = true
      }
    }
    if (evicted) this.scheduleSweep()
  }

  private scheduleSweep(): void {
    this.clearSweepTimer()
    if (this.closed || this.entries.size === 0) return
    let earliest = Number.POSITIVE_INFINITY
    for (const entry of this.entries.values()) {
      if (entry.expiresAt < earliest) earliest = entry.expiresAt
    }
    if (!Number.isFinite(earliest)) return
    const delay = Math.max(0, earliest - this.now())
    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = null
      this.prune()
      this.scheduleSweep()
    }, delay)
    this.sweepTimer.unref?.()
  }

  private clearSweepTimer(): void {
    if (this.sweepTimer !== null) {
      clearTimeout(this.sweepTimer)
      this.sweepTimer = null
    }
  }

  private evict(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    this.entries.delete(id)
    this.totalBytes = Math.max(0, this.totalBytes - entry.bytes.length)
    this.expiredIds.add(id)
    if (this.expiredIds.size > 512) {
      const oldest = this.expiredIds.values().next().value
      if (oldest) this.expiredIds.delete(oldest)
    }
  }
}
