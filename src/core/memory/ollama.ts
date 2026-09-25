import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync, type Dirent } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import * as nodeZlib from 'node:zlib'
import { humanSize } from '../../util/format.js'

/**
 * Milo's own embedding engine, fetched and run without root.
 *
 * The obvious route — the installer script Ollama publishes, or the distribution
 * package — is the wrong one, for the same reason the browser is not installed
 * that way: it needs sudo, it creates a system user, it writes a systemd unit,
 * and on a machine with a GPU it installs drivers and kernel headers. None of
 * that is something a settings screen may do on someone's behalf.
 *
 * What it does instead is what Chrome for Testing does: take the plain archive
 * from the release, keep it under Milo's own directory, and run it as a child
 * process on a private port. Nothing outside `~/.milo` changes.
 */

export type InstallProgress = (line: string) => void

export interface InstalledEngine {
  binary: string
  version: string
}

export interface Asset {
  name: string
  browser_download_url: string
  size: number
  digest?: string
}

interface Release {
  tag_name?: string
  assets?: Asset[]
}

const DEFAULT_API = 'https://api.github.com'
const RELEASE_PATH = '/repos/ollama/ollama/releases/latest'

/** The archive this machine needs, or null when the release has none for it. */
export function engineAsset(
  platform: NodeJS.Platform,
  arch: string,
  assets: Asset[],
): Asset | null {
  const named = (want: string): Asset | null => assets.find((asset) => asset.name === want) ?? null

  if (platform === 'linux') {
    return named(`ollama-linux-${arch === 'arm64' ? 'arm64' : 'amd64'}.tar.zst`)
  }
  if (platform === 'darwin') return named('ollama-darwin.tgz')
  if (platform === 'win32') {
    return named(`ollama-windows-${arch === 'arm64' ? 'arm64' : 'amd64'}.zip`)
  }
  return null
}

/**
 * Downloads and unpacks the engine into `dir`, and hands back its binary.
 *
 * Cheap to run again: an install already at the current release is left alone,
 * so a screen can offer this without checking first.
 */
export async function installEngine(options: {
  dir: string
  platform?: NodeJS.Platform
  arch?: string
  apiBase?: string
  onProgress?: InstallProgress
  signal?: AbortSignal
}): Promise<InstalledEngine> {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const report = options.onProgress ?? (() => undefined)
  const api = options.apiBase ?? DEFAULT_API

  report('looking up the current engine release')
  const release = await get<Release>(`${api}${RELEASE_PATH}`, options.signal)
  const version = release.tag_name
  const asset = engineAsset(platform, arch, release.assets ?? [])
  if (!version || !asset) {
    throw new Error(
      `there is no engine build for ${platform}/${arch} in ${version ?? 'the latest release'}`,
    )
  }

  await mkdir(options.dir, { recursive: true })
  const installed = await readMarker(options.dir)
  if (installed?.version === version && installed.binary && existsSync(installed.binary)) {
    report(`already installed: ${version}`)
    return { binary: installed.binary, version }
  }

  const archive = path.join(options.dir, asset.name)
  report(`downloading ${asset.name} (${humanSize(asset.size)})`)
  await download(asset, archive, report, options.signal)

  report('unpacking')
  await extract(archive, options.dir)
  await rm(archive, { force: true })

  const binary = await findBinary(options.dir, platform)
  if (!binary) throw new Error('the archive did not contain the engine where it was expected')
  if (platform !== 'win32') await chmod(binary, 0o755)

  await writeFile(
    path.join(options.dir, 'engine.json'),
    `${JSON.stringify({ version, asset: asset.name, binary }, null, 2)}\n`,
  )
  report(`ready: ${version}`)
  return { binary, version }
}

async function readMarker(dir: string): Promise<{ version?: string; binary?: string } | null> {
  try {
    return JSON.parse(await readFile(path.join(dir, 'engine.json'), 'utf8')) as {
      version?: string
      binary?: string
    }
  } catch {
    return null
  }
}

/**
 * The engine Milo installed for itself, if it did.
 *
 * Null is the ordinary answer on an install that never turned embeddings on, and
 * on one pointed at an Ollama the person runs: an engine Milo did not fetch is
 * not one it may start on a port of its own choosing.
 */
