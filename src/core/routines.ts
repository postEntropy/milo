import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import lockfile from 'proper-lockfile'
import { errorMessage } from '../util/errors.js'
import { closeParagraph } from '../util/format.js'
import { writePrivateFile } from '../util/fs.js'
import { logWarn } from '../util/log.js'
import { routinesFile } from './config/paths.js'
import type { OutgoingFile, OutgoingMessage } from './outgoing.js'
import type { AgentRuntime } from './runtime.js'
import { generateNickname } from './sessions/nickname.js'

/** The surfaces a routine can deliver to — ones that receive messages out of band. */
export type RoutineGateway = 'telegram' | 'discord' | 'web'

/** The gateway names a routine's target may carry; one place, so the tool, the CLI and the store agree. */
export const ROUTINE_GATEWAYS: readonly RoutineGateway[] = ['telegram', 'discord', 'web']

/**
 * The gateway name a routine's own run carries. It is not a surface: it is how a
 * conversation no one is sitting at is named, so a session can tell a routine's
 * turn apart from a person's — and refuse to create routines from it.
 */
export const ROUTINE_GATEWAY = 'routine'

/**
 * When a routine fires, in the two shapes its time is ever kept in: an interval
 * measured from the last run, or a wall-clock time on the days, dates and months
 * that allow it. Wall-clock means local time, which is the clock the person
 * reading it is on.
 *
 * The wall-clock shape is the whole of a five-field cron minus the wildcard: the
 * time is the minute and the hour, and it fires on the days of the week (`days`)
 * or the days of the month (`dayOfMonth`) that match, in the months (`month`)
 * that match. The two day fields are mutually exclusive — a schedule counts down
 * the week or down the month, never both.
 */
export type RoutineWhen =
  | { kind: 'every'; minutes: number }
  | { kind: 'at'; time: string; days?: number[]; dayOfMonth?: number[]; month?: number[] }

/**
 * Where a routine's answer goes: a surface that can receive a message out of
 * band, or `none` for one whose runs are only ever read on the Routines screen —
 * a log, not a message.
 */
export type RoutineTarget =
  | { gateway: RoutineGateway; conversationId: string }
  | { gateway: 'none' }

export interface Routine {
  /** `calm-otter-7`, the same shape a session id has. */
  id: string
  /** What a person calls it, and what leads its message in the chat. */
  name?: string
  /** What is sent as the turn's message when it fires. */
  prompt: string
  when: RoutineWhen
  target: RoutineTarget
  /**
   * Tools this routine may use with nobody there to confirm. Approved by the
   * person when it was created — the run itself has no one to ask, so what is not
   * here is refused. Read-only tools are never listed: they never ask anyway.
   */
  allow?: string[]
  enabled: boolean
  createdAt: number
  /** When it last fired, and how that went. Absent until it has. */
  lastRunAt?: number
  lastResult?: 'ok' | 'error'
}

/** The raw input both the CLI and the tool give: what the person said, split up. */
export interface WhenInput {
  /** A duration: `30m`, `2h`, `1d`, or a bare number of minutes. */
  every?: string
  /** A wall-clock time: `08:00`, `8:00` or `8h`. */
  at?: string
  /** Days of the week for `at`: `seg,ter`, `mon-fri`, `1-5`. */
  days?: string[]
  /** Days of the month for `at`: `1`, `15`, `1-15`. Not with `days`. */
  dayOfMonth?: string[]
  /** Months for `at`: numbers or names in either language, `12`, `dec`, `jul-set`. */
  month?: string[]
}

/** What it takes to make a routine, before the store gives it an id and a timestamp. */
export type NewRoutine = Omit<Routine, 'id' | 'createdAt'>

/**
 * A ceiling on the list, so a model that gets creative about "remind me" cannot
 * grow the file without bound. Well past what a person writes by hand.
 */
export const MAX_ROUTINES = 50

