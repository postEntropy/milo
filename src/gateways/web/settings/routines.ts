import type { AgentRuntime } from '../../../core/runtime.js'
import {
  addRoutine, describeSchedule, describeTarget, findRoutine, isSpent, parseWhen,
  readRoutines, remainingRuns, removeRoutineWithRuns, ROUTINE_GATEWAY, ROUTINE_GATEWAYS,
  runRoutineOnce, setEnabled, SILENT_NOTE, type Routine, type RoutineGateway, type RoutineTarget,
} from '../../../core/routines.js'
import { readDisplay } from '../../../core/config/load.js'
import { transcriptOf, type RegisterFile } from '../transcript.js'
import { sessionId } from './input.js'
import { optionalText } from './input.js'
import type { Message } from '../../../core/providers/types.js'
import { SILENT } from '../../../core/silent.js'

const FEED_LIMIT = 20
const QUIET_RUN = 'Nothing to report.'
const UPCOMING_RUNS = 5

export class WebRoutineSettings {
  constructor(
    private readonly runtime: AgentRuntime,
    private readonly files?: { register: RegisterFile },
  ) {}

  listRoutines(): unknown {
    return readRoutines().map((routine) => this.routineView(routine))
  }

  /**
   * The most recent runs across every routine, newest first — a timeline of what
   * the routines have said, mixed together rather than read one routine at a time.
   */
  async routineFeed(): Promise<unknown> {
    const runs: Array<{ routine: Routine; id: string; at: number }> = []
    for (const routine of readRoutines()) {
      for (const run of (await this.runtime.listRuns(routine.id)).slice(0, FEED_LIMIT)) {
        runs.push({ routine, id: run.id, at: run.updatedAt })
      }
    }
    const recent = runs.sort((a, b) => b.at - a.at).slice(0, FEED_LIMIT)
    return Promise.all(recent.map(async (entry) => ({
      id: entry.routine.id,
      runId: entry.id,
      routine: entry.routine.name ?? entry.routine.prompt,
      at: entry.at,
      answer: await this.runText(entry.id),
    })))
  }

  /**
   * The words a run answered with, flattened and cut for a one-line gist. What the
   * run was asked is not one of them: the prompt is its routine's own, said on the
   * routine's page, so a gist that led with it would say the ask and not the answer.
   */
  private async runText(runId: string): Promise<string> {
    const record = await this.runtime.loadSession(runId)
    if (!record) return ''
    const text = record.messages
      .filter((message) => message.role === 'assistant')
      .flatMap((message) => message.content)
      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    // A silent run's marker is what it said to the model, not to the person: the
    // gist is what it meant — the run happened and had nothing to report.
    if (this.quietRun(record) && text === SILENT) return QUIET_RUN
    return text.slice(0, 200)
  }

  async addRoutine(body: Record<string, unknown>): Promise<unknown> {
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
    if (!prompt) throw new Error('A prompt is required.')
    const when = parseWhen({
      every: optionalText(body.every),
      at: optionalText(body.at),
      days: stringList(body.days),
      dayOfMonth: stringList(body.dayOfMonth),
      month: stringList(body.month),
    })
    if (!when) throw new Error('Set a time: an interval like "2h", or a clock time like "08:00" with optional days, a day of the month, or a month.')
    const allow = stringList(body.allow)
    const routine = await addRoutine({
      prompt,
      name: optionalText(body.name),
      when,
      target: routineTarget(body.target),
      allow: allow && allow.length > 0 ? allow : undefined,
      silent: body.silent === true ? true : undefined,
      enabled: true,
    })
    return { routine: this.routineView(routine) }
  }

  async removeRoutine(body: Record<string, unknown>): Promise<unknown> {
    const id = optionalText(body.id)
    if (!id || !(await removeRoutineWithRuns(this.runtime, id))) throw new Error('No routine with that id.')
    return { removed: true }
  }

  async enableRoutine(body: Record<string, unknown>): Promise<unknown> {
    const id = optionalText(body.id)
    if (!id) throw new Error('A routine id is required.')
    const enabled = body.enabled !== false
    if (!(await setEnabled(id, enabled))) throw new Error('No routine with that id.')
    return { id, enabled }
  }

  /**
   * Fires one now and answers with what it said, and with the id of the run it
   * just made — so the surface can open the run rather than draw the answer a
   * second way. It does not deliver: the chat would get it twice.
   */
  async runRoutine(body: Record<string, unknown>): Promise<unknown> {
    const id = optionalText(body.id)
    if (!id) throw new Error('A routine id is required.')
    const routine = findRoutine(id)
    if (!routine) throw new Error('No routine with that id.')
    const { id: runId, answer, failure } = await runRoutineOnce(this.runtime, routine)
    return { ...(runId ? { runId } : {}), answer, failure }
  }

