import { describe, expect, it } from 'vitest'
import { humanSize, shortenPath } from '../src/util/format.js'

describe('humanSize', () => {
  it('says a size as a person reads it', () => {
    expect(humanSize(512)).toBe('512 B')
    expect(humanSize(1536)).toBe('1.5 KB')
    expect(humanSize(60817408)).toBe('58 MB')
  })

  it('drops a decimal that is only a zero — 448.0 KB is not more precise than 448 KB', () => {
    expect(humanSize(458752)).toBe('448 KB')
    expect(humanSize(1024 * 1024)).toBe('1 MB')
    expect(humanSize(1024 * 1024 * 1024)).toBe('1024 MB')
  })

  it('keeps a decimal that carries something', () => {
    expect(humanSize(1024 + 512)).toBe('1.5 KB')
  })
})

describe('shortenPath', () => {
  it('writes a path under the home directory the way a person does', () => {
    expect(shortenPath('/home/leo/.config/chromium', '/home/leo')).toBe('~/.config/chromium')
  })

  it('leaves anything else alone', () => {
    expect(shortenPath('/opt/helium', '/home/leo')).toBe('/opt/helium')
    expect(shortenPath('/home/leo', '/home/leo')).toBe('~')
  })

  it('is not fooled by a sibling whose name merely starts the same', () => {
    // `/home/leonardo2` is not inside `/home/leonardo`, and `~2/foo` is a path
    // that leads nowhere.
    expect(shortenPath('/home/leonardo2/foo', '/home/leonardo')).toBe('/home/leonardo2/foo')
  })

  it('copes with no home to shorten against', () => {
    expect(shortenPath('/somewhere', '')).toBe('/somewhere')
  })
})
