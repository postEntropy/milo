import { spawn } from 'node:child_process'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { errorMessage } from '../../util/errors.js'
import { humanSize } from '../../util/format.js'

/**
 * Getting a browser without asking anyone for a password.
 *
 * The distro's package manager is the obvious route and the wrong one: it needs
 * sudo, its package is named differently on every distribution, and none of that
 * is something a settings screen can do on someone's behalf. Chrome for Testing
 * is the build Google publishes for exactly this purpose — a plain archive, no
 * installer, no root — and it is the one route that works the same on every
 * platform Milo runs on.
 */

const INDEX_URL =
  'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json'

interface Index {
  channels?: {
    Stable?: {
      version?: string
      downloads?: { chrome?: { platform?: string; url?: string }[] }
    }
  }
}

/** Where the install has got to, for a screen that has to say something. */
export type InstallProgress = (line: string) => void

export interface InstalledBrowser {
  path: string
  version: string
}

/** The platform name Google uses for this machine. There is no Linux ARM build. */
function platformKey(platform: NodeJS.Platform, arch: string): string | null {
  if (platform === 'linux') return 'linux64'
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-arm64' : 'mac-x64'
  if (platform === 'win32') return 'win64'
  return null
}

/** Where the binary sits inside the archive, once extracted. */
function binaryInside(key: string): string {
  if (key === 'win64') return path.join('chrome-win64', 'chrome.exe')
  if (key.startsWith('mac')) {
    return path.join(
      `chrome-${key}`,
      'Google Chrome for Testing.app',
      'Contents',
      'MacOS',
      'Google Chrome for Testing',
    )
  }
  return path.join('chrome-linux64', 'chrome')
}

/**
 * Downloads a Chrome for Testing build into `destDir` and hands back the binary.
 * Nothing here needs root, and nothing is installed system-wide: the browser
 * belongs to Milo's own directory like its config does.
 */
export async function installChromeForTesting(options: {
  destDir: string
  platform?: NodeJS.Platform
  arch?: string
  onProgress?: InstallProgress
  signal?: AbortSignal
}): Promise<InstalledBrowser> {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const key = platformKey(platform, arch)
  const report = options.onProgress ?? (() => undefined)
  if (!key) throw new Error(`there is no Chrome for Testing build for ${platform}/${arch}`)

  report('looking up the current stable version')
  const index = await get<Index>(INDEX_URL, options.signal)
  const stable = index.channels?.Stable
  const version = stable?.version
  const url = stable?.downloads?.chrome?.find((entry) => entry.platform === key)?.url
  if (!version || !url) throw new Error('Google did not list a download for this platform')

  await mkdir(options.destDir, { recursive: true })
  const archive = path.join(options.destDir, `chrome-${version}.zip`)

  report(`downloading Chrome ${version} (${key})`)
  const bytes = await download(url, archive, report, options.signal)

  report(`extracting ${Math.round(bytes / 1_048_576)} MB`)
  await extract(archive, options.destDir)

  const binary = path.join(options.destDir, binaryInside(key))
  if (!existsSync(binary)) {
    throw new Error('the archive did not contain the browser where it was expected')
  }
  if (platform !== 'win32') await chmod(binary, 0o755)

  await rm(archive, { force: true })
  report(`ready: Chrome ${version}`)
  return { path: binary, version }
}

/** The version a browser binary reports, or null when it will not say. */
export function chromeVersion(binary: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(binary, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    const done = (value: string | null) => resolve(value)
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString()
    })
    child.once('error', () => done(null))
    child.once('close', () => {
      const match = out.match(/(\d+[\d.]+)/)
      done(match ? match[1]! : null)
    })
    setTimeout(() => {
      child.kill('SIGKILL')
      done(out.match(/(\d+[\d.]+)/)?.[1] ?? null)
    }, 3_000).unref()
  })
}

async function get<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
    headers: { accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  return (await response.json()) as T
}

/**
 * Fetches one artifact to disk.
 *
 * Nothing is written until the whole body has been read and is at least
 * `minimumBytes`, because a file that exists is a file the rest of Milo will
 * treat as installed — so `network down`, a captive portal answering 200 with
 * twelve bytes, or a kill mid-stream must all leave no file at all, and the
 * failure has to happen here rather than at launch.
 */
async function download(
  url: string,
  file: string,
  report: InstallProgress,
  signal?: AbortSignal,
  minimumBytes = 1,
): Promise<number> {
  const response = await fetch(url, { signal, redirect: 'follow' })
  if (!response.ok) throw new Error(`the download answered ${response.status}`)
  if (!response.body) throw new Error('the download came back empty')

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let announced = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.byteLength
    // Every 10 MB, so the wait says something without becoming a log.
    if (total - announced >= 10_485_760) {
      announced = total
      report(`downloading Chrome — ${Math.round(total / 1_048_576)} MB`)
    }
  }
  if (total < minimumBytes) {
    throw new Error(`the download was only ${humanSize(total)} — too small to be what was asked for`)
  }

  await writeFile(file, Buffer.concat(chunks), { mode: 0o755 })
  return total
}

/** `unzip` is on every macOS and nearly every Linux; there is no Node builtin. */
function extract(archive: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('unzip', ['-q', '-o', archive, '-d', destDir], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.once('error', () =>
      reject(new Error('could not run `unzip` — install it, or download Chrome yourself and set browser.chromePath')),
    )
    child.once('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`unzip failed: ${stderr.trim() || `exit ${code}`}`))
    })
  })
}

/** Best effort, for a settings screen that would rather say why than nothing. */
export async function tryInstall(destDir: string, report: InstallProgress): Promise<InstalledBrowser | null> {
  try {
    return await installChromeForTesting({ destDir, onProgress: report })
  } catch (error) {
    report(`could not install: ${errorMessage(error)}`)
    return null
  }
}
