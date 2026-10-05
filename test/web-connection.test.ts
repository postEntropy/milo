import { describe, expect, it } from 'vitest'
import { closeOutcome } from '../web/src/lib/connection.js'

describe('what a closed web socket means', () => {
  it('retries a drop, because the conversation is still there to keep', () => {
    expect(closeOutcome({ everOnline: true, reachable: false })).toEqual({ retry: true, status: { state: 'offline' } })
  })

  it('stops on the reason the server gave, rather than looping on it', () => {
    const outcome = closeOutcome({
      everOnline: false,
      error: 'Unsupported protocol version or duplicate handshake.',
      reachable: true,
    })
    expect(outcome.retry).toBe(false)
    expect(outcome.status).toEqual({
      state: 'refused',
      reason: 'Unsupported protocol version or duplicate handshake.',
    })
  })

  it('reads a server that is up but refused the page as a refusal', () => {
    const outcome = closeOutcome({ everOnline: false, reachable: true })
    expect(outcome.retry).toBe(false)
    expect(outcome.status.state).toBe('refused')
    expect(outcome.status.reason).toContain('refused this page')
  })

  it('keeps retrying a server that was not there to answer, so a restart reconnects', () => {
    expect(closeOutcome({ everOnline: false, reachable: false })).toEqual({ retry: true, status: { state: 'offline' } })
  })
})