/**
 * The farthest a wall-clock schedule is walked to find its next time. A lone
 * `29 February` is the one schedule that can be more than a year out, and its own
 * leap cycle bounds it — a few years covers every schedule the parser accepts.
 */
const AT_WALK_DAYS = 1461

const DURATION = /^(\d+)\s*(s|sec|secs|seg|segs|segundo|segundos|m|min|mins|minuto|minutos|h|hora|horas|d|dia|dias)?$/i
const TIME = /^(\d{1,2}):?(\d{2})?$/

/** How a day is written back to a person. Reads the same in either language. */
const DAY_LABELS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

const DAY_NAMES: Record<string, number> = {
  // Read in either language: what a person types at the CLI is not always the
  // language the display is written in.
  dom: 0, sun: 0, sunday: 0, domingo: 0,
  seg: 1, mon: 1, monday: 1, segunda: 1,
  ter: 2, tue: 2, tues: 2, tuesday: 2, terca: 2,
  qua: 3, wed: 3, wednesday: 3, quarta: 3,
  qui: 4, thu: 4, thur: 4, thurs: 4, thursday: 4, quinta: 4,
  sex: 5, fri: 5, friday: 5, sexta: 5,
  sab: 6, sat: 6, saturday: 6, sabado: 6,
}

/** How a month is written back to a person, in the one language the display uses. */
const MONTH_LABELS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

const MONTH_NAMES: Record<string, number> = {
  // Read in either language, like the days above.
  jan: 1, january: 1, janeiro: 1,
  feb: 2, fev: 2, february: 2, fevereiro: 2,
  mar: 3, march: 3, marco: 3,
  apr: 4, abr: 4, april: 4, abril: 4,
  may: 5, mai: 5, maio: 5,
  jun: 6, june: 6, junho: 6,
  jul: 7, july: 7, julho: 7,
  aug: 8, ago: 8, august: 8, agosto: 8,
  sep: 9, set: 9, september: 9, setembro: 9,
  oct: 10, out: 10, october: 10, outubro: 10,
  nov: 11, november: 11, novembro: 11,
  dec: 12, dez: 12, december: 12, dezembro: 12,
}

/**
 * The days each month can hold, February on its longest (leap) reading: a
 * schedule is checked against the calendar by its most generous month, so a
 * `29` of February is a real date and a `30` is not.
 */
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

/**
 * Turns what the person said — already read and split by the model or parsed off
 * the command line — into the one shape a routine's time is kept in. Null means
 * the sentence did not name a usable time, and the caller asks again rather than
 * guessing: a routine that fires at the wrong hour is worse than one not made.
 */
export function parseWhen(input: WhenInput): RoutineWhen | null {
  if (input.every && input.at) return null
  const hasDays = Boolean(input.days?.length)
  const hasDates = Boolean(input.dayOfMonth?.length || input.month?.length)
  // A date belongs to a clock time; an interval has no day or month to speak of.
  if ((hasDays || hasDates) && !input.at) return null
  // A schedule counts down the week or down the month, never both.
  if (hasDays && input.dayOfMonth?.length) return null

  if (input.at) {
    const time = parseTime(input.at)
    if (!time) return null
    const days = input.days?.length ? parseDays(input.days) : null
    if (input.days?.length && !days) return null
    const dayOfMonth = input.dayOfMonth?.length ? parseNumberRange(input.dayOfMonth, 1, 31) : null
    if (input.dayOfMonth?.length && !dayOfMonth) return null
    const month = input.month?.length ? parseNumberRange(input.month, 1, 12, MONTH_NAMES) : null
    if (input.month?.length && !month) return null
    // A day of the month no month can hold (the 31st of February) never fires:
    // refused here, said out loud, rather than left to a scheduler that would only
    // ever skip it.
    if (!scheduleFits(dayOfMonth ?? undefined, month ?? undefined)) return null
    return {
      kind: 'at',
      time,
      ...(days ? { days } : {}),
      ...(dayOfMonth ? { dayOfMonth } : {}),
      ...(month ? { month } : {}),
    }
  }

  if (input.every) {
    const minutes = parseEvery(input.every)
    return minutes === null ? null : { kind: 'every', minutes }
  }

  return null
}

