import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultProfileRoots, isDefaultProfile, launchChrome, listBrowsers } from '../src/core/browser/chrome.js'

/**
 * Finding browsers, against a `PATH` and a home of the test's own. A machine's
 * real browsers must not decide whether these pass — the assertions are about
 * preference, executability and de-duplication, all of which hold anywhere.
 */
const roots: string[] = []

function dir(): string {
  const made = mkdtempSync(path.join(tmpdir(), 'milo-browsers-'))
  roots.push(made)
  return made
}

/** A file that looks like a binary: present, and something you could run. */
function binary(where: string, name: string): string {
  const file = path.join(where, name)
  writeFileSync(file, '#!/bin/sh\n')
  chmodSync(file, 0o755)
  return file
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('listBrowsers', () => {
  it('finds what is on PATH, and prefers Chromium over the forks', async () => {
    const bin = dir()
    binary(bin, 'brave-browser')
    binary(bin, 'chromium')

    const found = await listBrowsers({ pathEnv: bin, home: dir() })
    const ids = found.map((entry) => entry.id)
    expect(ids).toContain('chromium')
    expect(ids).toContain('brave')
    expect(ids.indexOf('chromium')).toBeLessThan(ids.indexOf('brave'))
    expect(found.find((entry) => entry.id === 'chromium')?.path).toBe(path.join(bin, 'chromium'))
  })

  it('names the browser, not just the path', async () => {
    const bin = dir()
    binary(bin, 'chromium')
    const found = await listBrowsers({ pathEnv: bin, home: dir() })
    expect(found.find((entry) => entry.id === 'chromium')?.name).toBe('Chromium')
  })

  it('skips a file that is not executable', async () => {
    const bin = dir()
    const file = path.join(bin, 'google-chrome')
    writeFileSync(file, 'not a binary')
    chmodSync(file, 0o644)

    const found = await listBrowsers({ pathEnv: bin, home: dir() })
    // About *this* file, not about the browser: the discovery also looks in the
    // places a distro installs one, and a machine that has a real Chrome there
    // would answer `google-chrome` no matter what this directory holds. Asserting
    // by id made the test pass here and fail on a CI runner that ships Chrome.
    expect(found.map((entry) => entry.path)).not.toContain(file)
  })

  it('counts one browser reached twice as one browser', async () => {
    // The shape of a distro install: several names in one directory, one binary.
    const real = dir()
    const bin = dir()
    binary(real, 'chromium')
    symlinkSync(path.join(real, 'chromium'), path.join(bin, 'chromium'))
    symlinkSync(path.join(real, 'chromium'), path.join(bin, 'chromium-browser'))

    const found = await listBrowsers({ pathEnv: bin, home: dir() })
    const chromium = found.filter((entry) => entry.id === 'chromium')
    expect(chromium).toHaveLength(1)
    expect(chromium[0]?.path).toBe(path.join(bin, 'chromium'))
  })
})

describe('launchChrome', () => {
  it('reports a browser it cannot start instead of crashing the process', async () => {
    // A path that exists in no directory: `spawn` answers with an `error` event,
    // not an exit, and an unlistened one is an uncaught exception.
    const profile = path.join(dir(), 'profile')
    await expect(
      launchChrome({ chromePath: path.join(dir(), 'no-such-chromium'), profileDir: profile, headless: true }),
    ).rejects.toThrow(/could not start/)
  })
})

describe('isDefaultProfile', () => {
  const home = '/home/someone'

  it('catches the profile a browser refuses to be debugged on', () => {
    for (const dir of ['/home/someone/.config/google-chrome', '/home/someone/.config/chromium']) {
      expect(isDefaultProfile(dir, home, 'linux')).toBe(true)
    }
  })

  it('catches a directory inside one, which is just as refused', () => {
    expect(isDefaultProfile('/home/someone/.config/google-chrome/Default', home, 'linux')).toBe(true)
    expect(isDefaultProfile('/home/someone/.config/BraveSoftware/Brave-Browser', home, 'linux')).toBe(true)
  })

  it('leaves a copy alone — the whole point of copying it', () => {
    expect(isDefaultProfile('/home/someone/chrome-copy', home, 'linux')).toBe(false)
    expect(isDefaultProfile('/home/someone/.config/google-chrome-copy', home, 'linux')).toBe(false)
    expect(isDefaultProfile(path.join(home, '.milo', 'browser', 'profile'), home, 'linux')).toBe(false)
  })

  it('knows where the profiles live on the other platforms', () => {
    expect(isDefaultProfile('/Users/someone/Library/Application Support/Google/Chrome', '/Users/someone', 'darwin')).toBe(
      true,
    )
    expect(defaultProfileRoots('/home/someone', 'linux')).toContain(
      path.join('/home/someone', '.config', 'chromium'),
    )
    expect(defaultProfileRoots('/home/someone', 'win32').some((root) => root.endsWith('User Data'))).toBe(true)
  })
})