export async function installedEngine(dir: string): Promise<InstalledEngine | null> {
  const marker = await readMarker(dir)
  if (!marker?.version || !marker.binary || !existsSync(marker.binary)) return null
  return { binary: marker.binary, version: marker.version }
}

/**
 * The engine binary in an unpacked archive, whatever layout it came in.
 *
 * Searched rather than assumed: the Linux archive carries it under `bin/`, and
 * the macOS one at the root, and neither is a promise to rely on release after
 * release. The walk is shallow and stops at the first match.
 */
async function findBinary(dir: string, platform: NodeJS.Platform): Promise<string | null> {
  const wanted = platform === 'win32' ? 'ollama.exe' : 'ollama'
  const queue = ['']

  while (queue.length > 0) {
    const relative = queue.shift()!
    if (relative.split(path.sep).length > 3) continue

    let entries: Dirent[]
    try {
      entries = await readdir(path.join(dir, relative), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const inside = path.join(relative, entry.name)
      if (entry.isFile() && entry.name === wanted) return path.join(dir, inside)
      if (entry.isDirectory()) queue.push(inside)
    }
  }
  return null
}

async function get<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(20_000)])
      : AbortSignal.timeout(20_000),
    headers: { accept: 'application/json', 'user-agent': 'milo' },
  })
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  return (await response.json()) as T
}

/**
 * Fetches the archive and holds it against the digest the release publishes.
 *
 * The bytes are hashed as they arrive and the file is written only once
 * everything checks out: a truncated download, a captive portal answering 200,
 * or a kill mid-stream must all leave nothing behind, because a file that exists
 * is a file the rest of Milo treats as installed.
 */
async function download(
  asset: Asset,
  file: string,
  report: InstallProgress,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(asset.browser_download_url, { signal, redirect: 'follow' })
  if (!response.ok) throw new Error(`the download answered ${response.status}`)
  if (!response.body) throw new Error('the download came back empty')

  const expected = asset.digest?.replace(/^sha256:/, '')
  const hash = createHash('sha256')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let announced = 0

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    hash.update(value)
    total += value.byteLength
    // Every 100 MB: this is over a gigabyte, and the count is the only sign of
    // life the person gets while it downloads.
    if (total - announced >= 100 * 1024 * 1024) {
      announced = total
      report(`downloading the engine — ${humanSize(total)} of ${humanSize(asset.size)}`)
    }
  }

  if (total !== asset.size) {
    throw new Error(`the download was ${humanSize(total)}, not the ${humanSize(asset.size)} published`)
  }
  if (expected && hash.digest('hex') !== expected) {
    throw new Error('the download did not match the digest the release published')
  }

  await writeFile(file, Buffer.concat(chunks), { mode: 0o600 })
}

/**
 * Unpacks an archive into `dir`.
 *
 * Decompression happens in this process where Node can do it — zstd since Node
 * 22.15, gzip always — and through the tool otherwise, which is what the oldest
 * Node this project supports needs. The tar itself is left to `tar`, which every
 * platform Milo runs on already has and which is the one piece not worth
 * reimplementing.
 */
async function extract(archive: string, dir: string): Promise<void> {
  if (archive.endsWith('.zip')) {
    await run('tar', ['-xf', archive, '-C', dir])
    return
  }

  const packed = await readFile(archive)
  const tar = archive.endsWith('.tar.zst')
    ? await decompressZstd(packed)
    : await gunzip(packed)

  const temporary = `${archive}.tar`
  await writeFile(temporary, tar, { mode: 0o600 })
  try {
    await run('tar', ['-xf', temporary, '-C', dir])
  } finally {
    await rm(temporary, { force: true })
  }
}

type ZstdDecompressor = (
  input: Buffer,
  done: (error: Error | null, output: Buffer) => void,
) => void

/** Node 22.15 and later have this; 22.13, this project's floor, does not. */
function decompressZstd(data: Buffer): Promise<Buffer> {
  const zstd = (nodeZlib as unknown as { zstdDecompress?: ZstdDecompressor }).zstdDecompress
  if (!zstd) return captured('zstd', ['-d', '-c'], data)
  return new Promise((resolve, reject) => {
    zstd(data, (error, output) => (error ? reject(error) : resolve(output)))
  })
}

