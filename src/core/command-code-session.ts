import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import lockfile from 'proper-lockfile'
import { promisify } from 'node:util'
import { ensurePrivateDir, writePrivateFile } from '../util/fs.js'
import { errorMessage } from '../util/errors.js'
import { logWarn } from '../util/log.js'
import { CommandCodeHistoryReader } from './command-code-history.js'
import type { CommandCodeSessionDriver, NativeSessionHistory, NativeSessionTurn, SessionBackendAvailability } from './session-backend.js'
import { HerdrNotInstalled, herdrCall, parseHerdrTerminal, parseHerdrTerminalList, type HerdrTerminal } from './herdr-rpc.js'
import type { AgentEvent } from './agent/events.js'
import type { Message } from './providers/types.js'
import type { CommandCodeSessionBackend, SessionRecord } from './sessions/types.js'

const execFileAsync = promisify(execFile)
const HERDR_CHECK_SECONDS = 20
const HERDR_RPC_TIMEOUT_MS = 30_000
const SESSION_LOCK_RETRIES = { forever: true, factor: 1.2, minTimeout: 200, maxTimeout: 1000, randomize: true }
const LABEL_SESSION = 'milo-session-id'
const LABEL_TURN = 'milo-turn-id'
const LABEL_BACKEND = 'milo-agent'

interface CliResult {
  subtype: string
  sessionId?: string
  stopReason?: string
  finalText?: string
  error?: string
}

export class HerdrCommandCodeSessionDriver implements CommandCodeSessionDriver {
  private readonly historyReader: CommandCodeHistoryReader
  private readonly operationDirectory: string
  private readonly call: typeof herdrCall
  private readonly checkCommandCode: () => Promise<void>

  constructor(options: { home?: string; call?: typeof herdrCall; checkCommandCode?: () => Promise<void> } = {}) {
    const home = options.home ?? os.homedir()
    this.historyReader = new CommandCodeHistoryReader(home)
    this.operationDirectory = path.join(home, '.milo', 'command-code')
    this.call = options.call ?? herdrCall
    this.checkCommandCode = options.checkCommandCode ?? (async () => {
      await execFileAsync('cmd', ['--version'], { timeout: 5_000, maxBuffer: 32_000 })
    })
  }

