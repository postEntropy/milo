import { existsSync, readdirSync, statSync } from 'node:fs'
import { chmod, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ensurePrivateDir, PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from '../../util/fs.js'
import { listBrowsers, type FoundBrowser } from './chrome.js'

/**
 * Copying a browser profile, so Milo can be signed in where the person already
 * is.
 *
 * A profile cannot be shared with a browser that is already open on it, and the
 * browser refuses to be debugged on its own default directory at all — so
 * "point Milo at my profile" does not work. A copy does, and this is what makes
 * one: the files that carry a sign-in, and not the caches, which are most of a
 * profile and none of a login.
 */

/**
 * What carries a sign-in. A profile is mostly caches — on the machine this was
 * written on, 334 MB of a 564 MB profile was `Service Worker`, which a browser
 * rebuilds for free — so copying the whole directory is slow and pointless.
 *
 * `Cookies` is where a session lives; `Local State` holds what it takes to
 * decrypt them on this machine; `Local Storage` and `IndexedDB` are where the
 * single-page apps that do not use cookies keep their tokens, and finding out
 * which ones those are at the wrong moment is expensive.
 */
const ROOT_FILES = ['Local State']
const PROFILE_PARTS = [
  'Cookies',
  'Cookies-journal',
  'Cookies-wal',
  'Cookies-shm',
  'Preferences',
  'Secure Preferences',
  'Local Storage',
  'Session Storage',
  'IndexedDB',
]

export interface ProfileSource {
  /** The browser this profile belongs to, as `listBrowsers` names it. */
  id: string
  name: string
  /** The directory a browser runs on by default. */
  dir: string
  /** How much of it is worth copying. Not the whole directory. */
  bytes: number
  /** Its cookie store, when it has one: the thing a sign-in actually lives in. */
  cookieStore: CookieStore | null
}

export interface CookieStore {
  bytes: number
  /** When a browser last wrote it. A store nobody has touched is a stale profile. */
  at: number
}

/** The personal profiles of the browsers installed here, newest first. */
export async function findProfiles(browsers?: FoundBrowser[]): Promise<ProfileSource[]> {
  const found: ProfileSource[] = []
  for (const browser of browsers ?? (await listBrowsers())) {
    const dir = defaultProfileDir(browser)
    if (!dir || !existsSync(dir) || !existsSync(path.join(dir, 'Default'))) continue
    found.push({
      id: browser.id,
      name: browser.name,
      dir,
      bytes: profileBytes(dir),
      cookieStore: cookieStore(dir),
    })
  }
  return found
}

/** Where a browser of this kind keeps its profile when nobody says otherwise. */
function defaultProfileDir(browser: FoundBrowser): string | null {
  // Derived from the binary's own name rather than a table of its own: a fork
  // that keeps Chrome's layout is found by the same rule as Chrome.
  const roots = profileRootsFor(browser)
  return roots.find((dir) => existsSync(dir)) ?? roots[0] ?? null
}

function profileRootsFor(browser: FoundBrowser): string[] {
  const home = process.env.HOME ?? ''
  const config = path.join(home, '.config')
  const support = path.join(home, 'Library', 'Application Support')
  const local = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local')

  switch (browser.id) {
    case 'google-chrome':
      return [
        path.join(config, 'google-chrome'),
        path.join(support, 'Google', 'Chrome'),
        path.join(local, 'Google', 'Chrome', 'User Data'),
      ]
    case 'chromium':
      return [path.join(config, 'chromium'), path.join(local, 'Chromium', 'User Data')]
    case 'brave':
      return [
        path.join(config, 'BraveSoftware', 'Brave-Browser'),
        path.join(support, 'BraveSoftware', 'Brave-Browser'),
      ]
    case 'helium':
      return [path.join(config, 'net.imput.helium'), path.join(support, 'net.imput.helium')]
    case 'microsoft-edge':
      return [path.join(config, 'microsoft-edge'), path.join(local, 'Microsoft', 'Edge', 'User Data')]
    case 'vivaldi':
      return [path.join(config, 'vivaldi'), path.join(support, 'Vivaldi')]
    case 'opera':
      return [path.join(config, 'opera')]
    default:
      return []
  }
}

/** The profile directories inside a user-data directory: `Default`, `Profile 1`, … */
function profileDirs(dir: string): string[] {
  const named = ['Default']
  try {
    for (const entry of readdirSync(dir)) {
      if (/^Profile \d+$/.test(entry)) named.push(entry)
    }
  } catch {
    // Unreadable is the same as empty here: nothing to copy from it.
  }
  return named.filter((name) => existsSync(path.join(dir, name)))
}

/** How much of the profile is worth copying — the parts, not the whole tree. */
export function profileBytes(dir: string): number {
  let total = 0
  for (const file of ROOT_FILES) total += sizeOf(path.join(dir, file))
  for (const profile of profileDirs(dir)) {
    for (const part of PROFILE_PARTS) total += sizeOf(path.join(dir, profile, part))
  }
  return total
}

function sizeOf(target: string): number {
  let info: ReturnType<typeof statSync>
  try {
    info = statSync(target)
  } catch {
    return 0
  }
  if (info.isFile()) return info.size
  if (!info.isDirectory()) return 0

  let total = 0
  let entries: string[]
  try {
    entries = readdirSync(target)
  } catch {
    return 0
  }
  for (const entry of entries) total += sizeOf(path.join(target, entry))
  return total
}

/**
 * The cookie store, as a size and a time rather than a count.
 *
 * Counting the cookies means reading SQLite, and the shortcut that looks like it
 * works — the big-endian number at offset 28 of the file's header — is the
 * database's size **in pages**. That is a wrong answer shaped exactly like a
 * right one, and it was on this screen for an afternoon before anyone compared
 * it with a real count. What the header honestly gives is that there *is* a
 * store, how big it is, and when a browser last wrote it: a profile with a real
 * cookie database, touched recently, is one that is signed in somewhere.
 */
function cookieStore(dir: string): CookieStore | null {
  for (const profile of profileDirs(dir)) {
    const file = path.join(dir, profile, 'Cookies')
    if (!existsSync(file)) continue
    try {
      const info = statSync(file)
      return { bytes: info.size, at: info.mtimeMs }
    } catch {
      return null
    }
  }
  return null
}

export interface ProfileOrigin {
  /** The directory it was copied from. */
  from: string
  /** What that browser is called, when the copy recorded it. */
  label?: string
  at: string
}

export interface CopyResult {
  dir: string
  bytes: number
  parts: number
}

/**
 * Copies the parts of `source` that carry a sign-in into `target`, replacing
 * whatever was there. Returns what landed, for a screen that has to say
 * something more useful than "done".
 */
export async function copyProfile(
  source: string,
  target: string,
  options: { onProgress?: (line: string) => void; label?: string } = {},
): Promise<CopyResult> {
  const report = options.onProgress ?? (() => undefined)
  let bytes = 0
  let parts = 0

  // From scratch: a leftover cookie database next to a fresh one is two
  // versions of the same site, and which one wins is not ours to decide.
  await rm(target, { recursive: true, force: true })
  ensurePrivateDir(target)

  for (const file of ROOT_FILES) {
    const from = path.join(source, file)
    if (!existsSync(from)) continue
    report(`copying ${file}`)
    await cp(from, path.join(target, file), { recursive: true })
    bytes += sizeOf(from)
    parts += 1
  }

  for (const profile of profileDirs(source)) {
    for (const part of PROFILE_PARTS) {
      const from = path.join(source, profile, part)
      if (!existsSync(from)) continue
      report(`copying ${profile}/${part}`)
      const to = path.join(target, profile, part)
      await mkdir(path.dirname(to), { recursive: true })
      await cp(from, to, { recursive: true })
      bytes += sizeOf(from)
      parts += 1
    }
  }

  if (parts === 0) {
    throw new Error(`${source} has nothing in it to copy — is that really a browser profile?`)
  }

  // `cp` copies the source's modes, and a profile that was loose-handed stays
  // loose-handed in a copy that holds the person's session cookies.
  await tighten(target)

  // So the screen can say where the logins came from, and when — a copy goes
  // stale, and the honest thing to show is the date it was taken.
  //
  // The label is the browser's own name, because the directory it came from is
  // called `net.imput.helium` and nobody calls their browser that.
  await writeFile(
    path.join(target, '.milo-profile.json'),
    `${JSON.stringify({ from: source, label: options.label, at: new Date().toISOString() }, null, 2)}\n`,
    { mode: 0o600 },
  )
  report(`copied ${parts} part(s), ${Math.round(bytes / 1_048_576)} MB`)
  return { dir: target, bytes, parts }
}

async function tighten(dir: string): Promise<void> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await chmod(target, PRIVATE_DIR_MODE)
      await tighten(target)
    } else if (entry.isFile()) {
      await chmod(target, PRIVATE_FILE_MODE)
    }
  }
}

/** Where a copied profile came from, when it was one of ours. */
export async function readProfileOrigin(dir: string): Promise<ProfileOrigin | null> {
  try {
    const parsed = JSON.parse(await readFile(path.join(dir, '.milo-profile.json'), 'utf8'))
    return typeof parsed?.from === 'string' && typeof parsed?.at === 'string'
      ? {
          from: parsed.from,
          label: typeof parsed.label === 'string' ? parsed.label : undefined,
          at: parsed.at,
        }
      : null
  } catch {
    // No marker is the normal case for a profile that was never copied.
    return null
  }
}
