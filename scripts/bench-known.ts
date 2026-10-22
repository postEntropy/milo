#!/usr/bin/env node
/**
 * Aider polyglot through Milo: one turn per exercise, the real tools, a real model.
 *
 *   npm run bench:known -- --against commandcode:minimax/minimax-m3.1-flash:free --limit 10
 *   npm run bench:known -- --limit 1 --keep          # one exercise, keep the folder
 *
 * The exercise is copied to a temp folder without `.meta` (the reference solution)
 * and `.docs` (the instructions, which go into the task instead). The agent edits
 * the solution files; the original tests are restored before they run, so editing
 * a test cannot buy a pass. Resolved means the exercise's own tests exit zero.
 *
 * This measures Milo with a model, not the model alone and not the published
 * polyglot leaderboard: the prompt, the tools and the step budget are Milo's.
 */
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { readProjectInstructions } from '../src/core/agent/instructions.js'
import { DEFAULT_SYSTEM_PROMPT } from '../src/core/agent/system.js'
import type { Memory } from '../src/core/memory/index.js'
import type { Project } from '../src/core/projects.js'
import type { Message, Provider } from '../src/core/providers/types.js'
import { AgentRuntime } from '../src/core/runtime.js'
import { MemoryRecapStore } from '../src/core/sessions/recap.js'
import { MemorySessionSeen } from '../src/core/sessions/seen.js'
import { MemorySessionStore } from '../src/core/sessions/memory-store.js'
import {
  applyPatchTool,
  editFileTool,
  formatTool,
  globTool,
  grepTool,
  listDirTool,
  readFileTool,
  shellTool,
  todoTool,
  writeFileTool,
} from '../src/core/tools/index.js'
import { DefaultPermissionPolicy } from '../src/core/tools/permission.js'
import { ToolRegistry } from '../src/core/tools/registry.js'

const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'apply_patch'])

const NO_MEMORY = {
  remember: async () => undefined,
  recall: async () => [],
  list: async () => [],
  forget: async () => false,
} as unknown as Memory

interface Options {
  root: string
  language: string
  limit: number
  timeoutMs: number
  keep: boolean
  out: string
  only: string[]
  against?: { providerId: string; model?: string }
}

interface Exercise {
  name: string
  dir: string
  instructions: string
  solutions: string[]
  tests: string[]
}

interface TestResult {
  code: number
  passed: number
  total: number
  verdict: string
}

interface Sample {
  exercise: string
  resolved: boolean
  passed: number
  total: number
  writes: number
  toolCalls: number
  durationMs: number
  inputTokens: number
  outputTokens: number
  testEdited: boolean
  failed: string | null
  answer: string
  dir: string
}

function parseArgs(args: string[]): Options {
  const options: Options = {
    root: '/tmp/polyglot-benchmark',
    language: 'python',
    limit: 10,
    timeoutMs: 240_000,
    keep: false,
    out: '',
    only: [],
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--root') options.root = args[++index] ?? options.root
    else if (arg === '--language') options.language = args[++index] ?? options.language
    else if (arg === '--limit') options.limit = Number(args[++index])
    else if (arg === '--timeout') options.timeoutMs = Number(args[++index])
    else if (arg === '--keep') options.keep = true
    else if (arg === '--out') options.out = args[++index] ?? ''
    else if (arg === '--only') options.only = (args[++index] ?? '').split(',').map((name) => name.trim()).filter(Boolean)
    else if (arg === '--against') {
      const spec = args[++index] ?? ''
      const at = spec.indexOf(':')
      options.against = at === -1 ? { providerId: spec } : { providerId: spec.slice(0, at), model: spec.slice(at + 1) }
    } else {
      console.log('Usage: bench:known [--root <dir>] [--language python|javascript] [--limit <n>] [--only name,name] [--timeout <ms>] [--keep] [--out <jsonl>] [--against <provider>[:<model>]]')
      process.exit(2)
    }
  }
  return options
}

const oneLine = (text: string, max = 200): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function loadExercises(options: Options): Exercise[] {
  const base = path.join(options.root, options.language, 'exercises', 'practice')
  if (!existsSync(base)) {
    console.error('\nNo exercises at %s — clone Aider-AI/polyglot-benchmark there.', base)
    process.exit(1)
  }
  const exercises: Exercise[] = []
  for (const entry of readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue
    const dir = path.join(base, entry.name)
    const config = path.join(dir, '.meta', 'config.json')
    const docs = path.join(dir, '.docs', 'instructions.md')
    if (!existsSync(config) || !existsSync(docs)) continue
    const parsed = JSON.parse(readFileSync(config, 'utf8')) as {
      files?: { solution?: string[]; test?: string[] }
    }
    const solutions = parsed.files?.solution ?? []
    const tests = parsed.files?.test ?? []
    if (solutions.length === 0 || tests.length === 0) continue
    exercises.push({
      name: entry.name,
      dir,
      instructions: readFileSync(docs, 'utf8').trim(),
      solutions,
      tests,
    })
  }
  const selected =
    options.only.length > 0
      ? options.only
          .map((name) => exercises.find((exercise) => exercise.name === name))
          .filter((exercise): exercise is Exercise => Boolean(exercise))
      : exercises
  return selected.slice(0, options.limit)
}

