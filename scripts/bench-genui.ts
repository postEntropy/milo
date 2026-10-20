#!/usr/bin/env node
/**
 * Measures what drawing an interface costs a turn, side by side.
 *
 *   npm run bench:genui              simulated — no key, no network, same numbers anywhere
 *   npm run bench:genui -- --live    against the provider this install is configured with
 *   npm run bench:genui -- --decline the simulated model answers in prose whatever it was
 *                                    taught, which is how a teaching that does not take
 *                                    reads: the report says so and holds the comparison back
 *   npm run bench:genui -- --verbose  narrate each request as it lands (already on with
 *                                    `--live`, where a turn that stalls has to be visible)
 *   npm run bench:genui -- --jitter 900  the simulated provider is unpredictable by this
 *                                    much, which is how a real one makes the clock useless:
 *                                    if its own spread is wider than the difference being
 *                                    measured, the report says the clock cannot answer
 *   npm run bench:genui -- --against openrouter:nvidia/nemotron-3-ultra-550b-a55b:free \
 *                            --against commandcode:deepseek/deepseek-v4.1-flash
 *                                    the configured provider and model by default, or any
 *                                    provider this install has a key for. Two or more runs
 *                                    at once — the wait is the provider thinking, and two
 *                                    providers think independently — and each report is
 *                                    printed whole, one after the other. Implies `--live`.
 *
 * A widget used to cost a model round trip: the model called a tool, the request
 * ended there, and prose → widget → prose took a second request to carry on. The
 * block rides the stream the answer is already arriving on, so the claim this
 * measures is that drawing now costs no request at all — the widget is written
 * inside the answer. Nothing else about it is cheaper: the tree, the schema and
 * the drawing are the same code.
 *
 * So the number this prints first is the request count: one either way, which is a
 * fact about the design and does not depend on any model, network or provider. What
 * is left is the clock — and there the widget costs only its own tokens, at whatever
 * a token costs here.
 *
 * What is simulated, and what is not: in the default mode the *model* is faked —
 * a wait before the first token, then the answer a word at a time, at the speeds
 * on `--latency` and `--chunk` — so the run is reproducible and needs nothing
 * from you. Everything else is real: the real session, the real agent loop, the
 * real splitter, the real tool. `--live` swaps the faked model for the configured
 * one and reports the same columns with the provider's own timings.
 *
 * The catalog is cut to the drawing tool and nothing else, which is both what makes
 * the measurement one about drawing and what makes the bench safe to point at a
 * real model: a turn here has no permission policy, and a tool without a policy is
 * a tool that runs unchecked. A turn is also cut off at `--timeout`, because a
 * bench that can hang is a bench that lies by not answering.
 *
 * Every number here is one turn on a warm session with no tools beyond the one
 * being measured, so it is the floor, not a promise about a long conversation.
 */
import { randomUUID } from 'node:crypto'
import process from 'node:process'
import { format } from 'node:util'
import { AgentRuntime } from '../src/core/runtime.js'
import { ToolRegistry } from '../src/core/tools/registry.js'
import { genUiSchema } from '../src/core/genui.js'
import { TracedProvider, type TraceEvent, type TraceWriter } from '../src/core/traces.js'
import type { ChatRequest, Provider, StreamEvent } from '../src/core/providers/types.js'
import type { Memory } from '../src/core/memory/index.js'

/**
 * What the person asks, the same words to every run.
 *
 * Deliberately a question with a *shape* — three things to compare, figures to read
 * side by side. A question whose answer is one line is refused by the instruction
 * ("a single fact ... is prose"), so asking one and reporting that the model drew
 * nothing measures obedience rather than the drawing. The first version of this
 * bench did exactly that and read as a failure of the drawing.
 */
const DEFAULT_PROMPT =
  'we are picking between three plans at $9, $29 and $99 a month — lay out what each one gives and what it costs'