function gunzip(data: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeZlib.gunzip(data, (error, output) => (error ? reject(error) : resolve(output)))
  })
}

/** Runs a command and fails with what it said, so a screen can report it. */
function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.once('error', () => reject(new Error(`could not run \`${command}\`: ${stderr.trim()}`)))
    child.once('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} failed: ${stderr.trim() || `exit ${code}`}`))
    })
  })
}

function captured(command: string, args: string[], input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.once('error', () => reject(new Error(`could not run \`${command}\`: ${stderr.trim()}`)))
    child.once('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out))
      else reject(new Error(`${command} failed: ${stderr.trim() || `exit ${code}`}`))
    })
    child.stdin?.end(input)
  })
}

/** A port nothing is listening on, so Milo's engine does not fight another. */
export async function freePort(from = 11435, to = 11445): Promise<number> {
  for (let port = from; port <= to; port += 1) {
    const free = await new Promise<boolean>((resolve) => {
      const probe = createServer()
      probe.once('error', () => resolve(false))
      probe.once('listening', () => probe.close(() => resolve(true)))
      probe.listen(port, '127.0.0.1')
    })
    if (free) return port
  }
  throw new Error(`no free port between ${from} and ${to} for the engine`)
}

export interface Engine {
  url: string
  stop(): void
}

/**
 * Runs the engine as a child of this process, on a private port, with its models
 * under Milo's own directory — so `ollama list` in a terminal shows nothing of
 * Milo's, and Milo shows nothing of anyone else's.
 */
export async function startEngine(options: {
  binary: string
  modelsDir: string
  port: number
  onProgress?: InstallProgress
  timeoutMs?: number
}): Promise<Engine> {
  const report = options.onProgress ?? (() => undefined)
  const url = `http://127.0.0.1:${options.port}`

  const child = spawn(options.binary, ['serve'], {
    env: {
      ...process.env,
      OLLAMA_HOST: `127.0.0.1:${options.port}`,
      OLLAMA_MODELS: options.modelsDir,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  const stop = () => {
    if (child.exitCode === null && !child.killed) child.kill('SIGTERM')
  }

  report('starting the engine')
  const deadline = Date.now() + (options.timeoutMs ?? 30_000)
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`the engine stopped as soon as it started (exit ${child.exitCode})`)
    }
    try {
      const response = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(1_500) })
      if (response.ok) return { url, stop }
    } catch {
      // Not up yet: the first start also reads its model directory.
    }
    if (Date.now() > deadline) {
      stop()
      throw new Error('the engine did not answer in time')
    }
    await delay(250)
  }
}

/**
 * Asks the engine for a model, reporting how far it has got.
 *
 * Pulled through the engine rather than fetched as a blob, because the engine
 * owns the layout of its model directory and would not recognise a file put
 * there by hand.
 */
export async function pullModel(options: {
  url: string
  model: string
  onProgress?: InstallProgress
  signal?: AbortSignal
}): Promise<void> {
  const report = options.onProgress ?? (() => undefined)
  const response = await fetch(`${options.url}/api/pull`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: options.model, stream: true }),
    signal: options.signal,
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(
      `pulling ${options.model} answered ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
    )
  }
  if (!response.body) throw new Error('the pull came back empty')

  const decoder = new TextDecoder()
  const reader = response.body.getReader()
  let buffered = ''
  let said = ''
  let announced = 0

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffered += decoder.decode(value, { stream: true })
    const lines = buffered.split('\n')
    buffered = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.trim()) continue
      const event = JSON.parse(line) as {
        status?: string
        error?: string
        total?: number
        completed?: number
      }
      if (event.error) throw new Error(`pulling ${options.model}: ${event.error}`)

      const status = event.status ?? ''
      if (event.total && event.completed) {
        const percent = Math.floor((event.completed / event.total) * 100)
        // Every 10%: enough to show life, not enough to flood a screen.
        if (percent >= announced + 10) {
          announced = percent
          report(`${status} — ${percent}%`)
        }
      } else if (status && status !== said) {
        said = status
        report(status)
      }
    }
  }
}

/** Whether something is already answering where embeddings are configured. */
export async function engineAnswers(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url.replace(/\/+$/, '')}/api/tags`, {
      signal: AbortSignal.timeout(2_000),
    })
    return response.ok
  } catch {
    return false
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
