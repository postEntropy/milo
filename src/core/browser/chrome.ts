import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { access, constants } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { errorMessage } from '../../util/errors.js'

/**
 * Finding and starting the browser.
 *
 * Milo launches its own Chrome, on its own profile, with no window. That is not
 * a detail: attaching to the browser someone is actually using means asking them
 * to enable remote debugging in it, and then driving their tabs, their logins and
 * their open work. An instance of our own is thrown away with the process, and
 * the profile under `~/.milo/browser/` is what makes a sign-in survive a restart.
 *
 * Anything that speaks the DevTools protocol will do — every Chromium and its
 * forks. Firefox does not: it speaks WebDriver BiDi, so it would need a driver of
 * its own rather than another line in this table.
 */

/**
 * Every Chromium worth looking for, in the order worth preferring. A bare name is
 * searched on `PATH`; an absolute one is checked as it is. The `id` is what the
 * config and the settings row carry, so it has to stay stable.
 */
interface BrowserCandidate {
  id: string
  name: string
  /** PATH names and absolute paths, in the order to try them. */
  where: string[]
  /** Locations relative to the home directory, checked after `where`. */
  underHome?: string[]
}

const LINUX: BrowserCandidate[] = [
  { id: 'chromium', name: 'Chromium', where: ['chromium', 'chromium-browser', '/usr/lib/chromium/chromium'] },
  {
    id: 'google-chrome',
    name: 'Google Chrome',
    where: ['google-chrome-stable', 'google-chrome', '/opt/google/chrome/chrome'],
  },
  { id: 'brave', name: 'Brave', where: ['brave-browser', 'brave', '/opt/brave-bin/brave'] },
  // Helium is a Chromium fork without an entry of its own anywhere.
  { id: 'helium', name: 'Helium', where: ['helium', 'helium-browser', '/opt/helium-browser-bin/chrome'] },
  {
    id: 'microsoft-edge',
    name: 'Microsoft Edge',
    where: ['microsoft-edge-stable', 'microsoft-edge', '/opt/microsoft/msedge/msedge'],
  },
  { id: 'vivaldi', name: 'Vivaldi', where: ['vivaldi', '/opt/vivaldi/vivaldi'] },
  { id: 'opera', name: 'Opera', where: ['opera'] },
]

const MAC: BrowserCandidate[] = [
  {
    id: 'google-chrome',
    name: 'Google Chrome',
    where: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  },
  { id: 'chromium', name: 'Chromium', where: ['/Applications/Chromium.app/Contents/MacOS/Chromium'] },
  {
    id: 'brave',
    name: 'Brave',
    where: ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
  },
  {
    id: 'microsoft-edge',
    name: 'Microsoft Edge',
    where: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
  },
  { id: 'vivaldi', name: 'Vivaldi', where: ['/Applications/Vivaldi.app/Contents/MacOS/Vivaldi'] },
]

