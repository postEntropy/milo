import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { errorMessage } from '../util/errors.js'
import { logWarn } from '../util/log.js'
import { tracesFile } from './config/paths.js'
import type { ChatRequest, FinishReason, Provider, StreamEvent } from './providers/types.js'

/** The kinds of execution the log records. A closed vocabulary, so a reader can trust the name. */
export type TraceEventName = 'model.request' | 'classifier.request' | 'tool.call' | 'turn'

/**
 * One line of the execution log.
 *
 * What it holds is deliberately narrow: when, what kind, whether it worked, how
 * long it took — plus the numbers that say which model and how much it cost.
 * Never the prompt, an argument or an answer. That is the line between a log a
 * person can keep and one that holds the conversation, and it is the whole reason
 * this file is allowed to exist beside the history that already holds the words.
 */
export interface TraceEvent {
  at: string
  event: TraceEventName
  ok: boolean
  ms: number
  /** Everything else the event carries: purpose, model, tokens, and so on. */
  [key: string]: unknown
}

export interface TraceWriter {
  record(entry: TraceEvent): void
}

const FILE_MODE = 0o600
const DIR_MODE = 0o700

/**
 * The execution log, one append-only JSONL file under `~/.milo`.
 *
 * A single synchronous append per event: the events are one per request and one
 * per tool, not one per token, and a file that survives a crash without a flush
 * is worth more here than the microseconds a buffered writer would save. A log
 * that cannot be written must never take a turn down with it.
 */
export const fileTraces: TraceWriter = {
  record(entry: TraceEvent): void {
    try {
      const file = tracesFile()
      mkdirSync(path.dirname(file), { recursive: true, mode: DIR_MODE })
      appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: FILE_MODE })
    } catch (error) {
      logWarn(`could not write the execution log: ${errorMessage(error)}`)
    }
  },
}

/**
 * A provider that times every request and writes it to the log.
 *
 * The seam is here, and here only, because every model call in Milo goes through
 * `Provider.stream` — the chat turn, a delegated subtask, and the mechanical
 * calls (folding a session, recapping one, reading a turn for facts). Wrapping
 * the provider once covers all of them with one measurement, instead of counting
 * the same span again at each caller. `req.trace` says what the request was and
 * where it came from; a request without one is a chat turn.
 */
export class TracedProvider implements Provider {
  readonly id: string
  private readonly inner: Provider
  private readonly traces: TraceWriter

  constructor(inner: Provider, traces: TraceWriter) {
    this.inner = inner
    this.traces = traces
    this.id = inner.id
  }

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    const started = Date.now()
    let firstTokenAt: number | undefined
    let inputTokens = 0
    let outputTokens = 0
    let finish: FinishReason | undefined
    let ok = true
    let failure: string | undefined

    try {
      for await (const event of this.inner.stream(req)) {
        // The first token is the number that matters: it is the wait the person
        // feels, apart from the rest, which is the model producing the answer.
        if (firstTokenAt === undefined && (event.type === 'text' || event.type === 'reasoning' || event.type === 'tool-call')) {
          firstTokenAt = Date.now()
        }
        if (event.type === 'usage') {
          inputTokens = event.inputTokens
          outputTokens = event.outputTokens
        } else if (event.type === 'done') {
          finish = event.finishReason
        }
        yield event
      }
    } catch (error) {
      ok = false
      failure = errorMessage(error)
      throw error
    } finally {
      const tag = req.trace
      this.traces.record({
        at: new Date().toISOString(),
        event: 'model.request',
        ok,
        ms: Date.now() - started,
        purpose: tag?.purpose ?? 'chat',
        model: req.model,
        provider: this.inner.id,
        ...(tag?.surface ? { surface: tag.surface } : {}),
        ...(tag?.session ? { session: tag.session } : {}),
        ...(firstTokenAt !== undefined ? { ttftMs: firstTokenAt - started } : {}),
        inputTokens,
        outputTokens,
        ...(finish ? { finish } : {}),
        ...(failure ? { error: failure } : {}),
      })
    }
  }
}

export interface TraceStatus {
  /** Where the log lives. */
  file: string
  /** Lines on disk. */
  events: number
  /** What it costs, the way `du` would read it. */
  bytes: number
  /** The oldest and newest event timestamps, when there are any. */
  oldest?: string
  newest?: string
}

/**
 * The last `limit` events (all of them when `limit` is absent), oldest first.
 * A line a crash left half-written is skipped rather than failing the read.
 */
export function readTraces(options: { limit?: number } = {}): TraceEvent[] {
  const events = readLines()
  const limit = options.limit ?? events.length
  return events.slice(Math.max(0, events.length - limit))
}