  async availability(): Promise<SessionBackendAvailability> {
    try {
      await this.checkCommandCode()
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      return {
        id: 'command-code',
        available: false,
        reason: code === 'ENOENT' ? 'Command Code is not installed on this machine.' : `Command Code could not be checked: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    try {
      await this.call('terminal.list', { all: false, labels: { 'milo-session-backend': 'availability-check' } })
    } catch (error) {
      return {
        id: 'command-code',
        available: false,
        reason: error instanceof HerdrNotInstalled ? error.message : `Herdr is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    return { id: 'command-code', available: true }
  }

  async history(record: SessionRecord): Promise<NativeSessionHistory> {
    return this.historyReader.read(record)
  }

  async *send(
    record: SessionRecord,
    input: string,
    options: {
      signal?: AbortSignal
      retryPending?: boolean
      newTurn?: boolean
      onBackendUpdate?: (backend: CommandCodeSessionBackend) => Promise<void>
    } = {},
  ): AsyncGenerator<AgentEvent, NativeSessionTurn, void> {
    const backend = record.backend
    if (backend?.kind !== 'command-code') throw new Error(`Session ${record.id} has no Command Code backend.`)
    const pending = backend.pendingTurn
    if (!pending) throw new Error('The Command Code turn was not persisted before launch.')
    const labels = this.labels(record, pending.id)
    const before = await this.history(record)
    const terminals = await this.terminals({ [LABEL_SESSION]: record.id })
    const matching = terminals.filter((terminal) => terminal.labels[LABEL_TURN] === pending.id)
    const activeOther = terminals.filter((terminal) => terminal.state === 'live' && terminal.labels[LABEL_TURN] !== pending.id)
    if (activeOther.length > 0) throw new Error(`Another Command Code turn is already running in Session ${record.id}.`)
    if (matching.length > 1) throw new Error(`More than one Herdr terminal is attached to Session ${record.id} turn ${pending.id}.`)
    if (matching.length === 0 && !options.retryPending && !options.newTurn) {
      const error = 'No Herdr terminal can confirm this Command Code turn. Inspect the native Session before retrying it.'
      return { backend: { ...backend, state: 'error', error }, history: before, error }
    }

    let terminal: HerdrTerminal
    try {
      if (matching[0]) {
        terminal = matching[0]
      } else {
        const argv = [
          'cmd', '-p', '--output-format', 'json', '--yolo', '--skip-onboarding',
          ...(backend.nativeSessionId ? ['--resume', backend.nativeSessionId] : ['--name', backend.nativeTitle]),
          input,
        ]
        terminal = await this.runTerminal(record, argv, labels, options.signal)
        record.backend = { ...backend, state: 'running', terminalId: terminal.address }
        await options.onBackendUpdate?.(record.backend)
      }
      if (terminal.state === 'live') {
        yield { type: 'waiting' }
        terminal = await this.waitForExit(terminal.address, options.signal)
      }
      if (terminal.state !== 'finished') throw new Error('Herdr did not confirm that the Command Code turn finished.')
    } catch (error) {
      if (options.signal?.aborted) await this.stopTurn(record.id, pending.id)
      throw error
    }

    const output = (await this.readTerminal(terminal.address)).text
    const frames = parseHeadlessFrames(output)
    const result = [...frames].reverse().find((frame) => frame.type === 'result') as (Record<string, unknown> & CliResult) | undefined
    if (!result) throw new Error('Command Code returned no final session result.')
    const nativeSessionId = typeof result.sessionId === 'string' ? result.sessionId : backend.nativeSessionId
    if (!nativeSessionId) throw new Error('Command Code returned no native session id, so this Session cannot be resumed safely.')
    record.backend = { ...backend, state: 'running', terminalId: terminal.address, nativeSessionId }
    const history = await this.historyReader.read(record)
    const resultError = result.subtype !== 'success'
      ? (typeof result.error === 'string' ? result.error : `Command Code ended with ${result.subtype}.`)
      : typeof result.finalText !== 'string' || !result.finalText.trim() || !this.confirmsPendingTurn(history.messages, pending, result.finalText)
        ? 'Herdr finished, but its result could not be matched to the native Session transcript. Inspect it before retrying.'
        : undefined
    for (const event of eventsFor(history.messages.slice(pending.baseMessageCount))) yield event
    if (resultError) yield { type: 'error', message: resultError }
    else yield { type: 'done', finishReason: typeof result.stopReason === 'string' ? result.stopReason : 'end_turn' }
    const updatedBackend: CommandCodeSessionBackend = {
      ...backend,
      state: resultError ? 'error' : 'ready',
      nativeSessionId,
      terminalId: undefined,
      pendingTurn: resultError ? pending : undefined,
      ...(resultError ? { error: resultError } : { error: undefined }),
    }
    return { backend: updatedBackend, history, ...(resultError ? { error: resultError } : {}) }
  }

  private confirmsPendingTurn(
    messages: Message[],
    pending: NonNullable<CommandCodeSessionBackend['pendingTurn']>,
    finalText: string,
  ): boolean {
    const additions = messages.slice(pending.baseMessageCount)
    const userIndex = additions.findIndex((message) => message.role === 'user' && message.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('') === pending.input)
    if (userIndex < 0 || additions.slice(userIndex + 1).some((message) => message.role === 'user')) return false
    return additions.slice(userIndex + 1).some((message) => message.role === 'assistant' && message.content
      .filter((part) => part.type === 'text')
      .some((part) => part.text.trim() === finalText.trim()))
  }

  private async stopTurn(sessionId: string, turnId: string): Promise<void> {
    await this.withSessionOperationLock(sessionId, async () => {
      const terminals = await this.terminals({ [LABEL_SESSION]: sessionId, [LABEL_TURN]: turnId })
      for (const terminal of terminals) {
        if (terminal.state === 'live') await this.call('terminal.kill', { terminal: terminal.address })
      }
    })
  }

  async stop(record: SessionRecord): Promise<CommandCodeSessionBackend> {
    const backend = record.backend
    if (backend?.kind !== 'command-code') throw new Error(`Session ${record.id} has no Command Code backend.`)
    await this.withSessionOperationLock(record.id, async () => {
      await writePrivateFile(this.removalFile(record.id), `${record.id}\n`)
      const terminals = await this.terminals({
        [LABEL_SESSION]: record.id,
        [LABEL_BACKEND]: 'command-code-session',
      })
      for (const terminal of terminals) {
        if (terminal.state === 'live') await this.call('terminal.kill', { terminal: terminal.address })
      }
    })
    return { ...backend, state: 'stopped', terminalId: undefined }
  }

  private removalFile(sessionId: string): string {
    const key = createHash('sha256').update(sessionId).digest('hex')
    return path.join(this.operationDirectory, `${key}.removed`)
  }

  private async withSessionOperationLock<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    ensurePrivateDir(this.operationDirectory)
    const key = createHash('sha256').update(sessionId).digest('hex')
    const target = path.join(this.operationDirectory, `${key}.operation`)
    const release = await lockfile.lock(target, {
      realpath: false,
      stale: 10_000,
      retries: SESSION_LOCK_RETRIES,
      onCompromised: (error) => logWarn(`lost the Command Code operation lock for Session ${sessionId}: ${errorMessage(error)}`),
    })
    try {
      return await work()
    } finally {
      await release()
    }
  }

  private labels(record: SessionRecord, turnId: string): Record<string, string> {
    const backend = record.backend
    if (backend?.kind !== 'command-code') throw new Error(`Session ${record.id} has no Command Code backend.`)
    return {
      [LABEL_BACKEND]: 'command-code-session',
      [LABEL_SESSION]: record.id,
      [LABEL_TURN]: turnId,
      ...(record.project ? { 'milo-project': record.project } : {}),
      ...(backend.projectIncarnation ? { 'milo-project-incarnation': backend.projectIncarnation } : {}),
    }
  }

  private async terminals(labels: Record<string, string>): Promise<HerdrTerminal[]> {
    const result = await this.call('terminal.list', { all: true, labels })
    if (!result || typeof result !== 'object' || Array.isArray(result) || !Array.isArray((result as { terminals?: unknown }).terminals)) {
      throw new Error('Herdr returned an invalid terminal list.')
    }
    return parseHerdrTerminalList(result)
  }

  private async runTerminal(
    record: SessionRecord,
    argv: string[],
    labels: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<HerdrTerminal> {
    const backend = record.backend
    if (backend?.kind !== 'command-code') throw new Error(`Session ${record.id} has no Command Code backend.`)
    return this.withSessionOperationLock(record.id, async () => {
      if (existsSync(this.removalFile(record.id))) throw new Error(`Command Code Session ${record.id} is being removed.`)
      const existing = await this.terminals({ [LABEL_SESSION]: record.id, [LABEL_TURN]: labels[LABEL_TURN]! })
      if (existing.length > 1) throw new Error(`More than one Herdr terminal is attached to Session ${record.id} turn ${labels[LABEL_TURN]}.`)
      if (existing[0]) return existing[0]
      const result = await this.call('terminal.run', {
        argv,
        cwd: backend.workingDirectory,
        labels,
        name: `milo-${createHash('sha1').update(record.id).digest('hex').slice(0, 16)}`,
        no_parent: true,
        outlive_parent: true,
        wait: false,
      }, { timeoutMs: HERDR_RPC_TIMEOUT_MS, signal })
      return parseHerdrTerminal(result)
    })
  }

  private async waitForExit(address: string, signal?: AbortSignal): Promise<HerdrTerminal> {
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new Error('Command Code turn was stopped.')
      const waited = await this.call('terminal.wait', { terminal: address, timeout: HERDR_CHECK_SECONDS }, {
        timeoutMs: HERDR_RPC_TIMEOUT_MS,
        signal,
      })
      if (!waited || typeof waited !== 'object' || typeof (waited as Record<string, unknown>).ended !== 'boolean') {
        throw new Error('Herdr returned an invalid wait result.')
      }
      const terminal = parseHerdrTerminal(await this.call('terminal.get', { terminal: address }))
      if (terminal.state === 'finished') return terminal
      if ((waited as { ended: boolean }).ended) continue
    }
  }

  private async readTerminal(address: string): Promise<{ text: string; complete: boolean }> {
    const result = await this.call('terminal.read', { terminal: address, lines: 100_000 })
    if (!result || typeof result !== 'object' || typeof (result as Record<string, unknown>).text !== 'string' ||
      typeof (result as Record<string, unknown>).complete !== 'boolean') {
      throw new Error('Herdr returned an invalid terminal transcript.')
    }
    const screen = result as { text: string; complete: boolean }
    if (!screen.complete) throw new Error('Herdr truncated the Command Code turn output; inspect the native Session in Command Code.')
    return screen
  }
}

function stripAnsi(output: string): string {
  let clean = ''
  for (let index = 0; index < output.length; index += 1) {
    const code = output.charCodeAt(index)
    if (code === 27 || code === 155) {
      const introducer = code === 27 ? output.charCodeAt(index + 1) : 91
      if (introducer === 91) {
        index += code === 27 ? 2 : 1
        while (index < output.length) {
          const final = output.charCodeAt(index)
          if (final >= 0x40 && final <= 0x7e) break
          index += 1
        }
      } else if (introducer === 93) {
        index += 2
        while (index < output.length) {
          if (output.charCodeAt(index) === 7) break
          if (output.charCodeAt(index) === 27 && output[index + 1] === '\\') {
            index += 1
            break
          }
          index += 1
        }
      } else {
        index += code === 27 ? 1 : 0
      }
      continue
    }
    clean += output[index]
  }
  return clean
}

function parseHeadlessFrames(output: string): Record<string, unknown>[] {
  const clean = stripAnsi(output)
  const frames: Record<string, unknown>[] = []
  let candidate = ''
  let depth = 0
  let inString = false
  let escaped = false
  for (const char of clean) {
    if (!candidate) {
      if (char.trim() === '') continue
      if (char !== '{') throw new Error('Command Code emitted non-JSON output in JSON mode.')
      candidate = char
      depth = 1
      inString = false
      escaped = false
      continue
    }
    candidate += char
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{' || char === '[') depth += 1
    else if (char === '}' || char === ']') depth -= 1
    if (depth < 0) throw new Error('Command Code emitted malformed JSON output.')
    if (depth === 0) {
      let value: unknown
      try { value = JSON.parse(candidate) } catch { throw new Error('Command Code emitted malformed JSON output.') }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Command Code emitted an invalid JSON frame.')
      frames.push(value as Record<string, unknown>)
      candidate = ''
    }
  }
  if (candidate) throw new Error('Command Code output ended in a partial JSON frame.')
  return frames
}

function eventsFor(messages: Message[]): AgentEvent[] {
  const events: AgentEvent[] = []
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const part of message.content) {
        if (part.type === 'text' && part.text) events.push({ type: 'text-delta', delta: part.text })
        else if (part.type === 'reasoning' && part.text) events.push({ type: 'reasoning-delta', delta: part.text })
        else if (part.type === 'tool-call') events.push({ type: 'tool-start', id: part.id, name: part.name, args: part.args })
      }
    } else if (message.role === 'tool') {
      for (const part of message.content) {
        if (part.type === 'tool-result') events.push({
          type: 'tool-end',
          id: part.id,
          name: part.name,
          result: part.content,
          isError: part.isError === true,
        })
      }
    }
  }
  return events
}