/** The exercise without the reference solution or the instructions file. */
function prepare(exercise: Exercise): { dir: string; work: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'milo-polyglot-'))
  const work = path.join(dir, 'exercise')
  cpSync(exercise.dir, work, {
    recursive: true,
    filter: (source) => {
      const base = path.basename(source)
      return base !== '.meta' && base !== '.docs' && base !== 'node_modules' && base !== '__pycache__'
    },
  })
  return { dir, work }
}

function testCommand(language: string): { command: string; args: string[] } {
  if (language === 'python') return { command: 'python3', args: ['-m', 'unittest', 'discover', '-p', '*_test.py', '-v'] }
  return { command: 'npm', args: ['test', '--', '--runInBand'] }
}

function runTests(language: string, work: string): TestResult {
  const { command, args } = testCommand(language)
  const result = spawnSync(command, args, { cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return verdictOf(`${result.stdout ?? ''}${result.stderr ?? ''}`, result.status ?? 1)
}

function verdictOf(output: string, code: number): TestResult {
  const total = Number(/Ran (\d+) tests?/i.exec(output)?.[1] ?? 0)
  const failures = Number(/failures=(\d+)/i.exec(output)?.[1] ?? 0)
  const errors = Number(/errors=(\d+)/i.exec(output)?.[1] ?? 0)
  const verdict = output.includes('OK') ? 'OK' : output.includes('FAILED') ? 'FAILED' : code === 0 ? 'OK' : 'FAILED'
  const passed = output.includes('OK') ? total : Math.max(0, total - failures - errors)
  return { code, passed, total, verdict }
}

function textOf(message: Message): string {
  return message.content
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n')
    .trim()
}

function finalAnswer(messages: readonly Message[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'assistant') continue
    const text = textOf(message)
    if (text) return text
  }
  return ''
}

async function runOnce(
  exercise: Exercise,
  options: Options,
  provider: Provider,
  model: string,
): Promise<Sample> {
  const { dir, work } = prepare(exercise)
  const project: Project = { id: 'exercise', name: exercise.name, path: work, createdAt: Date.now() }
  const runtime = new AgentRuntime({
    provider,
    model,
    system: DEFAULT_SYSTEM_PROMPT,
    registry: new ToolRegistry([
      readFileTool,
      listDirTool,
      globTool,
      grepTool,
      writeFileTool,
      editFileTool,
      applyPatchTool,
      formatTool,
      todoTool,
      shellTool,
    ]),
    memory: NO_MEMORY,
    cwd: work,
    project: () => ({ ok: true, project }),
    instructions: readProjectInstructions,
    permissionPolicy: new DefaultPermissionPolicy({ mode: 'yolo' }),
    sandbox: 'workspace',
    store: new MemorySessionStore(),
    recaps: new MemoryRecapStore(),
    seen: new MemorySessionSeen(),
    maxSteps: 30,
  })
  const session = await runtime.sessionFor({ gateway: 'web', chatId: randomUUID() }, { project: 'exercise' })

  const task = [
    exercise.instructions,
    '',
    `The exercise is in this folder. Implement it in ${exercise.solutions.join(', ')} so the tests pass.`,
    `The tests are ${exercise.tests.join(', ')}. Do not change the tests.`,
    `Run them with: ${options.language === 'python' ? "python3 -m unittest discover -p '*_test.py' -v" : 'npm test'}`,
  ].join('\n')

  let writes = 0
  let toolCalls = 0
  let inputTokens = 0
  let outputTokens = 0
  let failed: string | null = null
  const started = performance.now()
  const stop = AbortSignal.timeout(options.timeoutMs)
  try {
    for await (const event of session.send(task, {
      signal: stop,
      ask: async () => ({ allowed: true }),
    })) {
      if (event.type === 'tool-start') {
        toolCalls += 1
        if (WRITE_TOOLS.has(event.name)) writes += 1
      }
      if (event.type === 'usage') {
        inputTokens += event.inputTokens
        outputTokens += event.outputTokens
      }
      if (event.type === 'error') failed ??= event.message
    }
  } catch (error) {
    if (!stop.aborted) throw error
  }
  const durationMs = performance.now() - started

  // Whether the agent touched a test, read before the original is put back.
  let testEdited = false
  for (const test of exercise.tests) {
    const current = path.join(work, test)
    if (!existsSync(current)) {
      testEdited = true
      continue
    }
    if (readFileSync(current, 'utf8') !== readFileSync(path.join(exercise.dir, test), 'utf8')) testEdited = true
  }
  // A pass has to come from the solution, not from a changed test.
  for (const test of exercise.tests) cpSync(path.join(exercise.dir, test), path.join(work, test))

  const result = runTests(options.language, work)
  const sample: Sample = {
    exercise: exercise.name,
    resolved: result.code === 0,
    passed: result.passed,
    total: result.total,
    writes,
    toolCalls,
    durationMs,
    inputTokens,
    outputTokens,
    testEdited,
    failed: failed ?? (stop.aborted ? 'still running when the bench cut it off' : null),
    answer: oneLine(finalAnswer(session.messages)),
    dir: options.keep ? dir : '',
  }
  if (!options.keep) rmSync(dir, { recursive: true, force: true })
  return sample
}

function report(samples: Sample[]): void {
  console.log('\n  exercise             result  tests        writes  test edited  time')
  for (const sample of samples) {
    const time = sample.durationMs >= 1000 ? `${(sample.durationMs / 1000).toFixed(1)}s` : `${sample.durationMs.toFixed(0)}ms`
    console.log(
      `  ${sample.exercise.padEnd(20)} ${(sample.resolved ? 'pass' : 'FAIL').padEnd(7)} ${`${sample.passed}/${sample.total}`.padEnd(12)} ${String(sample.writes).padStart(6)}  ${(sample.testEdited ? 'YES' : 'no').padEnd(3)}        ${time.padStart(6)}`,
    )
    if (sample.failed) console.log(`      ${oneLine(sample.failed)}`)
  }
  const resolved = samples.filter((sample) => sample.resolved).length
  const edited = samples.filter((sample) => sample.testEdited).length
  const writes = samples.reduce((sum, sample) => sum + sample.writes, 0)
  const passed = samples.reduce((sum, sample) => sum + sample.passed, 0)
  const total = samples.reduce((sum, sample) => sum + sample.total, 0)
  console.log('\n  resolved %d/%d · tests %d/%d (diagnostic, not the official score) · test edited %d/%d · %d writes', resolved, samples.length, passed, total, edited, samples.length, writes)
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const { loadConfig, readAuth, resolveProvider } = await import('../src/core/config/load.js')
  const { findPreset } = await import('../src/core/config/presets.js')
  const { createProvider } = await import('../src/core/providers/create.js')

  const loaded = loadConfig()
  if (!loaded) {
    console.error('\nNo configuration found — run `milo setup` first.')
    process.exit(1)
  }

  let provider = loaded.provider
  let model = loaded.model
  if (options.against) {
    const resolved = resolveProvider(loaded.config, readAuth(), options.against.providerId)
    if (!resolved) {
      console.error('\n`%s` is not a provider this install has. Configured: %s.', options.against.providerId, Object.keys(loaded.config.providers).join(', ') || 'none')
      process.exit(1)
    }
    const resolvedModel =
      options.against.model ??
      (options.against.providerId === loaded.config.provider
        ? loaded.model
        : findPreset(options.against.providerId)?.models[0])
    if (!resolvedModel) {
      console.error('\n`%s` has no model to run: name one as `--against %s:<model>`.', provider.id, options.against.providerId)
      process.exit(1)
    }
    provider = resolved
    model = resolvedModel
  }

  const exercises = loadExercises(options)
  const out = options.out || `/tmp/milo-polyglot-${model.replace(/[^a-z0-9.-]+/gi, '-')}.jsonl`
  console.log('\naider polyglot through Milo — %s/%s', provider.id, model)
  console.log('  %d %s exercise%s, one turn each; tests restored before they run', exercises.length, options.language, exercises.length === 1 ? '' : 's')
  console.log('  resolved means the exercise\'s own tests exit zero\n')

  writeFileSync(out, '')
  const samples: Sample[] = []
  for (const exercise of exercises) {
    console.error('  %s …', exercise.name)
    const sample = await runOnce(exercise, options, createProvider(provider, model), model)
    samples.push(sample)
    // Written as each one lands, so a run that dies halfway still leaves the ones before it.
    appendFileSync(out, `${JSON.stringify(sample)}\n`, 'utf8')
  }
  report(samples)
  console.log('\n  written to %s', out)
}

await main()
