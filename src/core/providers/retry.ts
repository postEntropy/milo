import { errorMessage } from '../../util/errors.js'
import { logWarn } from '../../util/log.js'

export interface RetryOptions {
  maxRetries?: number
  baseDelayMs?: number
  maxDelayMs?: number
  signal?: AbortSignal
  onRetry?: (attempt: number, delayMs: number, reason: string) => void
}

const DEFAULT_MAX_RETRIES = 3
const DEFAULT_BASE_DELAY_MS = 500
const DEFAULT_MAX_DELAY_MS = 10000

const RETRYABLE_STATUS_CODES = new Set([
  429, // Too Many Requests
  500, // Internal Server Error
  502, // Bad Gateway
  503, // Service Unavailable
  504, // Gateway Timeout
  529, // Overloaded (Anthropic)
])

function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS_CODES.has(status)
}

function parseRetryAfter(header: string | null, maxDelayMs: number): number | null {
  if (!header) return null
  const seconds = Number.parseFloat(header)
  if (!Number.isNaN(seconds) && seconds > 0) {
    return Math.min(Math.round(seconds * 1000), maxDelayMs)
  }
  const date = Date.parse(header)
  if (!Number.isNaN(date)) {
    const diff = date - Date.now()
    if (diff > 0) return Math.min(diff, maxDelayMs)
  }
  return null
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(signal?.reason ?? new Error('Aborted'))
    }
    signal?.addEventListener('abort', onAbort)
  })
}

/**
 * Performs a fetch request, retrying transient network errors and rate-limiting
 * or server overload status codes (429, 500, 502, 503, 504, 529) before returning.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options?: RetryOptions,
): Promise<Response> {
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES
  const baseDelay = options?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS
  const maxDelay = options?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
  const signal = options?.signal ?? (init.signal as AbortSignal | undefined)

  let attempt = 0
  while (true) {
    if (signal?.aborted) {
      throw signal.reason ?? new Error('Aborted')
    }

    try {
      const response = await fetch(url, init)
      if (response.ok || !isRetryableStatus(response.status) || attempt >= maxRetries) {
        return response
      }

      attempt += 1
      const headerDelay = parseRetryAfter(response.headers.get('retry-after'), maxDelay)
      const delayMs = headerDelay ?? Math.min(baseDelay * 2 ** (attempt - 1), maxDelay)
      const reason = `HTTP ${response.status} ${response.statusText}`
      logWarn(`provider request to ${url} failed with ${reason}, retrying in ${delayMs}ms (attempt ${attempt}/${maxRetries})`)
      options?.onRetry?.(attempt, delayMs, reason)

      await sleep(delayMs, signal)
    } catch (error) {
      if (signal?.aborted) throw error
      if (attempt >= maxRetries) throw error

      attempt += 1
      const delayMs = Math.min(baseDelay * 2 ** (attempt - 1), maxDelay)
      const reason = errorMessage(error)
      logWarn(`provider network request to ${url} failed (${reason}), retrying in ${delayMs}ms (attempt ${attempt}/${maxRetries})`)
      options?.onRetry?.(attempt, delayMs, reason)

      await sleep(delayMs, signal)
    }
  }
}
