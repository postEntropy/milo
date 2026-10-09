import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { JobInfo } from '../src/core/jobs/index.js'
import type { AgentRuntime } from '../src/core/runtime.js'
import type { Session } from '../src/core/session.js'
import type { OutgoingFile } from '../src/core/outgoing.js'
import type { ToolContext } from '../src/core/tools/types.js'

// Point the app at a throwaway home *before* the modules that read it load.
const home = mkdtempSync(path.join(tmpdir(), 'milo-jobs-'))
process.env.MILO_HOME = home

const { JobManager, announceJob, attachJobNotifier, jobPrompt, JOB_SILENT } = await import('../src/core/jobs/index.js')
const { buildSystemPrompt } = await import('../src/core/agent/system.js')
const { createJobStatusTool, createJobKillTool } = await import('../src/core/tools/jobs.js')
const { shellTool } = await import('../src/core/tools/shell.js')
const { jobDir, jobMetaFile, jobsDir } = await import('../src/core/config/paths.js')

const origin = { gateway: 'cli', conversationId: 'main' }
const signal = new AbortController().signal
const ctx = (jobs: InstanceType<typeof JobManager>): ToolContext => ({
  cwd: process.cwd(),
  signal,
  jobs,
  origin,
})

const settle = (jobs: InstanceType<typeof JobManager>): Promise<JobInfo> =>
  new Promise((resolve) => jobs.onSettled(resolve))

beforeEach(() => {
  rmSync(jobsDir(), { recursive: true, force: true })
})

describe('JobManager', () => {
  it('starts a command, returns at once, and settles when it ends', async () => {
    const jobs = new JobManager()
    const done = settle(jobs)
    const started = jobs.start({ command: 'echo hello', cwd: process.cwd(), origin })
    expect(started.ok).toBe(true)
    const job = await done
    expect(job.state).toBe('done')
    expect(job.exitCode).toBe(0)
    expect(job.lines.join('\n')).toContain('hello')
    await jobs.close()
  })

  it('keeps the exit code of a command that failed', async () => {
    const jobs = new JobManager()
    const done = settle(jobs)
    jobs.start({ command: 'echo boom >&2; exit 3', cwd: process.cwd(), origin })
    const job = await done
    expect(job.state).toBe('error')
    expect(job.exitCode).toBe(3)
    expect(job.lines.join('\n')).toContain('boom')
    await jobs.close()
  })

  it('stops a running job, and says it was killed rather than failed', async () => {
    const jobs = new JobManager()
    const done = settle(jobs)
    const started = jobs.start({ command: 'sleep 30', cwd: process.cwd(), origin })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    expect(jobs.kill(started.job.id)).toBe(true)
    const job = await done
    expect(job.state).toBe('killed')
    await jobs.close()
  })

  it('refuses to start more than the cap allows', async () => {
    const jobs = new JobManager({ max: 1 })
    expect(jobs.start({ command: 'sleep 30', cwd: process.cwd(), origin }).ok).toBe(true)
    const refused = jobs.start({ command: 'sleep 30', cwd: process.cwd(), origin })
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error).toMatch(/Already running/)
    await jobs.close()
  })

  it('reads a job a dead process left running back as interrupted', () => {
    const id = 'job_1'
    mkdirSync(jobDir(id), { recursive: true })
    writeFileSync(
      jobMetaFile(id),
      JSON.stringify({
        id,
        command: 'sleep 999',
        cwd: '/',
        notify: 'auto',
        origin,
        state: 'running',
        startedAt: Date.now(),
      }),
    )
    const jobs = new JobManager()
    expect(jobs.get(id)?.state).toBe('interrupted')
  })
})

describe('the job tools', () => {
  it('job_status reports a finished job and its tail', async () => {
    const jobs = new JobManager()
    const done = settle(jobs)
    jobs.start({ command: 'echo first; echo second', cwd: process.cwd(), origin })
    const job = await done
    const status = createJobStatusTool(jobs)
    const result = await status.execute({ id: job.id }, ctx(jobs))
    expect(result.content).toContain('done')
    expect(result.content).toContain('second')
    await jobs.close()
  })

  it('job_kill stops a running job', async () => {
    const jobs = new JobManager()
    const started = jobs.start({ command: 'sleep 30', cwd: process.cwd(), origin })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const kill = createJobKillTool(jobs)
    const result = await kill.execute({ id: started.job.id }, ctx(jobs))
    expect(result.content).toContain(`Stopped job ${started.job.id}`)
    await jobs.close()
  })
})