/** What the log costs. A readout: Milo never trims it on its own. */
export function traceStatus(file: string = tracesFile()): TraceStatus {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return { file, events: 0, bytes: 0 }
  }
  const events = parseLines(raw)
  let bytes = 0
  try {
    bytes = statSync(file).size
  } catch {
    // A file that vanished mid-count is simply not counted.
  }
  return {
    file,
    events: events.length,
    bytes,
    ...(events.length > 0 ? { oldest: events[0]!.at, newest: events[events.length - 1]!.at } : {}),
  }
}

/**
 * Drops every event from before `before` (`YYYY-MM-DD`) and returns how many were
 * removed. Rewrites the one file in place — the deliberate way to shrink it,
 * which is to say the only one: nothing calls this but `milo log trim`.
 */
export function trimTraces(before: string, file: string = tracesFile()): number {
  const events = readLines(file)
  const kept = events.filter((event) => event.at.slice(0, 10) >= before)
  const removed = events.length - kept.length
  if (removed === 0) return 0
  const text = kept.map((event) => `${JSON.stringify(event)}\n`).join('')
  writeFileSync(file, text, { mode: FILE_MODE })
  return removed
}

/** The whole log, oldest first. An empty list when there is no file yet. */
function readLines(file: string = tracesFile()): TraceEvent[] {
  try {
    return parseLines(readFileSync(file, 'utf8'))
  } catch {
    return []
  }
}

function parseLines(raw: string): TraceEvent[] {
  const events: TraceEvent[] = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    try {
      events.push(JSON.parse(line) as TraceEvent)
    } catch {
      // A torn last line — the process died mid-append — is not worth failing over.
    }
  }
  return events
}

export interface FollowOptions {
  /** Called with each event, as a JSON line: the backlog first, then the new ones. */
  out(line: string): void
  /** How many recent events to print before following. Zero means follow only. */
  backlog?: number
  /** How often the file is checked for new lines. Defaults to 400ms. */
  intervalMs?: number
  /** Stops the follow. `milo log -f` passes the one Ctrl+C aborts. */
  signal?: AbortSignal
}

const DEFAULT_FOLLOW_INTERVAL_MS = 400

/**
 * Prints the log as it grows, the way `tail -f` does: the backlog `limit` events
 * first, then every line appended after that, until `signal` aborts.
 *
 * Polled rather than watched: the file is append-only and quoted by size, so a
 * read from the last offset is exact, and a rewrite (`milo log trim`, which
 * shrinks it) is noticed where `fs.watch` would only fire unreliably and
 * differently on each platform. A half-written line is held back until the rest
 * of it lands, so a torn read never prints half an event.
 */
export async function followTraces(options: FollowOptions): Promise<void> {
  const file = tracesFile()
  const backlog = options.backlog ?? 0
  if (backlog > 0) for (const event of readTraces({ limit: backlog })) options.out(JSON.stringify(event))

  const interval = options.intervalMs ?? DEFAULT_FOLLOW_INTERVAL_MS
  let offset = sizeOf(file)
  let leftover = ''

  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      const size = sizeOf(file)
      // Shrunk means it was rewritten under us: the new content is what is left
      // after a trim, so start past it rather than reprinting what was seen.
      if (size < offset) {
        offset = size
        leftover = ''
        return
      }
      if (size <= offset) return
      const chunk = readFrom(file, offset)
      offset = chunk.next
      const lines = (leftover + chunk.text).split('\n')
      leftover = lines.pop() ?? ''
      for (const line of lines) if (line.trim() !== '') options.out(line)
    }, interval)

    const stop = () => {
      clearInterval(timer)
      options.signal?.removeEventListener('abort', stop)
      resolve()
    }
    options.signal?.addEventListener('abort', stop, { once: true })
    if (options.signal?.aborted) stop()
  })
}

/** The file's size, or zero when it is not there yet. */
function sizeOf(file: string): number {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

/** The bytes from `offset` to the current end, decoded. Empty when there are none. */
function readFrom(file: string, offset: number): { text: string; next: number } {
  let fd: number
  try {
    fd = openSync(file, 'r')
  } catch {
    return { text: '', next: offset }
  }
  try {
    const { size } = fstatSync(fd)
    if (size <= offset) return { text: '', next: offset }
    const buffer = Buffer.alloc(size - offset)
    let read = 0
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, offset + read)
      if (n <= 0) break
      read += n
    }
    return { text: buffer.subarray(0, read).toString('utf8'), next: offset + read }
  } finally {
    closeSync(fd)
  }
}