const TREE = {
  kind: 'box',
  direction: 'column',
  gap: 3,
  children: [
    { kind: 'slider', id: 'seats', label: 'Seats', min: 1, max: 50, value: 8 },
    { kind: 'stat', label: 'Monthly total', formula: 'seats * 29', prefix: '$', suffix: '/mo' },
  ],
}

const BEFORE = 'Eight seats comes to $232 a month, before tax.'
const AFTER = 'Tell me if you want it changed.'

/**
 * A wait that ends early when the turn is stopped, the way a real request does. A
 * stub that slept through the abort would make the bench's own timeout untestable.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    const stop = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
      reject(signal?.reason ?? new Error('aborted'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop)
      resolve()
    }, ms)
    signal?.addEventListener('abort', stop, { once: true })
  })
}

/** Nothing is remembered: this measures a turn, not the memory around it. */
const NO_MEMORY: Memory = {
  remember: async () => undefined,
  recall: async () => [],
  list: async () => [],
  forget: async () => false,
} as never

class Collector implements TraceWriter {
  readonly events: TraceEvent[] = []
  private requests = 0

  constructor(
    /** What to call this turn in the running commentary. */
    private readonly label: string,
    /** Whether to narrate each request as it lands. */
    private readonly loud: boolean,
  ) {}

  record(entry: TraceEvent): void {
    this.events.push(entry)
    if (!this.loud || entry.event !== 'model.request') return
    // A live turn is watched while it runs. A model that keeps calling things, or a
    // provider that keeps being asked again, shows up here as requests piling up —
    // which is what "it is stuck" looks like from the outside and cannot be seen
    // from the count at the end. On stderr, beside the retry warnings, so the table
    // on stdout stays a table.
    this.requests += 1
    const ttft = typeof entry.ttftMs === 'number' ? `, first token ${entry.ttftMs}ms` : ''
    const failed = entry.ok ? '' : ` — FAILED${typeof entry.error === 'string' ? `: ${entry.error}` : ''}`
    console.error('    %s request %d — %sms%s%s', this.label, this.requests, entry.ms, ttft, failed)
  }
}

/**
 * A model at a realistic speed, answering in whichever way the request was taught
 * to it — a block when the prompt carries the fence, prose when it does not. Taught
 * from the request itself rather than from a flag, so a teaching that never reaches
 * the model is measured as a turn that never draws.
 */
class SimProvider implements Provider {
  readonly id = 'sim'

  constructor(
    private readonly latencyMs: number,
    private readonly chunkMs: number,
    /** Answers in prose whatever it was taught — see `--decline`. */
    private readonly decline: boolean,
    /** Random extra milliseconds per request — see `--jitter`. */
    private readonly jitterMs: number,
  ) {}

  async *stream(request: ChatRequest): AsyncGenerator<StreamEvent> {
    const block = !this.decline && (request.system ?? '').includes('```genui')
    await sleep(this.latencyMs + Math.random() * this.jitterMs, request.signal)

    if (block) {
      yield* this.words(`${BEFORE}\n\n`, request.signal)
      yield* this.words(`\`\`\`genui\n${JSON.stringify({ title: 'Team plan', tree: TREE })}\n\`\`\`\n\n`, request.signal)
      yield* this.words(AFTER, request.signal)
      yield { type: 'done', finishReason: 'stop' }
      return
    }
    yield* this.words(`${BEFORE} ${AFTER}`, request.signal)
    yield { type: 'done', finishReason: 'stop' }
  }

  /** The answer a word at a time, which is how it arrives. */
  private async *words(text: string, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    for (const word of text.match(/\S+\s*/g) ?? []) {
      yield { type: 'text', delta: word }
      await sleep(this.chunkMs, signal)
    }
  }
}

