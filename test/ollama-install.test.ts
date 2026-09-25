import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as nodeZlib from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import {
  engineAnswers,
  engineAsset,
  freePort,
  installEngine,
  pullModel,
} from '../src/core/memory/ollama.js'
import { provisionEmbedding } from '../src/core/memory/provision.js'

let open: Server | null = null

afterEach(() => {
  open?.close()
  open = null
})

/** Node 22.15 and later; the CI floor is 22.13, where these tests are skipped. */
const zstdCompress = (
  nodeZlib as unknown as {
    zstdCompress?: (input: Buffer, done: (error: Error | null, out: Buffer) => void) => void
  }
).zstdCompress

const hasZstd = typeof zstdCompress === 'function'

function compressZstd(data: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zstdCompress!(data, (error, out) => (error ? reject(error) : resolve(out)))
  })
}

/** A tar with one file in it: a 512-byte header, the bytes, and the end blocks. */
function tarOf(name: string, content: string): Buffer {
  const body = Buffer.from(content)
  const header = Buffer.alloc(512)
  header.write(name, 0, 'utf8')
  header.write('0000644\0', 100, 'ascii')
  header.write('0000000\0', 108, 'ascii')
  header.write('0000000\0', 116, 'ascii')
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii')
  header.write('00000000000\0', 136, 'ascii')
  header.write('        ', 148, 'ascii')
  header.write('0', 156, 'ascii')
  header.write('ustar\0', 257, 'ascii')
  header.write('00', 263, 'ascii')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')

  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512)
  body.copy(padded)
  return Buffer.concat([header, padded, Buffer.alloc(1024)])
}

/** A stand-in for the release API and its asset, on one port. */
async function releaseServer(options: {
  bytes: Buffer
  name: string
  digest?: string
  declaredSize?: number
}): Promise<string> {
  let port = 0
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/repos/')) {
      const asset = {
        name: options.name,
        browser_download_url: `http://127.0.0.1:${port}/asset`,
        size: options.declaredSize ?? options.bytes.length,
        ...(options.digest ? { digest: options.digest } : {}),
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ tag_name: 'v9.9.9', assets: [asset] }))
      return
    }
    if (request.url === '/asset') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.end(options.bytes)
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end('{}')
  })

  open = server
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  port = typeof address === 'object' && address ? address.port : 0
  return `http://127.0.0.1:${port}`
}

const tempDir = () => mkdtempSync(path.join(tmpdir(), 'milo-engine-'))

describe('the engine archive for this machine', () => {
  const assets = [
    { name: 'ollama-linux-amd64.tar.zst', browser_download_url: '', size: 1 },
    { name: 'ollama-linux-arm64.tar.zst', browser_download_url: '', size: 1 },
    { name: 'ollama-darwin.tgz', browser_download_url: '', size: 1 },
    { name: 'ollama-windows-amd64.zip', browser_download_url: '', size: 1 },
  ]

  it('is picked by platform and architecture', () => {
    expect(engineAsset('linux', 'x64', assets)?.name).toBe('ollama-linux-amd64.tar.zst')
    expect(engineAsset('linux', 'arm64', assets)?.name).toBe('ollama-linux-arm64.tar.zst')
    expect(engineAsset('darwin', 'arm64', assets)?.name).toBe('ollama-darwin.tgz')
    expect(engineAsset('win32', 'x64', assets)?.name).toBe('ollama-windows-amd64.zip')
  })

  it('is nothing at all on a platform the release does not build for', () => {
    expect(engineAsset('freebsd', 'x64', assets)).toBeNull()
  })
})

describe('installing the engine', () => {
  it.skipIf(!hasZstd)('unpacks it and makes the binary runnable, without root', async () => {
    const bytes = await compressZstd(tarOf('bin/ollama', '#!/bin/sh\necho engine\n'))
    const apiBase = await releaseServer({ bytes, name: 'ollama-linux-amd64.tar.zst' })
    const dir = tempDir()

    const reported: string[] = []
    const installed = await installEngine({
      dir,
      platform: 'linux',
      arch: 'x64',
      apiBase,
      onProgress: (line) => reported.push(line),
    })

    expect(installed.version).toBe('v9.9.9')
    expect(readFileSync(installed.binary, 'utf8')).toContain('echo engine')
    // Run as a child of Milo, so it has to be executable.
    expect(statSync(installed.binary).mode & 0o111).not.toBe(0)
    expect(reported.some((line) => line.includes('ready'))).toBe(true)

    // The archive is unpacked, not kept: the install is the directory.
    expect(existsSync(path.join(dir, 'ollama-linux-amd64.tar.zst'))).toBe(false)
  })

  it.skipIf(!hasZstd)('leaves an install that is already current alone', async () => {
    const bytes = await compressZstd(tarOf('bin/ollama', 'engine'))
    const apiBase = await releaseServer({ bytes, name: 'ollama-linux-amd64.tar.zst' })
    const dir = tempDir()

    const first = await installEngine({ dir, platform: 'linux', arch: 'x64', apiBase })
    const again: string[] = []
    const second = await installEngine({
      dir,
      platform: 'linux',
      arch: 'x64',
      apiBase,
      onProgress: (line) => again.push(line),
    })

    expect(second.binary).toBe(first.binary)
    expect(again.some((line) => line.includes('already installed'))).toBe(true)
  })

  it.skipIf(!hasZstd)('refuses a download that does not match the published digest', async () => {
    const bytes = await compressZstd(tarOf('bin/ollama', 'engine'))
    const digest = createHash('sha256').update(bytes).digest('hex')
    const apiBase = await releaseServer({
      bytes,
      name: 'ollama-linux-amd64.tar.zst',
      // The real digest, one character wrong.
      digest: `sha256:${digest.slice(0, -1)}${digest.endsWith('a') ? 'b' : 'a'}`,
    })
    const dir = tempDir()

    await expect(
      installEngine({ dir, platform: 'linux', arch: 'x64', apiBase }),
    ).rejects.toThrow(/digest/)
    // Nothing written: a file that exists is a file Milo would treat as installed.
    expect(existsSync(path.join(dir, 'ollama-linux-amd64.tar.zst'))).toBe(false)
  })

  it.skipIf(!hasZstd)('refuses a download shorter than the release published', async () => {
    const bytes = await compressZstd(tarOf('bin/ollama', 'engine'))
    // What a captive portal answering 200 with a page of HTML looks like.
    const apiBase = await releaseServer({
      bytes,
      name: 'ollama-linux-amd64.tar.zst',
      declaredSize: bytes.length + 1_000,
    })

    await expect(installEngine({ dir: tempDir(), platform: 'linux', arch: 'x64', apiBase })).rejects.toThrow(
      /not the/,
    )
  })

  it('says so when the release has nothing for this machine', async () => {
    const apiBase = await releaseServer({
      bytes: Buffer.from('nope'),
      name: 'ollama-plan9-amd64.tar.zst',
    })

    await expect(
      installEngine({ dir: tempDir(), platform: 'linux', arch: 'x64', apiBase }),
    ).rejects.toThrow(/no engine build/)
  })
})

