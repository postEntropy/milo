#!/usr/bin/env node
/**
 * Measures what the browser toolset costs that is *not* the model.
 *
 *   npm run bench:browser
 *
 * The model round trip is seconds and is not measured here — it is the same
 * whether this feature exists or not. What this measures is everything Milo adds
 * on top: starting the browser, navigating, looking at the page and acting on it.
 * Those are the numbers that decide whether an action is worth a round trip.
 *
 * The page is served from this process, so the run needs no network and measures
 * the same thing on every machine. It closes with the round trips a task costs,
 * against the budget: N actions must be N tool calls plus one answer, never 2N.
 */
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { BrowserSession } from '../src/core/browser/session.js'
import { formatSnapshot } from '../src/core/browser/observer.js'
import { findChrome } from '../src/core/browser/chrome.js'
import { dropOldSnapshots, estimateTokens } from '../src/core/sessions/compact.js'
import type { Message } from '../src/core/providers/types.js'

const PAGE = `<!doctype html><html><head><title>Bench</title></head><body>
<h1>Bench page</h1>
<p>${'Some prose so the page has a body worth reading. '.repeat(20)}</p>
<form>
  <label for="q">Search</label><input id="q" name="q" type="text" placeholder="Search">
  <select id="size" name="size"><option value="">Choose</option><option value="s">Small</option><option value="l">Large</option></select>
  <button id="go" type="submit">Go</button>
</form>
<ul>${Array.from({ length: 40 }, (_, index) => `<li><a href="/item/${index}">Item ${index}</a></li>`).join('')}</ul>
</body></html>`

interface Sample {
  what: string
  ms: number
  tokens: number
}

const samples: Sample[] = []

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0
}

async function timed<T extends { tokens: number }>(what: string, run: () => Promise<T>): Promise<T> {
  const started = performance.now()
  const result = await run()
  samples.push({ what, ms: performance.now() - started, tokens: result.tokens })
  return result
}

async function main(): Promise<void> {
  const chrome = await findChrome(process.env.MILO_BROWSER_CHROME ?? null)
  if (!chrome) {
    console.error('No Chrome or Chromium found — set MILO_BROWSER_CHROME to benchmark.')
    return
  }

  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(PAGE)
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const port = (server.address() as { port: number }).port
  const url = `http://127.0.0.1:${port}/`

  const profileDir = await mkdtemp(path.join(tmpdir(), 'milo-bench-'))
  const session = new BrowserSession({ chromePath: chrome, profileDir, headless: true })

  try {
    // Cold start, on its own: this is the one cost that is paid once per process
    // rather than once per action, which is the whole reason the browser is a
    // persistent session rather than a call.
    const coldStart = performance.now()
    await session.start()
    const coldMs = performance.now() - coldStart

    let observation = (
      await timed('browser_open', async () => {
        const opened = await session.navigate(url, 'load', AbortSignal.timeout(30_000))
        return { tokens: estimateTokens([snapshotMessage(opened)]), observation: opened }
      })
    ).observation

    for (let run = 0; run < 3; run += 1) {
      observation = (
        await timed('browser_snapshot', async () => {
          const looked = await session.observe(AbortSignal.timeout(10_000))
          return { tokens: estimateTokens([snapshotMessage(looked)]), observation: looked }
        })
      ).observation
    }

    // A ref only means anything for the look that handed it out, so every action
    // takes its target from the observation in hand — the discipline the model
    // follows too.
    const textbox = observation.elements.find((element) => element.role === 'textbox')
    const combobox = observation.elements.find((element) => element.role === 'combobox')
    if (!textbox) throw new Error('the bench page has no textbox to type into')

    // One action with the look that comes back with it — the shape the whole
    // design is built around, and the shape that halves the round trips.
    observation = (
      await session.act({ action: 'click', ref: textbox.ref }, AbortSignal.timeout(10_000))
    ).observation!

    observation = (
      await timed('browser_act + look', async () => {
        const field = observation.elements.find((element) => element.role === 'textbox')!
        const typed = await session.act(
          { action: 'type', ref: field.ref, text: 'hello' },
          AbortSignal.timeout(10_000),
        )
        return { tokens: estimateTokens([snapshotMessage(typed.observation!)]), observation: typed.observation! }
      })
    ).observation

    observation = await session.observe(AbortSignal.timeout(10_000))

    // The same action with no look after it: the difference between this and the
    // row above is the settle and the observation, which is where the waiting
    // actually goes — and it is what tells whether the settle is worth its price.
    await timed('browser_act alone', async () => {
      const field = observation.elements.find((element) => element.role === 'textbox')!
      await session.act(
        { action: 'type', ref: field.ref, text: 'x', replace: true },
        AbortSignal.timeout(10_000),
        { observe: false },
      )
      return { tokens: 0 }
    })

    if (combobox) {
      const field = observation.elements.find((element) => element.role === 'combobox')!
      const chosen = await session.act(
        { action: 'select', ref: field.ref, text: 'Large' },
        AbortSignal.timeout(10_000),
      )
      if (!chosen.observation) throw new Error('the select returned no observation')
      observation = chosen.observation
    }

    // A ref from an earlier look must fail rather than land on whatever moved
    // into its place — that refusal is what makes the closed vocabulary safe.
    let refused = false
    try {
      await session.act({ action: 'click', ref: textbox.ref }, AbortSignal.timeout(10_000))
    } catch {
      refused = true
    }

    report(coldMs, refused)
  } finally {
    await session.close()
    server.close()
    await rm(profileDir, { recursive: true, force: true })
  }
}

