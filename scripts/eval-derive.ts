import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { loadConfig } from '../src/core/config/load.js'
import { deriveFacts } from '../src/core/memory/derive.js'
import { createProvider } from '../src/core/providers/create.js'
import type { Provider } from '../src/core/providers/types.js'
import { errorMessage } from '../src/util/errors.js'
import { DERIVE_CASES, derivationCompleted, scoreDerivation, type DeriveCall } from '../test/fixtures/derive-eval.js'

const args = process.argv.slice(2)
let out: string | undefined
let repeats = 1
let selected: string | undefined
for (let index = 0; index < args.length; index++) {
  const arg = args[index]
  if (arg !== '--out' && arg !== '--repeats' && arg !== '--case') {
    throw new Error(`Unknown argument ${arg}. Valid arguments: --out <new-file.jsonl>, --repeats <count>, --case <id>`)
  }
  const value = args[++index]
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`)
  if (arg === '--out') out = value
  else if (arg === '--case') selected = value
  else repeats = Number(value)
}
if (!Number.isInteger(repeats) || repeats < 1) throw new Error('--repeats must be a positive integer')
const cases = DERIVE_CASES.filter((scenario) => !selected || scenario.id === selected)
if (cases.length === 0) throw new Error(`Unknown case ${selected}. Valid cases: ${DERIVE_CASES.map((scenario) => scenario.id).join(', ')}`)
const paceMs = Number(process.env.MILO_EVAL_PACE_MS ?? 0)
if (!Number.isFinite(paceMs) || paceMs < 0) throw new Error('MILO_EVAL_PACE_MS must be a nonnegative number')
const loaded = loadConfig()
if (!loaded) throw new Error('No configuration found; run milo setup first')
const provider = createProvider(loaded.provider, loaded.model)
const output = out ?? `/tmp/milo-derive-${Date.now()}.jsonl`
if (existsSync(output)) throw new Error(`Refusing to replace an existing report: ${output}`)
writeFileSync(output, '', { flag: 'wx', mode: 0o600 })
console.log(`Derive evaluation: ${cases.length} cases × ${repeats} run(s), ${provider.id}/${loaded.model}`)
console.log(`Synthetic exchanges only; output: ${output}`)
let passed = 0
let unmeasured = 0
for (let run = 1; run <= repeats; run++) {
  for (const scenario of cases) {
    const calls: DeriveCall[] = []
    let extractionSystem: string | undefined
    const observed: Provider = {
      id: provider.id,
      async *stream(req) {
        extractionSystem ??= req.system
        const call: (typeof calls)[number] = { stage: req.system === extractionSystem ? 'extract' : 'review', text: '', latencyMs: 0 }
        calls.push(call)
        const started = performance.now()
        try {
          for await (const event of provider.stream(req)) {
            if (event.type === 'text') call.text += event.delta
            if (event.type === 'done') call.finishReason = event.finishReason
            if (event.type === 'usage') { call.inputTokens = event.inputTokens; call.outputTokens = event.outputTokens }
            yield event
          }
        } catch (error) {
          call.error = errorMessage(error)
          throw error
        } finally {
          call.latencyMs = performance.now() - started
        }
      },
    }
    const started = performance.now()
    const facts = await deriveFacts({
      provider: observed,
      model: loaded.model,
      person: scenario.person,
      messages: [
        { role: 'user', content: [{ type: 'text', text: scenario.person }] },
        { role: 'assistant', content: [{ type: 'text', text: scenario.answer }] },
      ],
      existing: async () => (scenario.existing ?? []).map((text, index) => ({ id: `seed-${index}`, text, createdAt: 1 })),
    })
    // A failed provider returning [] cannot earn a pass for an ignore case.
    const valid = derivationCompleted(calls)
    const score = scoreDerivation(scenario, facts)
    const status = !valid ? 'unmeasured' : score.passed ? 'pass' : 'fail'
    if (status === 'pass') passed++
    if (status === 'unmeasured') unmeasured++
    const result = { at: new Date().toISOString(), run, id: scenario.id, category: scenario.category, provider: provider.id, model: loaded.model, scenario, facts, score, status, calls, latencyMs: performance.now() - started }
    appendFileSync(output, `${JSON.stringify(result)}\n`)
    console.log(`${run} ${status.toUpperCase()} ${scenario.id}: ${JSON.stringify(facts.map((fact) => fact.text))}`)
    if (paceMs) await delay(paceMs)
  }
}
console.log(`${passed}/${cases.length * repeats} rubric passes; ${unmeasured} unmeasured. Inspect facts and raw stage outputs; lexical matches do not establish semantic correctness.`)
if (unmeasured > 0) process.exitCode = 1