describe('pulling a model', () => {
  it('reports status lines and how far the download has got', async () => {
    const events = [
      { status: 'pulling manifest' },
      { status: 'downloading', total: 100, completed: 20 },
      { status: 'downloading', total: 100, completed: 100 },
      { status: 'success' },
    ]
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' })
      response.end(events.map((event) => `${JSON.stringify(event)}\n`).join(''))
    })
    open = server
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0

    const reported: string[] = []
    await pullModel({
      url: `http://127.0.0.1:${port}`,
      model: 'bge-m3',
      onProgress: (line) => reported.push(line),
    })

    expect(reported).toContain('pulling manifest')
    expect(reported.some((line) => line.includes('20%'))).toBe(true)
    expect(reported).toContain('success')
  })

  it('fails with what the engine said', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' })
      response.end(`${JSON.stringify({ error: 'model not found' })}\n`)
    })
    open = server
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0

    await expect(pullModel({ url: `http://127.0.0.1:${port}`, model: 'nope' })).rejects.toThrow(
      /model not found/,
    )
  })
})

describe('the private port', () => {
  it('hands back one nothing is listening on', async () => {
    const port = await freePort(11500, 11510)
    expect(port).toBeGreaterThanOrEqual(11500)
    expect(port).toBeLessThanOrEqual(11510)
  })

  it('reports nothing answering where embeddings are configured', async () => {
    const port = await freePort(11520, 11530)
    expect(await engineAnswers(`http://127.0.0.1:${port}`)).toBe(false)
  })
})

/**
 * A stand-in engine: it answers the two routes Milo uses and nothing else. `exec`
 * so the process that gets the signal is node itself, not a shell in between.
 */
const FAKE_ENGINE = `#!/bin/sh
exec node -e "const http=require('http');const port=Number((process.env.OLLAMA_HOST||':1').split(':').pop());http.createServer((q,s)=>{if(q.url==='/api/tags'){s.writeHead(200);s.end('{}');return}if(q.url==='/api/pull'){s.writeHead(200,{'content-type':'application/x-ndjson'});s.end(JSON.stringify({status:'success'})+String.fromCharCode(10));return}s.writeHead(404);s.end()}).listen(port,'127.0.0.1')"
`

describe('provisioning for the setup screen', () => {
  it.skipIf(!hasZstd)('installs, runs and pulls in one call', async () => {
    const bytes = await compressZstd(tarOf('bin/ollama', FAKE_ENGINE))
    const apiBase = await releaseServer({ bytes, name: 'ollama-linux-amd64.tar.zst' })
    const dir = tempDir()

    const reported: string[] = []
    const provisioned = await provisionEmbedding({
      dir,
      model: 'bge-m3',
      apiBase,
      onProgress: (line) => reported.push(line),
    })

    try {
      expect(provisioned.version).toBe('v9.9.9')
      expect(provisioned.model).toBe('bge-m3')
      expect(provisioned.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      // What the screen shows: the steps it went through, in order.
      expect(reported[0]).toContain('release')
      expect(reported).toContain('success')
      expect(await engineAnswers(provisioned.url)).toBe(true)
    } finally {
      provisioned.stop()
    }
  })

  it('stops the engine it started when the model cannot be pulled', async () => {
    const engine = `#!/bin/sh
exec node -e "const http=require('http');const port=Number((process.env.OLLAMA_HOST||':1').split(':').pop());http.createServer((q,s)=>{if(q.url==='/api/tags'){s.writeHead(200);s.end('{}');return}s.writeHead(200);s.end(JSON.stringify({error:'no such model'})+String.fromCharCode(10))}).listen(port,'127.0.0.1')"
`
    const bytes = await compressZstd(tarOf('bin/ollama', engine))
    const apiBase = await releaseServer({ bytes, name: 'ollama-linux-amd64.tar.zst' })

    await expect(
      provisionEmbedding({ dir: tempDir(), model: 'nope', apiBase }),
    ).rejects.toThrow(/no such model/)
  })
})