function snapshotMessage(observation: Parameters<typeof formatSnapshot>[0]): Message {
  return {
    role: 'tool',
    content: [{ type: 'tool-result', id: 'c1', name: 'browser_act', content: formatSnapshot(observation) }],
  }
}

function report(coldMs: number, refusedStaleRef: boolean): void {
  const ms = (values: number[]) => [...values].sort((a, b) => a - b)

  console.log('\nbrowser toolset — local cost per call (no model in the loop)')
  console.log('  chrome cold start   %sms   (once per process)', coldMs.toFixed(0))
  for (const what of [
    'browser_open',
    'browser_snapshot',
    'browser_act alone',
    'browser_act + look',
  ]) {
    const group = samples.filter((sample) => sample.what === what)
    if (group.length === 0) continue
    const sorted = ms(group.map((sample) => sample.ms))
    const tokens = group.filter((sample) => sample.tokens > 0)
    console.log(
      '  %s %sp50%s',
      what.padEnd(20),
      `${percentile(sorted, 50).toFixed(0)}ms `.padStart(8),
      tokens.length > 0
        ? ` · ${Math.round(tokens.reduce((sum, sample) => sum + sample.tokens, 0) / tokens.length)} tokens of page`
        : ' · no page returned',
    )
  }

  const looks = samples.filter((sample) => sample.tokens > 0)
  const perSnapshot = Math.round(looks.reduce((sum, sample) => sum + sample.tokens, 0) / Math.max(1, looks.length))
  const actions = 5

  // What one request costs once a task has run for a while, with the two shapes
  // of the same transcript: every look kept, and the pruning Milo actually does.
  const history: Message[] = []
  for (let step = 0; step < actions; step += 1) {
    history.push({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          id: `c${step}`,
          name: 'browser_act',
          content: `${'r1   link      "Item"\n'.repeat(60)}`,
        },
      ],
    })
  }
  const unbounded = estimateTokens(history)
  dropOldSnapshots(history)
  const bounded = estimateTokens(history)

  console.log('\none %d-action task, as the model pays for it', actions)
  console.log(
    '  round trips       %d  (open + %d actions + 1 answer; act-then-look would be %d)',
    actions + 2,
    actions,
    2 * actions + 1,
  )
  console.log(
    '  last request      %s tokens unbounded → %s with the keep-2 rule',
    unbounded.toLocaleString(),
    bounded.toLocaleString(),
  )
  console.log('  per look          ~%s tokens of page, against a model round trip of seconds', perSnapshot)
  console.log('  stale ref         %s', refusedStaleRef ? 'refused, as it must be' : 'ACCEPTED — investigate')
}

await main()
