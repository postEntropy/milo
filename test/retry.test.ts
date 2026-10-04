import { describe, expect, it, vi } from 'vitest'
import { fetchWithRetry } from '../src/core/providers/retry.js'

describe('fetchWithRetry', () => {
  it('returns immediately on a successful response', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const response = await fetchWithRetry('https://api.test', { method: 'POST' })
      expect(response.status).toBe(200)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('retries on 429 and succeeds on the second attempt', async () => {
    let calls = 0
    const fetchMock = vi.fn(async () => {
      calls += 1
      if (calls === 1) {
        return new Response('rate limited', { status: 429, headers: { 'retry-after': '0.01' } })
      }
      return new Response('ok', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const response = await fetchWithRetry(
        'https://api.test',
        { method: 'POST' },
        { baseDelayMs: 10, maxRetries: 2 },
      )
      expect(response.status).toBe(200)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('retries on 503 and 529 server errors', async () => {
    let calls = 0
    const fetchMock = vi.fn(async () => {
      calls += 1
      if (calls === 1) return new Response('service unavailable', { status: 503 })
      if (calls === 2) return new Response('overloaded', { status: 529 })
      return new Response('ok', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const response = await fetchWithRetry(
        'https://api.test',
        { method: 'POST' },
        { baseDelayMs: 10, maxRetries: 3 },
      )
      expect(response.status).toBe(200)
      expect(fetchMock).toHaveBeenCalledTimes(3)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('does not retry 400 Bad Request or 401 Unauthorized', async () => {
    const fetchMock = vi.fn(async () => new Response('unauthorized', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const response = await fetchWithRetry(
        'https://api.test',
        { method: 'POST' },
        { baseDelayMs: 10, maxRetries: 3 },
      )
      expect(response.status).toBe(401)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('aborts when the signal is cancelled during backoff', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn(async () => {
      controller.abort()
      return new Response('rate limited', { status: 429 })
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      await expect(
        fetchWithRetry(
          'https://api.test',
          { method: 'POST' },
          { baseDelayMs: 500, maxRetries: 3, signal: controller.signal },
        ),
      ).rejects.toThrow()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