interface Sample {
  requests: number
  turnMs: number
  /** All of it, model time: the difference from `turnMs` is what Milo adds. */
  modelMs: number
  /** When the provider first produced anything — thinking counts, and is not read. */
  byteMs: number | null
  /** When the person could first read something. */
  textMs: number | null
  /** When the widget reached the surface, if it did. */
  widgetMs: number | null
  /** Whether a widget reached the surface at all. */
  drew: boolean
  /** The run was still going when the bench cut it off. */
  timedOut: boolean
  /** What the turn failed with, when the provider refused it — a busy free tier is not the model ignoring the tool. */
  failed: string | null
  /** The tree the model wrote, capped to enough of it to see the shape. */
  block: string | null
  /** Whether that block closed before the answer did. */
  closed: boolean
  /** What the schema said about a block that did close, when it refused it anyway. */
  complaint: string | null
}

/**
 * The first block in an answer, read from the model's own text — the transcript keeps
 * the answer as it was written, tag and all, where what reached the screen has already
 * been through the splitter and a refused block comes out of it re-marked as plain
 * code. Whether the fence closed is the difference the report has to be able to tell:
 * an answer cut off inside a block is a different finding from a tree it got wrong.
 */
function blockIn(text: string): { body: string; closed: boolean } | null {
  const open = /^[ \t]{0,3}```genui[ \t]*\r?\n/m.exec(text)
  if (!open) return null
  const rest = text.slice(open.index + open[0].length)
  const close = /^[ \t]{0,3}```/m.exec(rest)
  return close ? { body: rest.slice(0, close.index), closed: true } : { body: rest, closed: false }
}

const BLOCK_PREVIEW = 200
const BLOCK_TAIL = 160

/**
 * What the model wrote, head and tail. The tail matters: a block that is refused for
 * having something after the JSON inside its fence is only readable at the end, and a
 * preview that stops at the first 200 characters would show the same thing for both.
 */
function blockPreview(block: string): string {
  if (block.length <= BLOCK_PREVIEW + BLOCK_TAIL) return block
  return `${block.slice(0, BLOCK_PREVIEW)}\n… (${block.length - BLOCK_PREVIEW - BLOCK_TAIL} characters between)\n${block.slice(-BLOCK_TAIL)}`
}

/** Why the schema refused a block, in its own words, or null when it accepts it. */
function complaintOf(body: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body.trim())
  } catch (error) {
    return `not JSON (${error instanceof Error ? error.message : String(error)})`
  }
  const result = genUiSchema.safeParse(parsed)
  if (result.success) return null
  return result.error.issues
    .map((issue) => `${issue.path.join('.') || 'the widget'}: ${issue.message}`)
    .join('; ')
}

/**
 * Why a run is not one to compare — read from that run alone.
 *
 * A cut-off run is named first, because a run that was still going when the clock
 * ran out is not a drawing turn either: it is a turn that had not finished, and a
 * longer number than a finished one.
 *
 * A run the provider refused comes before the teaching is blamed: it never got the
 * chance to draw, and "no fence was ever written" would be read as a verdict on the
 * teaching. A free tier under load answers like this.
 */
function whyNot(sample: Sample): string {
  if (sample.timedOut) return `still running at ${ms(sample.turnMs)} when the bench cut it off`
  if (sample.failed) return `the turn failed before it drew: ${sample.failed}`
  if (!sample.block) return 'no block was ever written — the instruction did not take'
  if (!sample.closed) return 'the block never closed — the answer ended inside it'
  return `the shape did not take: ${sample.complaint ?? 'the schema refused it'}`
}

/** A run worth comparing: it drew, it finished on its own, and the provider answered it. */
function usable(sample: Sample): boolean {
  return sample.drew && !sample.timedOut && !sample.failed
}

/**
 * One turn, from the send to the last event, against a session of the real thing.
 * The model is the only part this does not build itself: the runtime, the session,
 * the loop and the splitter are the ones the app runs.
 */