  /**
   * What a routine has produced, newest first, a page at a time. The runs are
   * kept for good now, so the surface asks for more as it scrolls rather than
   * being handed a history nobody bounded.
   */
  async routineRuns(body: Record<string, unknown>): Promise<unknown> {
    const id = optionalText(body.id)
    if (!id) throw new Error('A routine id is required.')
    if (!findRoutine(id)) throw new Error('No routine with that id.')
    const all = await this.runtime.listRuns(id)
    const offset = typeof body.offset === 'number' && body.offset > 0 ? Math.floor(body.offset) : 0
    const limit = typeof body.limit === 'number' && body.limit > 0 ? Math.min(Math.floor(body.limit), 100) : 20
    return {
      total: all.length,
      runs: all.slice(offset, offset + limit).map((run) => ({ id: run.id, at: run.updatedAt })),
    }
  }

  /**
   * One run as the page draws a conversation. Read-only: it binds nothing and
   * takes no lease, so opening a past run does not take the conversation over
   * from whoever is in it.
   *
   * A run opens on the routine's own prompt, and the page a run is read on says
   * that prompt above it already — so the run is drawn from the prompt onwards:
   * what it answered, not the ask said a second time. Only the opening message
   * goes; a later word in a run would be something that happened in it.
   */
  async runTranscript(body: Record<string, unknown>): Promise<unknown> {
    const record = await this.runtime.loadSession(sessionId(body.id))
    if (!record) throw new Error('No such run.')
    // A run that delivered a file is only drawable where the files can be
    // served; said rather than dropped, so a picture never vanishes from a run.
    const register = this.files?.register ?? ((file: { name: string }) => {
      throw new Error(`Serving ${file.name} needs the web server's file registry.`)
    })
    const [opening, ...answered] = record.messages
    const messages = opening?.role === 'user' ? answered : record.messages
    // A run that stayed quiet answered the marker; the page draws what it meant,
    // because the marker is not a word anyone reads.
    const shown = this.quietRun(record) ? quieted(messages) : messages
    return transcriptOf(shown, register, readDisplay().tools)
  }

  /**
   * Whether this run belongs to a routine that may stay quiet, read from the run's
   * own scope rather than from a request: a routine removed since leaves its runs
   * behind, and they are not quiet.
   */
  private quietRun(record: { scope?: { gateway: string; chatId: string } }): boolean {
    const scope = record.scope
    return scope?.gateway === ROUTINE_GATEWAY && findRoutine(scope.chatId)?.silent === true
  }

  private routineView(routine: Routine): Record<string, unknown> {
    const now = new Date()
    // What is still coming, read once from the one place that knows the ceiling: a
    // routine that has run out has no next time, and a surface that reminded on one
    // would be reminding for something that will never happen again.
    const upcoming = routine.enabled ? remainingRuns(routine, now, UPCOMING_RUNS) : []
    return {
      ...routine,
      whenLabel: describeSchedule(routine),
      targetLabel: describeTarget(routine.target),
      nextRunAt: upcoming[0]?.getTime() ?? null,
      nextRuns: upcoming.map((at) => at.getTime()),
      // Stopped because its own ceiling ran out, which is not the person pausing it:
      // the surfaces say which one it is, and this is the daemon saying it once.
      finished: isSpent(routine),
      // Whether a run may answer nothing, in the daemon's words — the same ones the
      // CLI and the agent's list use, so no surface writes the note itself.
      silentLabel: routine.silent ? SILENT_NOTE : null,
    }
  }

}

/**
 * A silent run's marker, drawn as what it means. Only a whole message is the
 * marker: prose before a tool call is something the run said, and stays.
 */
function quieted(messages: Message[]): Message[] {
  return messages.map((message) => {
    if (message.role !== 'assistant') return message
    return {
      ...message,
      content: message.content.map((part) =>
        part.type === 'text' && part.text.trim() === SILENT ? { ...part, text: QUIET_RUN } : part,
      ),
    }
  })
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
}

function routineTarget(value: unknown): RoutineTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('A destination is required.')
  const target = value as Record<string, unknown>
  if (target.gateway === 'none') return { gateway: 'none' }
  const gateway = String(target.gateway ?? '')
  if (!(ROUTINE_GATEWAYS as readonly string[]).includes(gateway)) {
    throw new Error(`The destination must be one of ${ROUTINE_GATEWAYS.join(', ')}, or none.`)
  }
  const chatId = optionalText(target.chatId)
  if (!chatId) throw new Error('The destination needs a chat id.')
  return { gateway: gateway as RoutineGateway, chatId }
}
