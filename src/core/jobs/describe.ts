import { formatDuration } from '../../util/format.js'
import type { JobInfo } from './types.js'

/** `running 2m 10s`, or `done (exit 0) after 5s` — the state and how long. */
export function jobStateLabel(job: JobInfo): string {
  const elapsed = formatDuration((job.endedAt ?? Date.now()) - job.startedAt)
  if (job.state === 'running') return `running ${elapsed}`
  const code = job.exitCode === undefined ? '' : ` (exit ${job.exitCode})`
  return `${job.state}${code} after ${elapsed}`
}

/** A job as one line: the id, what it is doing, and the command. */
export function jobSummary(job: JobInfo): string {
  return `${job.id} — ${jobStateLabel(job)} · ${oneLine(job.command)}`
}

/** A job with the tail of its output under it. */
export function describeJob(job: JobInfo, maxLines = 8): string {
  const head = `${job.id} — ${jobStateLabel(job)}\n  ${job.command}`
  const tail = job.lines.slice(-maxLines)
  return tail.length > 0 ? `${head}\n${tail.join('\n')}` : head
}

/** A command as one line: whitespace flattened and clipped. */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 100 ? `${flat.slice(0, 97)}…` : flat
}
