import { errorMessage } from '../../util/errors.js'
import { logWarn } from '../../util/log.js'
import { formatDuration } from '../../util/format.js'
import type { OutgoingFile } from '../outgoing.js'
import type { AgentRuntime } from '../runtime.js'
import type { Session } from '../session.js'
import type { JobInfo } from './types.js'

/** What Milo answers with when waking up would only add noise, so nothing is said. */
export const JOB_SILENT = 'SILENT'

/** The instruction the announcement turn runs on: the result is in the transcript. */
export function jobPrompt(job: JobInfo): string {
  const elapsed = formatDuration((job.endedAt ?? Date.now()) - job.startedAt)
  const outcome =
    job.state === 'done'
      ? 'finished'
      : job.state === 'killed'
        ? 'was stopped'
        : `failed (${job.exitCode === undefined ? 'no exit code' : `exit ${job.exitCode}`})`
  const lines = [`[background job ${job.id} ${outcome} after ${elapsed}]`, `Command: ${job.command}`]
  const tail = job.lines.slice(-20)
  if (tail.length > 0) lines.push('Last output:', ...tail)
  // A failure always speaks; a success may be left unsaid when the person did not
  // ask to be told and saying so would only add noise.
  const closing =
    job.state === 'done' && job.notify !== 'always'
      ? `Not a message from the person. Tell them the job ended, in one or two lines, and do the useful thing with the result — send the file it made with \`send_file\` if there is one. If saying anything now would only add noise, reply with exactly ${JOB_SILENT} and nothing else.`
      : 'Not a message from the person. Tell them what happened, in one or two lines, and do the useful thing with the result — send the file it made with `send_file` if there is one.'
  lines.push('', closing)
  return lines.join('\n')
}

/** What a finished job produced for the surface to show. */
export interface JobAnnouncement {
  text: string
  files: OutgoingFile[]
}

/**
 * Runs the announcement turn on a session and hands back what to show. Null when
 * Milo judged there was nothing worth saying — the job's state is on record either
 * way, in `/jobs` and the next turn's prompt.
 */
export async function announceJob(session: Session, job: JobInfo): Promise<JobAnnouncement | null> {
  let text = ''
  for await (const event of session.notify(jobPrompt(job))) {
    if (event.type === 'text-delta') text += event.delta
  }
  const files = session.takeOutgoing()
  const trimmed = text.trim()
  const silenceAllowed = job.state === 'done' && job.notify !== 'always'
  if (silenceAllowed && (trimmed === '' || trimmed === JOB_SILENT)) {
    return files.length > 0 ? { text: '', files } : null
  }
  // A turn that answered SILENT when it should have spoken, or nothing at all,
  // still says the one thing that matters rather than going quiet.
  if (trimmed === '' || trimmed === JOB_SILENT) {
    const what = job.state === 'done' ? 'finished' : job.state === 'killed' ? 'was stopped' : 'failed'
    return { text: `Background job ${job.id} ${what}.`, files }
  }
  return { text: trimmed, files }
}

/** How a finished job reaches whoever is looking at the conversation. */
export type JobDeliver = (job: JobInfo, message: JobAnnouncement) => Promise<void> | void

/**
 * Wires the manager's settled jobs to a short turn that announces each one. Wired
 * by whichever process owns the runtime — `milo serve` for the bots and the web,
 * the CLI for the terminal — because only the owner knows how to show a message
 * there. The policy lives here so the two cannot drift:
 *   - `never` asked not to be told: no turn at all, unless the job failed;
 *   - `always` asked to be told;
 *   - `auto` (the default) lets Milo decide, with the conversation in front of it.
 * A failure always speaks, whatever the wish — nothing fails in silence.
 */
export function attachJobNotifier(runtime: AgentRuntime, deliver: JobDeliver): () => void {
  const jobs = runtime.jobs
  if (!jobs) return () => undefined
  return jobs.onSettled((job) => {
    if (!shouldAnnounce(job)) return
    void announce(runtime, job, deliver)
  })
}

/**
 * Whether a finished job should be announced at all. `never` asks not to be told,
 * but a failure always speaks — nothing fails in silence.
 */
export function shouldAnnounce(job: JobInfo): boolean {
  return job.state === 'error' || job.notify !== 'never'
}

async function announce(runtime: AgentRuntime, job: JobInfo, deliver: JobDeliver): Promise<void> {
  try {
    const session = await runtime.getSession(job.origin)
    const announcement = await announceJob(session, job)
    if (!announcement) return
    await deliver(job, announcement)
  } catch (error) {
    logWarn(`could not announce ${job.id}: ${errorMessage(error)}`)
  }
}