async function runOnce(draws: boolean, provider: Provider, model: string, prompt: string, timeoutMs: number, loud: boolean, who: string): Promise<Sample> {
  const collector = new Collector(`${who}${draws ? 'drawn' : 'plain'}`, loud)
  const runtime = new AgentRuntime({
    provider: new TracedProvider(provider, collector),
    model,
    system: '',
    // No tool is offered, in either run: a turn here draws by writing a block into
    // its own answer, and the drawn run is the one whose prompt teaches it. That is
    // also why this is safe to run — a tool with no permission policy attached is a
    // tool that runs unchecked, and the first version of this bench handed the model
    // the whole catalog and no policy, which let a real turn run commands here.
    registry: new ToolRegistry([]),
    memory: NO_MEMORY,
    cwd: process.cwd(),
    // The same writer for the turn and its tool calls, so one run leaves one
    // record — and none of it goes to the log on disk.
    traces: collector,
  })
  const session = await runtime.sessionFor({ gateway: 'web', chatId: randomUUID() })

  const started = performance.now()
  let textMs: number | null = null
  let widgetMs: number | null = null
  let timedOut = false
  let failed: string | null = null
  // A bench may not be able to hang. Whatever a turn is doing when the clock runs
  // out — a slow request, a provider that stopped answering — it ends here, and the
  // run is reported as cut off rather than as a number.
  const stop = AbortSignal.timeout(timeoutMs)
  try {
    for await (const event of session.send(prompt, { genui: draws, signal: stop })) {
      if (event.type === 'text-delta' && textMs === null) textMs = performance.now() - started
      if (event.type === 'ui' && !event.draft && widgetMs === null) widgetMs = performance.now() - started
      if (event.type === 'error') failed ??= event.message
    }
  } catch (error) {
    // A stopped turn comes back as an event rather than a throw, so this is not the
    // timeout being caught — it is a real failure, and only the signal can tell them
    // apart. `stop.aborted` below is what decides, either way.
    if (!stop.aborted) throw error
  }
  const turnMs = performance.now() - started
  timedOut = stop.aborted

  const requests = collector.events.filter((event) => event.event === 'model.request')
  const first = requests[0]
  // Read from the turn's own transcript, not from what reached the surface: the
  // splitter hands a refused block back as plain code, and the only place the model's
  // block is still in its own shape is the text the turn kept.
  const written = session.messages
    .filter((message) => message.role === 'assistant')
    .flatMap((message) => message.content)
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
  const block = blockIn(written)
  return {
    requests: requests.length,
    turnMs,
    modelMs: requests.reduce((sum, event) => sum + Number(event.ms), 0),
    // The provider's own first token, which is where the waiting ended — the gap
    // to `textMs` is the model thinking, not the wire or Milo.
    byteMs: typeof first?.ttftMs === 'number' ? Number(first.ttftMs) : null,
    textMs,
    widgetMs,
    drew: widgetMs !== null,
    timedOut,
    failed,
    block: block ? blockPreview(block.body) : null,
    closed: block?.closed ?? false,
    complaint: block?.closed ? complaintOf(block.body) : null,
  }
}

interface Options {
  live: boolean
  runs: number
  latencyMs: number
  chunkMs: number
  /** How long one turn may take before the bench cuts it off. */
  timeoutMs: number
  /** Narrate each request as it lands — on by default with `--live`. */
  verbose: boolean
  /** Random spread per request, on top of `--latency`, so the simulated provider can be as unpredictable as a real one. */
  jitterMs: number
  /** The provider/model pairs to measure at once. Empty means the configured one. */
  against: Against[]
  /** The question every run is asked; `--prompt` replaces it. */
  prompt: string
  /** The model answers in prose whatever it was taught, which is what a teaching that does not take looks like. */
  decline: boolean
}

/** A pair to measure: a provider this install can talk through, and a model on it. */
interface Against {
  providerId: string
  /** Absent means the model the config is on, or the preset's first — and whichever it is, the report says which. */
  model?: string
  /** Where a defaulted model came from, printed with the pair so a default is never silent. */
  cameFrom?: string
}

