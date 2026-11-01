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
  /** The command as a person reads it back in `/jobs`, and the line the prompt shows. */
  command: string
  cwd: string
  /**
   * How the command is started, when `/bin/sh -c command` is not it. A command
   * that must stay inside the shell sandbox is `bwrap …` — a file and its
   * arguments — and the manager spawns what it is told rather than rebuilding a
   * box out of a string. `command` stays the readable line either way.
   */
  spawn?: { file: string; args: string[] }
  /** What the child sees; absent is this process's own environment. */
  env?: NodeJS.ProcessEnv
  /** The conversation to tell when it ends. */
  origin: MemoryScope
  /**
   * The session that started it. A job belongs to that session: its strip is drawn
   * only there, and only there may it be stopped. Absent on a job started with no
   * session behind it — the terminal's own bootstrap, a bare test.
   */
  sessionId?: string
  notify?: JobNotify
}

/** What is written to disk about a job, and what survives a restart. */
export interface JobMeta {
  id: string
  command: string
  cwd: string
  notify: JobNotify
  origin: MemoryScope
  /** The session that started it; see `JobStartInput`. Absent on an older record. */
  sessionId?: string
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
