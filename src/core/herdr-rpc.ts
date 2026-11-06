import { spawn } from 'node:child_process'

export class HerdrNotInstalled extends Error {}

export type HerdrTerminal = {
  address: string
  state: 'live' | 'finished'
  created_ms: number
  cwd: string
  exit_code?: number | null
  reason?: string | null
  labels: Record<string, string>
}

export function parseHerdrTerminal(value: unknown): HerdrTerminal {
  if (!value || typeof value !== 'object') throw new Error('Herdr returned an invalid terminal.')
  const item = value as Record<string, unknown>
  const labels = item.labels
  if (typeof item.address !== 'string' || !/^(?:[a-z0-9][a-z0-9._-]*\/)?t[a-z0-9]+$/.test(item.address) ||
    (item.state !== 'live' && item.state !== 'finished') || typeof item.created_ms !== 'number' || !Number.isFinite(item.created_ms) ||
    typeof item.cwd !== 'string' || !labels || typeof labels !== 'object' || Array.isArray(labels) ||
    !Object.values(labels).every((value) => typeof value === 'string') ||
    (item.exit_code !== undefined && item.exit_code !== null && !Number.isInteger(item.exit_code)) ||
    (item.reason !== undefined && item.reason !== null && typeof item.reason !== 'string')) {
    throw new Error('Herdr returned an invalid terminal.')
  }
  return item as HerdrTerminal
}

export function parseHerdrTerminalList(value: unknown): HerdrTerminal[] {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray((value as { terminals?: unknown }).terminals)) {
    throw new Error('Herdr returned an invalid terminal list.')
  }
  return (value as { terminals: unknown[] }).terminals.map(parseHerdrTerminal)
}

export async function herdrCall(
  method: string,
  params: Record<string, unknown>,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(options.signal.reason ?? new Error('Herdr request was stopped.'))
      return
    }
    const child = spawn('hc', ['connect'], { stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''
    let errors = ''
    let settled = false
    let onAbort = () => {}
    const timer = setTimeout(() => {
      abort(new Error('Herdr did not answer. Check existing Session runs before retrying.'))
    }, options.timeoutMs ?? 30_000)
    function abort(error: Error): void {
      if (settled) return
      child.kill()
      const force = setTimeout(() => child.kill('SIGKILL'), 2000)
      force.unref()
      child.once('close', () => clearTimeout(force))
      finish(error)
    }
    function finish(error?: Error, result?: unknown): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve(result)
    }
    onAbort = () => abort(options.signal?.reason instanceof Error ? options.signal.reason : new Error('Herdr request was stopped.'))
    options.signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (error: NodeJS.ErrnoException) => finish(error.code === 'ENOENT'
      ? new HerdrNotInstalled('Herdr is not installed. Install hc to use Command Code Sessions.')
      : new Error(`Could not start Herdr: ${error.message}`)))
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      output += chunk
      if (output.length > 2_000_000) abort(new Error('Herdr returned too much data.'))
    })
    child.stderr.on('data', (chunk: string) => {
      errors += chunk
      if (errors.length > 16_000) abort(new Error('Herdr returned too much error output.'))
    })
    child.on('close', (code) => {
      if (code !== 0) return finish(new Error(`Herdr connection failed: ${errors.trim() || `exit ${code}`}`))
      try {
        const response: unknown = JSON.parse(output.trim())
        if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error('Invalid response')
        const data = response as Record<string, unknown>
        if (data.jsonrpc !== '2.0') throw new Error('Invalid JSON-RPC version')
        if (data.id !== 1) throw new Error('Invalid response id')
        const hasResult = Object.hasOwn(data, 'result')
        const hasError = Object.hasOwn(data, 'error')
        if (hasResult === hasError) throw new Error('A response must contain exactly one of result or error')
        if (hasError) {
          const rpcError = data.error
          if (!rpcError || typeof rpcError !== 'object' || Array.isArray(rpcError) ||
            !Number.isInteger((rpcError as Record<string, unknown>).code) ||
            typeof (rpcError as Record<string, unknown>).message !== 'string') {
            throw new Error('Invalid JSON-RPC error')
          }
          throw new Error((rpcError as { message: string }).message)
        }
        finish(undefined, data.result)
      } catch (error) {
        finish(new Error(`Herdr request failed: ${error instanceof Error ? error.message : String(error)}`))
      }
    })
    child.stdin.on('error', (error) => abort(new Error(`Herdr connection failed: ${error.message}`)))
    child.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })}\n`)
  })
}