function parseArgs(args: string[]): Options {
  const options: Options = { live: false, runs: 3, latencyMs: 400, chunkMs: 12, timeoutMs: 60_000, verbose: false, jitterMs: 0, against: [], prompt: DEFAULT_PROMPT, decline: false }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--live') options.live = true
    else if (arg === '--decline') options.decline = true
    else if (arg === '--verbose') options.verbose = true
    else if (arg === '--runs') options.runs = Number(args[++index])
    else if (arg === '--latency') options.latencyMs = Number(args[++index])
    else if (arg === '--chunk') options.chunkMs = Number(args[++index])
    else if (arg === '--timeout') options.timeoutMs = Number(args[++index])
    else if (arg === '--jitter') options.jitterMs = Number(args[++index])
    else if (arg === '--against') {
      // Split on the first colon: a provider id has none, a model id often does
      // (`nvidia/nemotron-3-ultra-550b-a55b:free`), so the left of the first is the
      // provider and everything after it is the model.
      const spec = args[++index] ?? ''
      const at = spec.indexOf(':')
      options.against.push(at === -1 ? { providerId: spec } : { providerId: spec.slice(0, at), model: spec.slice(at + 1) })
    }
    else if (arg === '--prompt') options.prompt = args[++index] ?? DEFAULT_PROMPT
    else {
      console.log('Usage: bench:genui [--live] [--decline] [--verbose] [--runs <n>] [--latency <ms>] [--chunk <ms>] [--timeout <ms>] [--loops <n>] [--jitter <ms>] [--prompt <text>] [--against <provider>[:<model>]]…')
      process.exit(2)
    }
  }
  // Measuring against another provider is a live thing by definition — there is no
  // simulated model behind that provider id — so the flag carries its own mode
  // rather than making every invocation say `--live` twice.
  if (options.against.length > 0) options.live = true
  return options
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : (sorted[middle] ?? 0)
}

