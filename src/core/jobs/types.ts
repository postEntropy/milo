import type { MemoryScope } from '../memory/types.js'

/**
 * Where a job is in its life. `interrupted` is a job a dead Milo left behind:
 * the process that owned it is gone, and saying `running` would be a lie the
 * surface could never resolve.
 */
export type JobState = 'running' | 'done' | 'error' | 'killed' | 'interrupted'

/**
 * Who is told when a job ends, from what the person said when it was started:
 * `always` when they asked to be told, `never` when they asked not to, and
 * `auto` (the default) when they did not say — Milo decides then, with the
 * conversation in front of it.
 */
export type JobNotify = 'auto' | 'always' | 'never'

export interface JobStartInput {
  command: string
  cwd: string
  /** The conversation to tell when it ends. */
  origin: MemoryScope
  notify?: JobNotify
}

/** What is written to disk about a job, and what survives a restart. */
export interface JobMeta {
  id: string
  command: string
  cwd: string
  notify: JobNotify
  origin: MemoryScope
  state: JobState
  startedAt: number
  endedAt?: number
  exitCode?: number
}

/** A job as anything outside the manager reads it — the prompt, a surface, a tool. */
export interface JobInfo extends JobMeta {
  /** Where the full output was written, 0600. */
  logPath: string
  /** The tail of the output, oldest first. */
  lines: string[]
}

/** The jobs as the system prompt describes them: the live state of what is running. */
export interface JobFacts {
  jobs: JobInfo[]
}

/** A job that started, or the reason it did not. */
export type JobStartResult = { ok: true; job: JobInfo } | { ok: false; error: string }