/**
 * The next time a routine fires, strictly after `from`. Pure, and the whole of
 * the loop's arithmetic: it only compares this against the clock.
 */
export function nextRunAt(when: RoutineWhen, from: Date): Date {
  if (when.kind === 'every') return new Date(from.getTime() + when.minutes * 60_000)

  const hour = Number(when.time.slice(0, 2))
  const minute = Number(when.time.slice(3, 5))

  // At most a few years' walk: every allowed month, day and weekday is within it,
  // so one of these lands. The ceiling is a lone 29 February's own cycle.
  for (let offset = 0; offset <= AT_WALK_DAYS; offset += 1) {
    const candidate = new Date(from)
    candidate.setDate(from.getDate() + offset)
    candidate.setHours(hour, minute, 0, 0)
    if (candidate.getTime() <= from.getTime()) continue
    if (when.days?.length && !when.days.includes(candidate.getDay())) continue
    if (when.dayOfMonth?.length && !when.dayOfMonth.includes(candidate.getDate())) continue
    if (when.month?.length && !when.month.includes(candidate.getMonth() + 1)) continue
    return candidate
  }
  // Unreachable for a schedule `parseWhen` accepted — a guard so this never
  // returns null. The next day at the time, rather than a silently wrong hour.
  const fallback = new Date(from)
  fallback.setDate(from.getDate() + 1)
  fallback.setHours(hour, minute, 0, 0)
  return fallback
}

/** `every 2h`, `08:00, mon-fri`, `09:00, day 25 of December` — the time, said plainly. */
export function describeWhen(when: RoutineWhen): string {
  if (when.kind === 'every') return `every ${describeMinutes(when.minutes)}`
  return `${when.time}, ${describeDayPart(when)}`
}

/** The days, dates or months a wall-clock time fires on, as one phrase. */
function describeDayPart(when: Extract<RoutineWhen, { kind: 'at' }>): string {
  const days = when.days?.length === 7 ? undefined : when.days
  const months = when.month?.length ? describeMonths(when.month) : null
  if (when.dayOfMonth?.length) {
    const dates = `${when.dayOfMonth.length > 1 ? 'days' : 'day'} ${when.dayOfMonth.join(', ')}`
    return months ? `${dates} of ${months}` : `${dates} of every month`
  }
  if (months) {
    return days?.length ? `${describeDays(days)} in ${months}` : `every day in ${months}`
  }
  if (days?.length) return describeDays(days)
  return 'every day'
}

export function describeTarget(target: RoutineTarget): string {
  return target.gateway === 'none' ? 'the Routines screen' : `${target.gateway}:${target.conversationId}`
}

/**
 * A short name for a routine that was not given one: the first words of its
 * prompt, without the trailing punctuation. Every routine has a name because a
 * name is how a person talks about it — "drop the daily briefing" — and how the
 * chat knows which one just spoke.
 */