const WINDOWS: BrowserCandidate[] = [
  {
    id: 'google-chrome',
    name: 'Google Chrome',
    where: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'],
    underHome: ['AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'],
  },
  {
    id: 'brave',
    name: 'Brave',
    where: ['C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
  },
  {
    id: 'microsoft-edge',
    name: 'Microsoft Edge',
    where: ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'],
  },
]

export interface BrowserHandle {
  /** The browser-level websocket the whole session rides on. */
  wsUrl: string
}

export interface FoundBrowser {
  /** Stable id: `chromium`, `google-chrome`, `brave`, `helium`, … */
  id: string
  name: string
  /** The absolute path to run. */
  path: string
}

export interface DiscoveryOptions {
  /** A `PATH` to search instead of the environment's. For tests. */
  pathEnv?: string
  /** A home directory to look under instead of this user's. For tests. */
  home?: string
}

/**
 * Every Chromium on this machine, in preference order, without repeats.
 *
 * The platform is the real one: it picks the table and the path separator, and
 * a browser found under a home directory is joined the way the platform joins.
 * Letting a caller claim to be another platform would produce paths that look
 * right and cannot be opened.
 */
export async function listBrowsers(options: DiscoveryOptions = {}): Promise<FoundBrowser[]> {
  const platform = process.platform
  const home = options.home ?? homedir()
  const pathEnv = options.pathEnv ?? process.env.PATH ?? ''
  const table = platform === 'darwin' ? MAC : platform === 'win32' ? WINDOWS : LINUX

  const found: FoundBrowser[] = []
  const seen = new Set<string>()

  for (const candidate of table) {
    const locations = [
      ...candidate.where.map((name) => (path.isAbsolute(name) ? name : onPath(name, pathEnv, platform))),
      ...(candidate.underHome ?? []).map((rel) => path.join(home, rel)),
    ]
    for (const location of locations) {
      if (!location || !(await isExecutable(location))) continue
      // The same browser reached twice — `/usr/bin/chromium` and the real binary
      // it points at — is one browser, not two rows.
      const real = realpath(location, platform)
      if (seen.has(real)) break
      seen.add(real)
      found.push({ id: candidate.id, name: candidate.name, path: location })
      break
    }
  }
  return found
}

/**
 * The browser to run, or null. An explicit path is used as given — and so is the
 * environment's, both of them a deliberate choice by whoever set them.
 */
export async function findChrome(explicit?: string | null): Promise<string | null> {
  for (const named of [explicit?.trim(), process.env.MILO_BROWSER_CHROME?.trim()]) {
    if (named) return (await isExecutable(named)) ? named : null
  }
  const [first] = await listBrowsers()
  return first?.path ?? null
}

/**
 * The profile directories a browser refuses to be debugged on.
 *
 * Chrome 136 and later ignore `--remote-debugging-port` when the data directory
 * is the browser's own default one, and say nothing about it — the port file is
 * simply never written. Pointing a profile somewhere else is the fix, and warning
 * about it here is worth more than the failure it prevents: a silent refusal looks
 * exactly like Milo being broken.
 */
export function defaultProfileRoots(home = homedir(), platform = process.platform): string[] {
  if (platform === 'darwin') {
    const support = path.join(home, 'Library', 'Application Support')
    return [
      path.join(support, 'Google', 'Chrome'),
      path.join(support, 'Chromium'),
      path.join(support, 'BraveSoftware', 'Brave-Browser'),
      path.join(support, 'Microsoft Edge'),
      // Helium is the one people actually run on Omarchy, and it keeps its
      // profile under its own reverse-DNS name.
      path.join(support, 'net.imput.helium'),
      path.join(support, 'Vivaldi'),
    ]
  }
  if (platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local')
    return [
      path.join(local, 'Google', 'Chrome', 'User Data'),
      path.join(local, 'Chromium', 'User Data'),
      path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data'),
      path.join(local, 'Microsoft', 'Edge', 'User Data'),
      path.join(local, 'net.imput.helium', 'User Data'),
      path.join(local, 'Vivaldi', 'User Data'),
    ]
  }
  const config = path.join(home, '.config')
  return [
    path.join(config, 'google-chrome'),
    path.join(config, 'chromium'),
    path.join(config, 'BraveSoftware'),
    path.join(config, 'microsoft-edge'),
    path.join(config, 'net.imput.helium'),
    path.join(config, 'vivaldi'),
    path.join(config, 'opera'),
  ]
}

/** Whether a profile path is one the browser will refuse to be debugged on. */
export function isDefaultProfile(dir: string, home = homedir(), platform = process.platform): boolean {
  const resolved = path.resolve(dir)
  return defaultProfileRoots(home, platform).some(
    (root) => resolved === root || resolved.startsWith(`${root}${path.sep}`),
  )
}

function realpath(file: string, platform: NodeJS.Platform): string {
  try {
    return realpathSync.native(file)
  } catch {
    return platform === 'win32' ? file.toLowerCase() : file
  }
}

/**
 * Deletes the port file a previous browser left behind.
 *
 * A file from a browser that has died is indistinguishable, to the code below,
 * from one a live browser just wrote — so reading it sends the socket at a port
 * nobody is listening on. Every first `browser_open` of a fresh `milo` failed
 * with `ECONNREFUSED` because of exactly this, and the retry worked because by
 * then Chrome had rewritten the file.
 */
export function clearActivePort(profileDir: string): void {
  rmSync(path.join(profileDir, 'DevToolsActivePort'), { force: true })
}

/** Starts a browser of our own and waits until it is actually listening. */
export async function launchChrome(options: {
  chromePath: string
  profileDir: string
  headless: boolean
  signal?: AbortSignal
  /** How long to wait for `DevToolsActivePort` — a cold Chrome is not instant. */
  timeoutMs?: number
}): Promise<{ handle: BrowserHandle; stop: () => void }> {
  mkdirSync(options.profileDir, { recursive: true })
  // Before the spawn, not after: everything the loop below reads must have been
  // written by the browser it just started.
  clearActivePort(options.profileDir)
  const portFile = path.join(options.profileDir, 'DevToolsActivePort')

  const child = spawn(
    options.chromePath,
    [
      ...(options.headless ? ['--headless=new'] : []),
      // Port 0 hands the choice to the OS: a fixed port collides with a second
      // Milo, and with whatever else on the machine already took it.
      '--remote-debugging-port=0',
      `--user-data-dir=${options.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=Translate,MediaRouter,OptimizationHints',
      '--disable-sync',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--mute-audio',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )

  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-2_000)
  })

  // A spawn that fails — the binary gone or not executable between the search and
  // here — reports it as an 'error' event rather than an exit. With no listener
  // that is an uncaught exception, and it takes the whole process down with it.
  let spawnError: Error | null = null
  child.on('error', (error) => {
    spawnError = error
  })

  const stop = () => {
    if (!child.killed && child.exitCode === null) child.kill('SIGKILL')
  }

  const deadline = Date.now() + (options.timeoutMs ?? 15_000)
  while (Date.now() < deadline) {
    if (options.signal?.aborted) {
      stop()
      throw new Error('cancelled')
    }
    if (spawnError) {
      stop()
      throw new Error(`could not start ${options.chromePath}: ${errorMessage(spawnError)}`)
    }
    if (child.exitCode !== null) {
      stop()
      throw new Error(
        `the browser exited immediately (code ${child.exitCode})${stderr.trim() ? `: ${stderr.trim().split('\n').pop()}` : ''}`,
      )
    }
    // Two lines: the port it chose, then the path of the websocket. Reading it
    // is the only reliable way in — Chrome stopped printing the port anywhere a
    // caller can parse once it started picking one itself.
    const port = readActivePort(portFile)
    if (port) {
      return { handle: { wsUrl: `ws://127.0.0.1:${port.port}${port.path}` }, stop }
    }
    await sleep(50)
  }

  stop()
  throw new Error(`the browser did not start within ${Math.round((options.timeoutMs ?? 15_000) / 1000)}s at ${options.profileDir}`)
}

/**
 * The websocket of a browser that is already running, named by the caller. The
 * second line of `DevToolsActivePort` is optional there, so an `http://host:port`
 * (or a bare `host:port`) is resolved through `/json/version` instead.
 */
export async function attachUrl(target: string, timeoutMs = 5_000): Promise<string> {
  const value = target.trim()
  if (value.startsWith('ws://') || value.startsWith('wss://')) return value

  const base = /^https?:\/\//.test(value) ? value : `http://${value}`
  const signal = AbortSignal.timeout(timeoutMs)
  let response: Response
  try {
    response = await fetch(`${base.replace(/\/$/, '')}/json/version`, { signal })
  } catch (error) {
    return Promise.reject(new Error(`could not reach a browser at ${target}: ${errorMessage(error)}`))
  }
  const body = (await response.json()) as { webSocketDebuggerUrl?: string }
  if (!body.webSocketDebuggerUrl) {
    return Promise.reject(new Error(`no browser websocket at ${target}`))
  }
  return body.webSocketDebuggerUrl
}

/** The port and path Chrome wrote, or null while the file is absent or partial. */
function readActivePort(file: string): { port: number; path: string } | null {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const [portLine, pathLine] = text.split('\n')
  const port = Number.parseInt((portLine ?? '').trim(), 10)
  const wsPath = (pathLine ?? '').trim()
  if (!Number.isFinite(port) || port <= 0 || !wsPath) return null
  return { port, path: wsPath }
}

async function isExecutable(file: string): Promise<boolean> {
  if (!existsSync(file)) return false
  try {
    await access(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Walks `PATH` looking for a binary name, trying the `.exe` names on Windows. */
function onPath(name: string, pathEnv: string, platform: NodeJS.Platform): string | null {
  const names = platform === 'win32' && !name.endsWith('.exe') ? [name, `${name}.exe`] : [name]
  const separator = platform === 'win32' ? ';' : path.delimiter
  for (const dir of pathEnv.split(separator)) {
    if (!dir) continue
    for (const candidate of names) {
      const file = path.join(dir, candidate)
      if (existsSync(file)) return file
    }
  }
  return null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
