import { describe, expect, it } from 'vitest'
import { appUrl, hostForUrl } from '../src/gateways/web/spotlight.js'

describe('the address the spotlight hands out', () => {
  it('names loopback when the daemon was bound to every interface', () => {
    expect(hostForUrl('0.0.0.0')).toBe('127.0.0.1')
    expect(hostForUrl('::')).toBe('127.0.0.1')
    expect(hostForUrl('')).toBe('127.0.0.1')
  })

  it('brackets a bare IPv6 address, which a URL cannot read otherwise', () => {
    expect(hostForUrl('::1')).toBe('[::1]')
    expect(hostForUrl('fe80::1')).toBe('[fe80::1]')
  })

  it('leaves a name that already works alone', () => {
    expect(hostForUrl('127.0.0.1')).toBe('127.0.0.1')
    expect(hostForUrl('localhost')).toBe('localhost')
  })

  it('carries the token and the session it is opening', () => {
    expect(appUrl({ host: '127.0.0.1', port: 7717, token: 'a b/c', open: 'calm-otter-7' }))
      .toBe('http://127.0.0.1:7717/?t=a+b%2Fc&open=calm-otter-7')
  })

  it('opens the app alone when there is no session and no token', () => {
    expect(appUrl({ host: '0.0.0.0', port: 7717 })).toBe('http://127.0.0.1:7717/')
  })
})