export function nameFor(prompt: string, max = 42): string {
  const clean = prompt.replace(/\s+/g, ' ').trim().replace(/[.!?;:]+$/, '')
  if (clean.length <= max) return clean
  const cut = clean.slice(0, max)
  const space = cut.lastIndexOf(' ')
  // Cut on a word when there is one near the end; a mid-word break reads worse.
  return `${(space > max * 0.5 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/** `2026-09-26 08:00`, local — how a next run reads in a list. */
export function formatLocal(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function readRoutines(): Routine[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(routinesFile(), 'utf8'))
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isRoutine).map((routine) => ({
      ...routine,
      enabled: routine.enabled !== false,
      allow: Array.isArray(routine.allow)
        ? routine.allow.filter((name) => typeof name === 'string')
        : undefined,
    }))
  } catch {
    // No file yet, or one someone left mid-edit by hand: an empty list beats a
    // daemon that will not start.
    return []
  }
}

/**
 * How long a lock is believed after the process holding it stops refreshing it.
 * A read-modify-write holds it for milliseconds; the holder that dies is the one
 * whose lock this breaks.
 */
const LOCK_STALE_MS = 10_000
/** Write windows are short and rare: waiting is cheaper than losing a change. */
const WRITE_LOCK_RETRIES = { retries: 15, factor: 1.5, minTimeout: 20, maxTimeout: 250, randomize: true }

/**
 * Takes the file's lock, so a read-modify-write is one step across processes.
 * `routines.json` has two writers in different processes — `milo serve` marking
 * a run while `milo routines add` adds one — and each rewrites the whole list
 * from the copy it read, so without the lock the slower writer's copy wins and
 * the other change is gone.
 */
async function lockRoutines(): Promise<() => Promise<void>> {
  // Only the directory has to exist: `realpath: false` locks the path as given,
  // and the lock itself is a directory created beside the file.
  mkdirSync(dirname(routinesFile()), { recursive: true })
  return lockfile.lock(routinesFile(), {
    realpath: false,
    stale: LOCK_STALE_MS,
    retries: WRITE_LOCK_RETRIES,
    // A late write is not a reason to take the process down.
    onCompromised: (error) => logWarn(`lost the lock on routines.json: ${errorMessage(error)}`),
  })
}

function serialize(routines: Routine[]): string {
  return `${JSON.stringify(routines, null, 2)}\n`
}

/** Replaces the whole list, under the lock and through a rename, like every write here. */
export async function writeRoutines(routines: Routine[]): Promise<void> {
  const release = await lockRoutines()
  try {
    await writePrivateFile(routinesFile(), serialize(routines))
  } finally {
    await release()
  }
}

export function findRoutine(id: string): Routine | undefined {
  return readRoutines().find((routine) => routine.id === id)
}

/**
 * The one way the list changes: read, apply `change`, write the result back —
 * all while holding the lock. `next` absent means there was nothing to write.
 */
async function changeRoutines<T>(
  change: (routines: Routine[]) => { result: T; next?: Routine[] },
): Promise<T> {
  const release = await lockRoutines()
  try {
    const routines = readRoutines()
    const outcome = change(routines)
    if (outcome.next) await writePrivateFile(routinesFile(), serialize(outcome.next))
    return outcome.result
  } finally {
    await release()
  }
}

/** Adds a routine and returns it, id and all. Throws when the list is at its ceiling. */
export async function addRoutine(input: NewRoutine): Promise<Routine> {
  return changeRoutines((routines) => {
    if (routines.length >= MAX_ROUTINES) {
      throw new Error(`at most ${MAX_ROUTINES} routines — remove one first`)
    }
    const id = generateNickname((candidate) => routines.some((routine) => routine.id === candidate))
    const routine: Routine = {
      id,
      createdAt: Date.now(),
      ...input,
      // Named here rather than at the surfaces, so every path — the tool, the CLI,
      // a hand-edited file — ends up with a routine a person can refer to by name.
      name: input.name?.trim() || nameFor(input.prompt),
    }
    return { result: routine, next: [...routines, routine] }
  })
}

export async function removeRoutine(id: string): Promise<boolean> {
  return changeRoutines((routines) => {
    const kept = routines.filter((routine) => routine.id !== id)
    if (kept.length === routines.length) return { result: false }
    return { result: true, next: kept }
  })
}

/**
 * Drops a routine and the runs it left behind. A run is only reachable through
 * the routine that produced it — the Runs surface asks for one by id — so once
 * the routine is gone its runs are records nothing can open. They are deleted
 * here rather than left as files no one can see or name.
 */
export async function removeRoutineWithRuns(runtime: AgentRuntime, id: string): Promise<boolean> {
  const runs = await runtime.listRuns(id)
  if (!(await removeRoutine(id))) return false
  for (const run of runs) {
    try {
      await runtime.removeSession(run.id)
    } catch (error) {
      logWarn(`could not remove the run ${run.id} of ${id}: ${errorMessage(error)}`)
    }
  }
  return true
}

export async function setEnabled(id: string, enabled: boolean): Promise<boolean> {
  return changeRoutines((routines) => {
    const target = routines.find((routine) => routine.id === id)
    if (!target) return { result: false }
    target.enabled = enabled
    return { result: true, next: routines }
  })
}

/** Writes down that a routine fired, so a restart does not fire the same minute twice. */
export async function markRun(id: string, result: 'ok' | 'error', at: number): Promise<void> {
  await changeRoutines((routines) => {
    const target = routines.find((routine) => routine.id === id)
    if (!target) return { result: undefined }
    target.lastRunAt = at
    target.lastResult = result
    return { result: undefined, next: routines }
  })
}

export interface RoutineRunResult {
  /**
   * The run's own session — how a caller names the run it just made. Absent when
   * the run failed before a session existed, which is the one failure with
   * nothing on disk behind it.
   */
  id?: string
  /** What it answered, trimmed; empty when it said nothing. */
  answer: string
  /** The failure message, when the run ended in one. */
  failure: string | null
  /** Files the turn asked to send to its target, in the order it named them. */
  files: OutgoingFile[]
}

/**
 * One run of a routine: a turn in a conversation of the routine's own, carrying
 * the grants the person approved and with nobody to ask — a tool that would need
 * confirmation is denied unless it is in `allow`. The turn is new every time: a
 * routine is not a conversation, and yesterday's context would only make today's
 * answer drift.
 *
 * Shared by the timer and by "run it now", so a manual run behaves the way the
 * scheduled one will rather than being a second, differently-permissioned path.
 */
export async function runRoutineOnce(
  runtime: AgentRuntime,
  routine: Routine,
): Promise<RoutineRunResult> {
  const session = await runtime.newSession(
    { gateway: ROUTINE_GATEWAY, conversationId: routine.id },
    routine.name,
    // A run always has somewhere for a file to land: its own record, which the
    // Routines screen draws. A `none` routine posts to no chat, and that is the
    // scheduler's business — but the turn must still be able to produce a file, so
    // the destination named here is the run itself.
    {
      grantedTools: routine.allow,
      deliverTo: routine.target.gateway === 'none'
        ? { gateway: ROUTINE_GATEWAY, conversationId: routine.id }
        : routine.target,
    },
  )
  let answer = ''
  let failure: string | null = null
  for await (const event of session.send(routine.prompt)) {
    if (event.type === 'text-delta') answer += event.delta
    else if (event.type === 'tool-start') {
      answer = closeParagraph(answer)
    }
    else if (event.type === 'error') failure = event.message
  }
  // Read once the turn is done: the files it asked the surfaces to send, which
  // it collected rather than posted — a delivery takes the lease the turn holds.
  const files = session.takeOutgoing()
  // The run's own record keeps what it produced, so the Runs surface shows the
  // picture a run sent and not only the words around it. A failed turn keeps
  // nothing: what it half-produced is not something to hand over, here either.
  if (files.length > 0 && !failure) await session.appendNotice('', files)
  return { id: session.id, answer: answer.trim(), failure, files }
}

export interface RoutineSchedulerOptions {
  runtime: AgentRuntime
  /** Posts a finished run at the routine's target. Injected: the loop knows no gateway. */
  deliver: (routine: Routine, message: OutgoingMessage) => Promise<void>
  /** Told after each run, so a surface showing the history can refresh itself. */
  onRan?: (routine: Routine) => void
  log?: (line: string) => void
  now?: () => Date
  /** The longest the loop will sleep before looking again, so a new routine is seen soon. */
  maxWaitMs?: number
}

const DEFAULT_MAX_WAIT_MS = 60_000

/**
 * The thing that runs a prompt on a timer. There is one, it lives in `milo serve`
 * — the only process that stays up — and it holds no state the file does not:
 * every tick rereads `routines.json`, so a routine the assistant created mid-chat
 * is picked up without a restart, and one removed is dropped just as quietly.
 *
 * A missed occurrence is not made up. A routine the daemon slept through fires at
 * its next time, once, which is what a person means by "every morning" — not a
 * burst of yesterday's mornings the moment it wakes.
 */
export class RoutineScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined
  /** Where each routine has been read up to; in memory, seeded from the wall clock. */
  private readonly cursors = new Map<string, Date>()
  /** Routines mid-run, so one longer than its interval does not overlap itself. */
  private readonly running = new Set<string>()
  /** Those runs, so a caller about to exit can wait them out. */
  private readonly pending = new Set<Promise<void>>()
  private stopped = false
  private readonly now: () => Date
  private readonly maxWaitMs: number

  constructor(private readonly options: RoutineSchedulerOptions) {
    this.now = options.now ?? (() => new Date())
    this.maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS
  }

  start(): void {
    this.stopped = false
    this.arm()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  /** Waits for the runs in flight — the seam for a caller about to exit, or a test. */
  async settle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending])
  }

  /**
   * A single `setTimeout`, re-armed to whichever comes first: the next routine or
   * the ceiling on how long to wait. Re-armed rather than an interval so there is
   * one pending timer at a time and `stop()` always has something to clear.
   */
  private arm(): void {
    if (this.stopped) return
    const wait = Math.max(1_000, Math.min(this.maxWaitMs, this.msUntilNext()))
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.tick()
    }, wait)
    // Never the reason the process stays alive: the gateways are.
    this.timer.unref?.()
  }

  private msUntilNext(): number {
    const now = this.now()
    let soonest = this.maxWaitMs
    for (const routine of readRoutines()) {
      if (!routine.enabled) continue
      const due = nextRunAt(routine.when, this.cursor(routine, now))
      soonest = Math.min(soonest, due.getTime() - now.getTime())
    }
    return soonest
  }

  /** Where a routine is read up to. Seeded from now, never from the past. */
  private cursor(routine: Routine, now: Date): Date {
    const existing = this.cursors.get(routine.id)
    if (existing) return existing
    const seeded = new Date(Math.max(routine.lastRunAt ?? 0, now.getTime()))
    this.cursors.set(routine.id, seeded)
    return seeded
  }

  private async tick(): Promise<void> {
    if (this.stopped) return
    const now = this.now()
    for (const routine of readRoutines()) {
      if (!routine.enabled) continue
      const due = nextRunAt(routine.when, this.cursor(routine, now))
      if (due.getTime() > now.getTime()) continue
      // The occurrence is consumed whether or not it runs: a routine still going
      // from last time is skipped, not queued up behind itself.
      this.cursors.set(routine.id, due)
      if (this.running.has(routine.id)) {
        this.log(`skipped ${routine.id}: the previous run is still going`)
        continue
      }
      this.running.add(routine.id)
      const work = this.fire(routine).finally(() => this.running.delete(routine.id))
      this.pending.add(work)
      void work.finally(() => this.pending.delete(work))
    }
    this.arm()
  }

  /**
   * One run: a turn in a conversation of the routine's own, then its answer posted
   * at the target. The turn is new every time — a routine is not a conversation,
   * and yesterday's context would only make today's answer drift.
   *
   * No `ask` is handed in, so a tool that would need confirmation is denied unless
   * the routine was granted it: there is nobody at the other end of a timer.
   */
  private async fire(routine: Routine): Promise<void> {
    let result: RoutineRunResult
    try {
      result = await runRoutineOnce(this.options.runtime, routine)
    } catch (error) {
      result = { answer: '', failure: errorMessage(error), files: [] }
    }

    try {
      await markRun(routine.id, result.failure ? 'error' : 'ok', this.now().getTime())
    } catch (error) {
      // The run happened; only writing it down did not. Said rather than thrown:
      // an unhandled rejection here would take the daemon down over a late write.
      this.log(`could not record the run of ${routine.id}: ${errorMessage(error)}`)
    }
    if (result.failure) this.log(`routine ${routine.id} failed: ${result.failure}`)

    // A run just happened: a Routines screen that is open wants to know, whether
    // or not the answer went anywhere. A listener that throws is not a reason to
    // fail a run that already happened.
    try { this.options.onRan?.(routine) } catch (error) { this.log(`onRan threw: ${errorMessage(error)}`) }

    // A routine that delivers nowhere is a log, not a message: its run is already
    // on the Routines screen, and there is no chat waiting to be posted into.
    if (routine.target.gateway === 'none') return

    // The routine's name leads its message, so a chat with several of them can
    // tell at a glance which one just spoke.
    const name = routine.name ?? routine.id
    const text = result.failure
      ? `⚠ routine "${name}" failed: ${result.failure}`
      : result.answer
        ? `${name}\n\n${result.answer}`
        : ''
    // Files go even when there is nothing to say: a routine whose whole job is a
    // picture has no answer to lead with. A failed turn sends no files with its
    // error — what it half-produced is not something to hand over.
    const files = result.failure ? [] : result.files
    if (!text && files.length === 0) return
    try {
      await this.options.deliver(routine, {
        ...(text ? { text } : {}),
        ...(files.length > 0 ? { files } : {}),
      })
    } catch (error) {
      this.log(`could not deliver ${routine.id}: ${errorMessage(error)}`)
    }
  }

  private log(line: string): void {
    ;(this.options.log ?? console.error)(line)
  }
}

function parseEvery(value: string): number | null {
  const match = DURATION.exec(value.trim())
  if (!match) return null
  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount < 1) return null
  const unit = (match[2] ?? 'm').toLowerCase()
  if (unit.startsWith('d')) return amount * 1440
  if (unit.startsWith('h')) return amount * 60
  // Seconds are kept as a fraction of a minute: the one shape a routine's time is
  // ever held in, so nothing downstream has to learn a second unit.
  if (unit.startsWith('s')) return amount / 60
  return amount
}

function parseTime(value: string): string | null {
  const cleaned = value.trim().toLowerCase().replace('h', ':')
  const match = TIME.exec(cleaned)
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2] ?? 0)
  if (hour > 23 || minute > 59) return null
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function parseDays(tokens: string[]): number[] | null {
  const days = new Set<number>()
  for (const raw of tokens) {
    const token = normalize(raw)
    if (!token) continue
    const [start, end] = token.split('-')
    if (end !== undefined) {
      const from = dayOf(start!)
      const to = dayOf(end)
      if (from === undefined || to === undefined) return null
      for (let day = from; ; day = (day + 1) % 7) {
        days.add(day)
        if (day === to) break
      }
      continue
    }
    const single = dayOf(token)
    if (single === undefined) return null
    days.add(single)
  }
  return days.size > 0 ? [...days].sort((a, b) => a - b) : null
}

/**
 * Reads a list of numbers and ranges — `1`, `15`, `1-15` — bounded to a field's
 * own range, with names for the month field. Mirrors `parseDays`, minus the
 * weekend wrap a weekday range needs and a calendar field never does.
 */
function parseNumberRange(
  tokens: string[],
  min: number,
  max: number,
  names?: Record<string, number>,
): number[] | null {
  const values = new Set<number>()
  for (const raw of tokens) {
    const token = normalize(raw)
    if (!token) continue
    const [start, end] = token.split('-')
    if (end !== undefined) {
      const from = numberFor(start!, min, max, names)
      const to = numberFor(end, min, max, names)
      if (from === undefined || to === undefined || from > to) return null
      for (let value = from; value <= to; value += 1) values.add(value)
      continue
    }
    const single = numberFor(token, min, max, names)
    if (single === undefined) return null
    values.add(single)
  }
  return values.size > 0 ? [...values].sort((a, b) => a - b) : null
}

function numberFor(token: string, min: number, max: number, names?: Record<string, number>): number | undefined {
  const value = Number(token)
  if (Number.isInteger(value) && value >= min && value <= max) return value
  return names?.[token]
}

/**
 * Whether a day of the month and a month can ever meet. Nothing to check when
 * there is no date; otherwise one (month, day) pair has to exist in a real
 * calendar — the 29th of February does, the 31st of February does not.
 */
function scheduleFits(dayOfMonth: number[] | undefined, month: number[] | undefined): boolean {
  if (!dayOfMonth) return true
  const months = month?.length ? month : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
  return months.some((entry) => dayOfMonth.some((day) => day <= DAYS_IN_MONTH[entry - 1]!))
}

function dayOf(token: string): number | undefined {
  const numeric = Number(token)
  if (Number.isInteger(numeric) && numeric >= 0 && numeric <= 6) return numeric
  return DAY_NAMES[token]
}

function normalize(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
}

function describeMinutes(minutes: number): string {
  if (minutes % 1 !== 0) return `${Math.round(minutes * 60)}s`
  if (minutes % 1440 === 0) return `${minutes / 1440}d`
  if (minutes % 60 === 0) return `${minutes / 60}h`
  return `${minutes}m`
}

function describeDays(days: number[]): string {
  const sorted = [...days].sort((a, b) => a - b)
  const run = sorted.every((day, index) => index === 0 || day === sorted[index - 1]! + 1)
  if (run && sorted.length > 2) return `${DAY_LABELS[sorted[0]!]}–${DAY_LABELS[sorted.at(-1)!]}`
  return sorted.map((day) => DAY_LABELS[day]!).join(', ')
}

function describeMonths(months: number[]): string {
  return [...months].sort((a, b) => a - b).map((month) => MONTH_LABELS[month - 1]!).join(', ')
}

function isRoutine(value: unknown): value is Routine {
  if (!value || typeof value !== 'object') return false
  const routine = value as Record<string, unknown>
  return (
    typeof routine.id === 'string' &&
    typeof routine.prompt === 'string' &&
    routine.prompt.length > 0 &&
    isWhen(routine.when) &&
    isTarget(routine.target)
  )
}

function isWhen(value: unknown): value is RoutineWhen {
  if (!value || typeof value !== 'object') return false
  const when = value as Record<string, unknown>
  if (when.kind === 'every') return typeof when.minutes === 'number' && when.minutes > 0
  if (when.kind !== 'at') return false
  if (typeof when.time !== 'string' || !/^\d{2}:\d{2}$/.test(when.time)) return false
  if (!isNumberList(when.days, 0, 6)) return false
  if (!isNumberList(when.dayOfMonth, 1, 31)) return false
  if (!isNumberList(when.month, 1, 12)) return false
  const days = Array.isArray(when.days) ? (when.days as number[]) : undefined
  const dayOfMonth = Array.isArray(when.dayOfMonth) ? (when.dayOfMonth as number[]) : undefined
  const month = Array.isArray(when.month) ? (when.month as number[]) : undefined
  // A file edited by hand gets the same rules the parser keeps: one day field,
  // and a date its month can actually hold.
  if (days?.length && dayOfMonth?.length) return false
  return scheduleFits(dayOfMonth, month)
}

/** A field is either absent, or a non-empty list of whole numbers in its range. */
function isNumberList(value: unknown, min: number, max: number): boolean {
  if (value === undefined) return true
  if (!Array.isArray(value) || value.length === 0) return false
  return value.every((item) => typeof item === 'number' && Number.isInteger(item) && item >= min && item <= max)
}

function isTarget(value: unknown): value is RoutineTarget {
  if (!value || typeof value !== 'object') return false
  const target = value as Record<string, unknown>
  if (target.gateway === 'none') return true
  return (
    ROUTINE_GATEWAYS.includes(target.gateway as RoutineGateway) &&
    typeof target.conversationId === 'string' &&
    target.conversationId.length > 0
  )
}
