import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { copyProfile, profileBytes, readProfileOrigin } from '../src/core/browser/profile.js'

/**
 * Copying a profile, against a profile of the test's own.
 *
 * The point of the copy is what it leaves behind: most of a browser profile is
 * cache, and a copy that took the cache would be as slow and as big as the real
 * thing for no login at all.
 */
const roots: string[] = []

function dir(): string {
  const made = mkdtempSync(path.join(tmpdir(), 'milo-profile-'))
  roots.push(made)
  return made
}

/** A profile with the files a sign-in lives in, and caches it must not copy. */
function profile(): string {
  const root = dir()
  const defaultDir = path.join(root, 'Default')
  mkdirSync(path.join(defaultDir, 'Local Storage'), { recursive: true })
  mkdirSync(path.join(defaultDir, 'IndexedDB'), { recursive: true })
  mkdirSync(path.join(defaultDir, 'Service Worker', 'CacheStorage'), { recursive: true })
  mkdirSync(path.join(defaultDir, 'Cache'), { recursive: true })

  writeFileSync(path.join(root, 'Local State'), '{"os_crypt":{}}')
  writeFileSync(path.join(defaultDir, 'Cookies'), 'SQLite format 3\0the cookies')
  writeFileSync(path.join(defaultDir, 'Preferences'), '{"profile":{}}')
  writeFileSync(path.join(defaultDir, 'Local Storage', 'leveldb.ldb'), 'a token')
  writeFileSync(path.join(defaultDir, 'IndexedDB', 'thing.indexeddb'), 'anothe token')
  // The cache: megabytes in real life, and nothing to do with being signed in.
  writeFileSync(path.join(defaultDir, 'Service Worker', 'CacheStorage', 'blob'), 'x'.repeat(50_000))
  writeFileSync(path.join(defaultDir, 'Cache', 'blob'), 'y'.repeat(50_000))
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('copyProfile', () => {
  it('brings what carries a sign-in', async () => {
    const source = profile()
    const target = path.join(dir(), 'copied')
    await copyProfile(source, target)

    for (const part of [
      'Local State',
      path.join('Default', 'Cookies'),
      path.join('Default', 'Preferences'),
      path.join('Default', 'Local Storage', 'leveldb.ldb'),
      path.join('Default', 'IndexedDB', 'thing.indexeddb'),
    ]) {
      expect(readFileSync(path.join(target, part), 'utf8')).toBeTruthy()
    }
  })

  it('leaves the cache behind, which is most of a profile', async () => {
    const source = profile()
    const target = path.join(dir(), 'copied')
    const result = await copyProfile(source, target)

    expect(() => readFileSync(path.join(target, 'Default', 'Service Worker', 'CacheStorage', 'blob'))).toThrow()
    expect(() => readFileSync(path.join(target, 'Default', 'Cache', 'blob'))).toThrow()
    // 100 KB of cache in the source, and the copy is the few small files.
    expect(result.bytes).toBeLessThan(1000)
    expect(result.parts).toBe(5)
  })

  it('starts from scratch, so a stale cookie database cannot survive', async () => {
    const source = profile()
    const target = path.join(dir(), 'copied')
    mkdirSync(path.join(target, 'Default'), { recursive: true })
    writeFileSync(path.join(target, 'Default', 'Cookies'), 'an older copy')

    await copyProfile(source, target)
    expect(readFileSync(path.join(target, 'Default', 'Cookies'), 'utf8')).toContain('the cookies')
  })

  it('records where it came from, and when', async () => {
    const source = profile()
    const target = path.join(dir(), 'copied')
    await copyProfile(source, target)

    const origin = await readProfileOrigin(target)
    expect(origin?.from).toBe(source)
    expect(Number.isNaN(Date.parse(origin!.at))).toBe(false)
  })

  it('tightens what it copied, even when the source was loose-handed', async () => {
    const source = profile()
    chmodSync(path.join(source, 'Default', 'Cookies'), 0o644)
    chmodSync(path.join(source, 'Default'), 0o755)
    const target = path.join(dir(), 'copied')
    await copyProfile(source, target)

    // Session cookies at 0644 are readable by every account on the machine.
    expect(statSync(path.join(target, 'Default', 'Cookies')).mode & 0o777).toBe(0o600)
    expect(statSync(path.join(target, 'Default')).mode & 0o777).toBe(0o700)
  })

  it('refuses a directory that is not a profile', async () => {
    const empty = dir()
    await expect(copyProfile(empty, path.join(dir(), 'copied'))).rejects.toThrow(/nothing in it to copy/)
  })
})

describe('profileBytes', () => {
  it('counts only what would be copied', () => {
    const source = profile()
    // The two 50 KB caches are in the directory and not in the number.
    expect(profileBytes(source)).toBeLessThan(1000)
    expect(profileBytes(source)).toBeGreaterThan(0)
  })

  it('is zero for a directory that is not a profile', () => {
    expect(profileBytes(dir())).toBe(0)
  })
})