describe('shell_command background', () => {
  it('returns a job id at once and leaves the command running', async () => {
    const jobs = new JobManager()
    const result = await shellTool.execute({ command: 'echo hi', background: true }, ctx(jobs))
    expect(result.content).toMatch(/Started job job_\d+/)
    await jobs.close()
  })

  it('runs in the foreground inside a routine, and says so', async () => {
    const jobs = new JobManager()
    const result = await shellTool.execute(
      { command: 'echo inline', background: true },
      { ...ctx(jobs), origin: { gateway: 'routine', conversationId: 'r1' } },
    )
    expect(result.content).toContain('ran in the foreground')
    expect(result.content).toContain('inline')
    await jobs.close()
  })
})

describe('the jobs line in the system prompt', () => {
  const running: JobInfo = {
    id: 'job_1',
    command: 'yt-dlp https://example.com/v',
    cwd: '/',
    notify: 'auto',
    origin,
    state: 'running',
    startedAt: Date.now() - 65_000,
    logPath: '/l',
    lines: [],
  }
  const prompt = (jobs: JobInfo[]) =>
    buildSystemPrompt({ base: 'x', cwd: '/tmp', provider: 'p', model: 'm', tools: [], memories: [], jobs: { jobs } })

  it('names the running jobs', () => {
    const text = prompt([running])
    expect(text).toContain('Background jobs right now')
    expect(text).toContain('job_1')
    expect(text).toContain('1m 5s')
  })

  it('says nothing when no job is running', () => {
    const text = prompt([{ ...running, state: 'done', endedAt: Date.now(), exitCode: 0 }])
    expect(text).not.toContain('Background jobs right now')
  })
})

describe('the announcement', () => {
  const job = (over: Partial<JobInfo> = {}): JobInfo => ({
    id: 'job_1',
    command: 'yt-dlp https://example.com/v',
    cwd: '/',
    notify: 'auto',
    origin,
    state: 'done',
    startedAt: Date.now() - 5_000,
    endedAt: Date.now(),
    exitCode: 0,
    logPath: '/l',
    lines: ['line one', 'line two'],
    ...over,
  })

  const fakeSession = (reply: string, files: OutgoingFile[] = []): Session =>
    ({
      notify: async function* () {
        yield { type: 'text-delta', delta: reply }
      },
      takeOutgoing: () => files,
    }) as unknown as Session

  it('names the job, its outcome and the tail in the instruction', () => {
    const text = jobPrompt(job())
    expect(text).toContain('job_1')
    expect(text).toContain('finished')
    expect(text).toContain('yt-dlp')
    expect(text).toContain('line two')
  })

  it('offers silence only for a success that was not asked to be told', () => {
    expect(jobPrompt(job({ notify: 'auto' }))).toContain(JOB_SILENT)
    expect(jobPrompt(job({ notify: 'always' }))).not.toContain(JOB_SILENT)
    expect(jobPrompt(job({ state: 'error', exitCode: 1, notify: 'auto' }))).not.toContain(JOB_SILENT)
  })

  it('announces what the turn said', async () => {
    const message = await announceJob(fakeSession('it downloaded'), job())
    expect(message?.text).toBe('it downloaded')
  })

  it('stays silent for an auto success that Milo judged unnecessary', async () => {
    expect(await announceJob(fakeSession(JOB_SILENT), job())).toBeNull()
  })

  it('still says something when it should have spoken', async () => {
    const message = await announceJob(fakeSession(JOB_SILENT), job({ notify: 'always' }))
    expect(message?.text).toContain('job_1')
  })

  it('never tells when the person asked not to — for a success', async () => {
    const jobs = new JobManager()
    let delivered = false
    const runtime = { jobs, getSession: async () => fakeSession('x') } as unknown as AgentRuntime
    attachJobNotifier(runtime, () => {
      delivered = true
    })
    const settled = new Promise<void>((resolve) => jobs.onSettled(() => resolve()))
    jobs.start({ command: 'echo done', cwd: process.cwd(), origin, notify: 'never' })
    await settled
    await new Promise((resolve) => setImmediate(resolve))
    expect(delivered).toBe(false)
    await jobs.close()
  })

  it('tells anyway when a quiet job fails — nothing fails in silence', async () => {
    const jobs = new JobManager()
    const runtime = { jobs, getSession: async () => fakeSession('it broke') } as unknown as AgentRuntime
    const announced = new Promise<string>((resolve) => {
      attachJobNotifier(runtime, (_job, message) => resolve(message.text))
    })
    jobs.start({ command: 'exit 1', cwd: process.cwd(), origin, notify: 'never' })
    expect(await announced).toBe('it broke')
    await jobs.close()
  })
})