/** `1234` as `1.23s`, `812` as `812ms`, and a dash for a thing that never came. */
const ms = (value: number | null): string =>
  value === null ? '—' : value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${value.toFixed(0)}ms`

/**
 * One model's whole report, as lines rather than as printing. Something that is
 * said rather than printed can be held: two models measured at once each fill their
 * own report and the two are laid down one after the other, where printing as the
 * runs land would interleave two tables into one that reads as neither.
 */
async function bench(options: Options, make: () => Provider, model: string, who: string): Promise<string[]> {
  const lines: string[] = []
  const say = (...args: unknown[]): void => {
    lines.push(format(...args))
  }
  const runs: { draws: boolean; label: string }[] = [
    { draws: false, label: 'plain' },
    { draws: true, label: 'drawn' },
  ]

  const rows: { draws: boolean; label: string; samples: Sample[] }[] = []
  // A live run narrates itself; the simulated one is a known quantity and stays
  // quiet unless asked. Same for the line per run, so a turn that never comes back
  // is at least named while it is still out — and named after its model, since two
  // live runs share one terminal.
  const loud = options.live || options.verbose
  for (const { draws, label } of runs) {
    const samples: Sample[] = []
    for (let run = 0; run < options.runs; run += 1) {
      if (loud) console.error('  %s%s run %d …', who, label, run + 1)
      samples.push(await runOnce(draws, make(), model, options.prompt, options.timeoutMs, loud, who))
    }
    rows.push({ draws, label, samples })
  }

  say(
    '\n  %s %s %s %s %s %s %s %s',
    'turn kind'.padEnd(14),
    'run'.padStart(4),
    'requests'.padStart(9),
    'turn'.padStart(9),
    'in model'.padStart(10),
    '1st byte'.padStart(10),
    '1st text'.padStart(10),
    '1st widget'.padStart(11),
  )
  // A line per run, never a column of medians. A model draws in some runs and not
  // others, and a median over a mix of drawing and prose is a number about neither:
  // one put a widget five seconds into a turn that had ended at three.
  for (const row of rows) {
    row.samples.forEach((sample, index) => {
      // A cut-off run has no turn time of its own — it has the clock's. Marked, so
      // `60.00s` is never read as "the tool takes a minute" when it was the bench that
      // stopped it, which is the reading a bare number in a time column invites.
      const cut = sample.timedOut ? '>' : ''
      say(
        '  %s %s %s %s %s %s %s %s',
        row.label.padEnd(14),
        String(index + 1).padStart(4),
        String(sample.requests).padStart(9),
        `${cut}${ms(sample.turnMs)}`.padStart(9),
        `${cut}${ms(sample.modelMs)}`.padStart(10),
        ms(sample.byteMs).padStart(10),
        ms(sample.textMs).padStart(10),
        ms(sample.widgetMs).padStart(11),
      )
    })
  }

  for (const row of rows) {
    // Only the drawing row is reported on: prose is meant not to draw, so listing
    // every plain run as one that wrote no fence would be a column of noise.
    if (!row.draws) continue
    const drew = row.samples.filter(usable).length
    say('\n  %s: %d of %d runs finished a drawing turn.', row.label, drew, row.samples.length)
    row.samples.forEach((sample, index) => {
      if (usable(sample)) return
      say('    run %d — %d request%s: %s', index + 1, sample.requests, sample.requests === 1 ? '' : 's', whyNot(sample))
      // The tree the model actually wrote, which is the only way to fix a teaching
      // that did not take: the words say what it tried.
      if (sample.block) for (const line of sample.block.split('\n')) say('      | %s', line)
    })
  }

  const drawn = rows.find((row) => row.draws)
  const plain = rows.find((row) => !row.draws)
  const cleanEveryTime = (row: typeof drawn): boolean => row?.samples.every(usable) ?? false
  const turnOf = (row: typeof drawn): number => median((row?.samples ?? []).map((sample) => sample.turnMs))
  const requestsOf = (row: typeof drawn): number => Math.max(...(row?.samples ?? []).map((sample) => sample.requests), 0)
  const spreadOf = (row: typeof drawn): number => Math.max(...(row?.samples ?? []).map((sample) => sample.turnMs)) - Math.min(...(row?.samples ?? []).map((sample) => sample.turnMs))

  if (!cleanEveryTime(drawn)) {
    say('\n  Read the request count here, not the clock: a run that drew nothing answered in')
    say('  prose, its time is an ordinary answer\'s, and a run the clock cut off was still')
    say('  going. The columns are comparable within a row — one line, one turn — and the')
    say('  count is the part that holds either way.')
    return lines
  }

  // Everything below is measured across all the runs, which only reach here when
  // every one of them drew: a row that mixed drawing with prose has returned above,
  // where a mean over the two would have been a number about neither.
  say('\n  Drawing cost the wire %d request%s, against prose\'s %d: the widget is written inside', requestsOf(drawn), requestsOf(drawn) === 1 ? '' : 's', requestsOf(plain))
  say('  the answer the model was already giving, so it buys no round trip of its own — which')
  say('  is the whole of what this was asking. What is left is the clock, and the tree\'s own')
  say('  tokens are the only thing in it: %s drawn against %s in prose here, %s apart.', ms(turnOf(drawn)), ms(turnOf(plain)), ms(Math.abs(turnOf(drawn) - turnOf(plain))))
  // A live provider answers the same question in a range that has nothing to do with
  // the drawing — a reasoning model thinks for a while before it types. When that
  // range is wider than the difference being measured, the clock has not answered the
  // question: three runs have measured the model's mood. Said out loud, because a
  // few hundred milliseconds read off numbers like these is a coincidence, not a result.
  const widest = Math.max(spreadOf(plain), spreadOf(drawn))
  const apart = Math.abs(turnOf(drawn) - turnOf(plain))
  if (widest > apart) {
    say('  The clock, though, is the provider\'s: the widest swing across these runs is')
    say('  %s, wider than the %s between the two runs — the model\'s mood, not the widget.', ms(widest), ms(apart))
    say('  More runs pin the clock down; the request count needs none.')
  }
  return lines
}

/** The tail of a model id, which is what tells two of them apart on one line. */
const shortModel = (model: string): string => model.slice(model.lastIndexOf('/') + 1).replace(/:free$/, '')

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))

  if (!options.live) {
    console.log('\ngenerated interface — what the widget costs a turn')
    console.log('  (the model is simulated: %sms before the first token, %sms per chunk%s; %s)',
      options.latencyMs, options.chunkMs, options.jitterMs > 0 ? `, up to ${options.jitterMs}ms of jitter` : '', options.runs === 1 ? '1 run' : `${options.runs} runs`)
    const lines = await bench(options, () => new SimProvider(options.latencyMs, options.chunkMs, options.decline, options.jitterMs), 'bench-model', '')
    console.log(lines.join('\n'))
    return
  }

  const { loadConfig, readAuth, resolveProvider } = await import('../src/core/config/load.js')
  const { findPreset } = await import('../src/core/config/presets.js')
  const { createProvider } = await import('../src/core/providers/create.js')
  const loaded = loadConfig()
  if (!loaded) {
    console.error('\nNo configuration found — run `milo setup` first, or use the simulated run.')
    process.exit(1)
  }

  console.log('\ngenerated interface — what the widget costs a turn')
  const runs = options.runs === 1 ? '1 run' : `${options.runs} runs`

  if (options.against.length === 0) {
    const model = loaded.model
    console.log('  (a real turn against %s/%s, %s — the spread is the provider, not the design)', loaded.provider.id, model, runs)
    const lines = await bench(options, () => createProvider(loaded.provider, model), model, '')
    console.log(lines.join('\n'))
    return
  }

  // Each pair resolved on its own, with its own key: `resolveProvider` is the same
  // function the app opens a provider with, so a model benched here is the model the
  // app would talk to. A pair that cannot be built stops the run rather than quietly
  // measuring something else, and an unconfigured id is answered with the configured
  // ones instead of a guess.
  const auth = readAuth()
  const pairs = options.against.map((spec) => {
    const provider = resolveProvider(loaded.config, auth, spec.providerId)
    if (!provider) {
      console.error('\n`%s` is not a provider this install has. Configured: %s.',
        spec.providerId, Object.keys(loaded.config.providers).join(', ') || 'none')
      process.exit(1)
    }
    if (spec.model) return { provider, model: spec.model, why: undefined }
    if (spec.providerId === loaded.config.provider) return { provider, model: loaded.model, why: 'the model the config is on' }
    const preset = findPreset(spec.providerId)?.models[0]
    if (!preset) {
      console.error('\n`%s` has no model to run: name one as `--against %s:<model>`.', spec.providerId, spec.providerId)
      process.exit(1)
    }
    return { provider, model: preset, why: 'the first model of its preset' }
  })

  for (const { provider, model, why } of pairs) {
    console.log('  (a real turn against %s/%s%s, %s)', provider.id, model, why ? ` — ${why}` : '', runs)
  }
  // Both at once, because the wait is the provider thinking and two providers think
  // independently: different keys, different rate limits, neither one the other's
  // throttle. What they do share is this machine and the clock, which is why each
  // report still stands on its own columns and never across them.
  const measured = await Promise.all(pairs.map(async ({ provider, model }) => ({
    label: `${provider.id} — ${model}`,
    lines: await bench(options, () => createProvider(provider, model), model, `${shortModel(model)} `),
  })))
  for (const { label, lines } of measured) {
    console.log('\n\n  %s\n  %s', label, '─'.repeat(label.length))
    console.log(lines.join('\n'))
  }
}

await main()
