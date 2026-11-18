import { errorMessage } from '../util/errors.js'
import { formatPriorReports } from './crew.js'
import type { OutgoingMessage } from './outgoing.js'
import { runRoutineOnce, type Routine, type RoutineRunResult } from './routines.js'
import type { AgentRuntime } from './runtime.js'
import type { DelegatedWork, DelegatedWorkStore } from './delegated-work.js'

/** Runs queued work once, or on its schedule, in the daemon that owns the gateways. */
export class DelegatedScheduler {
  private timer: ReturnType<typeof setInterval> | undefined
  private readonly running = new Set<string>()
  private readonly pending = new Set<Promise<void>>()
  private ticking = false
  private stopped = true

  constructor(private readonly options: {
    store: DelegatedWorkStore
    runtime: AgentRuntime
    deliver: (work: DelegatedWork, message: OutgoingMessage) => Promise<void>
    onChanged?: () => void
    log: (message: string) => void
    now?: () => number
  }) {}

  private now(): number { return this.options.now?.() ?? Date.now() }

  async start(): Promise<void> {
    if (!this.stopped) return
    await this.options.store.recover(this.now())
    this.stopped = false
    await this.tick()
    this.timer = setInterval(() => { void this.tick() }, 1000)
    this.timer.unref?.()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  async settle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending])
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.ticking) return
    this.ticking = true
    try {
      const now = this.now()
      for (const work of this.options.store.list()) {
        if (this.stopped) break
        if (this.running.has(work.id)) continue
        if (work.state !== 'queued' && !(work.state === 'waiting' && work.nextAt !== undefined && work.nextAt <= now)) continue
        const claimed = await this.options.store.claim(work.id, now)
        if (!claimed) continue
        if (this.stopped) {
          await this.options.store.finish(claimed.work.id, claimed.run.id, { report: '', failure: 'The scheduler stopped before starting this run.' }, this.now()).catch(() => undefined)
          break
        }
        this.running.add(work.id)
        this.options.onChanged?.()
        const pending = this.fire(claimed.work, claimed.run.id)
          .catch((error) => this.options.log(`Delegated work ${work.id} failed: ${errorMessage(error)}`))
          .finally(() => {
            this.running.delete(work.id)
            this.options.onChanged?.()
          })
        this.pending.add(pending)
        void pending.finally(() => this.pending.delete(pending))
      }
    } catch (error) {
      this.options.log(`Could not schedule delegated work: ${errorMessage(error)}`)
    } finally { this.ticking = false }
  }

  private async fire(work: DelegatedWork, runId: string): Promise<void> {
    if (this.stopped || work.state === 'cancelled') {
      await this.options.store.finish(work.id, runId, { report: '', failure: 'The work was cancelled before starting.' }, this.now()).catch(() => undefined)
      return
    }
    const stop = new AbortController()
    let monitorError: string | undefined
    const monitor = setInterval(() => {
      try {
        if (this.stopped) { stop.abort(); return }
        const current = this.options.store.list().find((item) => item.id === work.id)
        if (!current) throw new Error('The work disappeared.')
        if (current.state === 'cancelled') stop.abort()
      } catch (error) { monitorError = errorMessage(error); stop.abort() }
    }, 250)
    monitor.unref?.()
    const prior = formatPriorReports(
      work.runs.slice(0, -1).map((run) => (!run.failure ? run.report : undefined)),
      'Previous reports from this work:',
    )
    const routine: Routine = {
      id: work.id, name: work.name,
      prompt: `${work.objective}${prior ? `\n\n${prior}` : ''}`,
      when: work.schedule ?? { kind: 'every', minutes: 1 }, target: work.target,
      allow: work.allow, enabled: true, createdAt: work.createdAt,
    }
    let result: RoutineRunResult
    try { result = await runRoutineOnce(this.options.runtime, routine, { signal: stop.signal, project: work.project, strictGrants: true, strictProject: Boolean(work.project) }) }
    catch (error) { result = { answer: '', failure: errorMessage(error), files: [] } }
    finally { clearInterval(monitor) }
    if (monitorError) result.failure = `Could not monitor the work: ${monitorError}`
    let completed: DelegatedWork
    try {
      completed = await this.options.store.finish(work.id, runId, { sessionId: result.id, report: result.answer, failure: result.failure ?? undefined }, this.now())
    } catch (error) {
      this.options.log(`Could not record delegated work ${work.id}: ${errorMessage(error)}`)
      return
    }
    if (completed.state === 'cancelled' || work.target.gateway === 'none') return
    const text = result.failure ? `${work.name} failed: ${result.failure}` : result.answer
    const files = result.failure ? [] : result.files
    if (!text && files.length === 0) return
    try { await this.options.deliver(work, { ...(text ? { text } : {}), ...(files.length ? { files } : {}) }) }
    catch (error) {
      const message = errorMessage(error)
      this.options.log(`Could not deliver delegated work ${work.id}: ${message}`)
      try { await this.options.store.deliveryFailed(work.id, runId, message) }
      catch (recordError) { this.options.log(`Could not record delivery failure: ${errorMessage(recordError)}`) }
    }
  }
}
