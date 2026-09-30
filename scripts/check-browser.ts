#!/usr/bin/env node
/**
 * Exercita cada verbo do toolset de browser num navegador de verdade, e confere
 * que a **página reagiu** — não só que a chamada não deu erro.
 *
 *   npm run check:browser
 *
 * O bench mede quanto custa; este confere que funciona. Os dois existem porque
 * um vocabulário com verbos que ninguém nunca rodou é um vocabulário que só
 * parece fechado: `upload`, `hover` e `double_click` ficaram de fora por dias
 * sem que nada apontasse, e o próprio `click` chegou a faltar da checagem.
 *
 * Precisa de um Chrome/Chromium, como o bench. A página é servida daqui mesmo.
 */
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { BrowserSession, type BrowserSessionOptions } from '../src/core/browser/session.js'
import { findChrome } from '../src/core/browser/chrome.js'
import { BROWSER_ACTIONS, type BrowserAction } from '../src/core/browser/tools.js'
import type { RawElement } from '../src/core/browser/observer.js'

const PAGE = `<!doctype html><html><head><title>Acoes</title><style>body{height:3000px}</style></head><body>
<h1>Acoes</h1>
<p id="out">nada</p>
<input id="text" type="text" placeholder="texto">
<div id="ce" contenteditable="true" role="textbox" aria-label="editavel">editavel</div>
<input id="file" type="file" aria-label="arquivo">
<select id="sel" aria-label="escolha">
  <option value="">Escolha</option><option value="s">Pequeno</option><option value="l">Grande</option>
</select>
<button id="clickMe" type="button">Clique</button>
<button id="dbl" type="button">Duplo</button>
<div id="hoverMe" role="button" tabindex="0">Passe o mouse</div>
<form id="form"><input id="field" type="text" placeholder="campo"><button type="submit">Enviar</button></form>
<script>
  // The marker is what the check reads: it can only come from these writes,
  // never from a stray word elsewhere in the page.
  const out = (text) => { document.getElementById('out').textContent = '@' + text }
  document.getElementById('text').addEventListener('input', (e) => out('typed:' + e.target.value))
  document.getElementById('ce').addEventListener('input', (e) => out('ce:' + e.target.textContent))
  document.getElementById('clickMe').addEventListener('click', () => out('clicked'))
  document.getElementById('dbl').addEventListener('dblclick', () => out('dblclick'))
  document.getElementById('hoverMe').addEventListener('mouseenter', () => out('hover'))
  document.getElementById('hoverMe').addEventListener('mouseover', () => out('hover'))
  document.getElementById('sel').addEventListener('change', (e) => out('select:' + e.target.value))
  document.getElementById('file').addEventListener('change', (e) => out('file:' + (e.target.files[0]?.name ?? 'none')))
  document.getElementById('form').addEventListener('submit', (e) => { e.preventDefault(); out('submit') })
  window.addEventListener('scroll', () => out('scrolled:' + Math.round(window.scrollY)))
</script>
</body></html>`

/**
 * The page that replaces itself 200ms after loading: what puts the look and the
 * action on two different documents.
 */
const ESCAPING = `<!doctype html><html><head><title>Escaping</title></head><body>
<button id="b">Clique</button>
<script>setTimeout(function () { location.reload() }, 200)</script>
</body></html>`

interface Check {
  /** The verb from the tool's own list that this one exercises. */
  action: BrowserAction
  what: string
  /** What the page should say afterwards. */
  expect: string
  run: (session: BrowserSession, elements: RawElement[]) => Promise<unknown>
}

interface Result {
  what: string
  said: string
  ok: boolean
  /**
   * The browser never answered, rather than answering with the wrong thing.
   *
   * The two are not the same failure and must not read as one: a verb that did
   * not land is about the tool, and a command that timed out is about the machine
   * or the connection. On a loaded machine the second one happens, and chasing it
   * as a bug in the toolset is an afternoon gone.
   */
  unanswered?: boolean
}

const UNANSWERED = /timed out|closed|ECONNRESET|cancelled/i

/** The element a person would mean by its label. */
const on = (elements: RawElement[], label: string): string =>
  elements.find((element) => element.name === label)?.ref ?? ''

function checksFor(file: string): Check[] {
  return [
    {
      action: 'click',
      what: 'click',
      expect: 'clicked',
      run: (s, e) => s.act({ action: 'click', ref: on(e, 'Clique') }, AbortSignal.timeout(10_000)),
    },
    {
      action: 'type',
      what: 'type into a text field',
      expect: 'typed:capivara',
      run: (s, e) => s.act({ action: 'type', ref: on(e, 'texto'), text: 'capivara' }, AbortSignal.timeout(10_000)),
    },
    {
      action: 'type',
      what: 'type into a contenteditable',
      expect: 'ce:escrito',
      run: (s, e) => s.act({ action: 'type', ref: on(e, 'editavel'), text: 'escrito' }, AbortSignal.timeout(10_000)),
    },
    {
      action: 'press',
      what: 'press Enter, which submits the form',
      expect: 'submit',
      run: (s, e) => s.act({ action: 'press', ref: on(e, 'campo'), key: 'Enter' }, AbortSignal.timeout(10_000)),
    },
    {
      action: 'double_click',
      what: 'double_click',
      expect: 'dblclick',
      run: (s, e) => s.act({ action: 'double_click', ref: on(e, 'Duplo') }, AbortSignal.timeout(10_000)),
    },
    {
      action: 'hover',
      what: 'hover',
      expect: 'hover',
      run: (s, e) => s.act({ action: 'hover', ref: on(e, 'Passe o mouse') }, AbortSignal.timeout(10_000)),
    },
    {
      action: 'select',
      what: 'select by its visible text',
      expect: 'select:l',
      run: (s, e) => s.act({ action: 'select', ref: on(e, 'escolha'), text: 'Grande' }, AbortSignal.timeout(10_000)),
    },
    {
      action: 'upload',
      what: 'upload a file',
      expect: 'file:nota.txt',
      run: (s, e) => s.act({ action: 'upload', ref: on(e, 'arquivo'), path: file }, AbortSignal.timeout(10_000)),
    },
    {
      action: 'scroll',
      what: 'scroll, which moves the page',
      expect: 'scrolled:',
      run: (s) => s.act({ action: 'scroll', direction: 'down' }, AbortSignal.timeout(10_000)),
    },
  ]
}

/**
 * The failure that is not a verb: the page replaces itself between the look and
 * the action. The ref is still the newest look's, and what died is the frame —
 * a different failure with a different answer, and the model has to be told
 * which one it is, because "look again" is the remedy for only one of them.
 */
async function checkEscapingPage(session: BrowserSession, url: string): Promise<Result> {
  const what = 'the page replacing itself under a ref'
  const opening = await session.navigate(url, 'load', AbortSignal.timeout(30_000))
  const ref = opening.elements[0]?.ref ?? ''
  // Past the page's own reload, so the action lands on a document that is gone.
  await new Promise((resolve) => setTimeout(resolve, 900))
  try {
    await session.act({ action: 'click', ref }, AbortSignal.timeout(10_000))
    return { what, said: 'the action landed — the page had not reloaded yet', ok: false }
  } catch (error) {
    const said = (error as Error).message
    return { what, said, ok: said.includes('replaced itself') }
  }
}

async function runEngine(
  label: string,
  options: BrowserSessionOptions,
  url: string,
  file: string,
  escapingUrl: string,
): Promise<Result[]> {
  const session = new BrowserSession(options)
  const results: Result[] = []
  try {
    for (const check of checksFor(file)) {
      // Each one starts from a clean page, so a verb cannot pass on the last
      // one's evidence.
      const opening = await session.navigate(url, 'load', AbortSignal.timeout(30_000))
      try {
        await check.run(session, opening.elements)
      } catch (error) {
        const said = (error as Error).message
        results.push({ what: check.what, said, ok: false, unanswered: UNANSWERED.test(said) })
        continue
      }
      const text = await session.readText(AbortSignal.timeout(15_000))
      const marked = text.text.replace(/\s+/g, ' ').match(/@[^\s]+/)?.[0]
      results.push({
        what: check.what,
        said: marked ? marked.slice(1) : '(a pagina nao disse nada)',
        ok: Boolean(marked?.startsWith(`@${check.expect}`)),
      })
    }
    results.push(await checkEscapingPage(session, escapingUrl))
  } finally {
    await session.close()
  }
  console.log(`\n${label}`)
  return results
}

async function main(): Promise<void> {
  const work = mkdtempSync(path.join(tmpdir(), 'milo-check-'))
  const file = path.join(work, 'nota.txt')
  writeFileSync(file, 'conteudo')

  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(request.url === '/escaping' ? ESCAPING : PAGE)
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`

  const chrome = await findChrome(process.env.MILO_BROWSER_CHROME ?? null)
  if (!chrome) {
    console.error('Nenhum Chrome/Chromium encontrado — defina MILO_BROWSER_CHROME.')
    server.close()
    return
  }

  const missing = BROWSER_ACTIONS.filter((action) => !checksFor(file).some((check) => check.action === action))

  let broken = 0
  let results: Result[] = []
  try {
    // A browser that will not start is not a verb that did not land, and it must
    // not come out as a stack trace: it is one line saying so.
    let startup = ''
    try {
      results = await runEngine(
        'browser toolset — cada verbo, e o que a pagina disse depois',
        { chromePath: chrome, profileDir: path.join(work, 'profile'), headless: true },
        url,
        file,
        `${url}escaping`,
      )
    } catch (error) {
      startup = (error as Error).message
    }

    for (const result of results) {
      console.log(`  ${result.ok ? 'ok  ' : 'NAO '} ${result.what.padEnd(38)} ${result.said}`)
    }
    if (startup) console.log(`  o navegador nao abriu a pagina: ${startup}`)

    broken = results.filter((result) => !result.ok).length + (startup ? 1 : 0)
    if (results.length > 0) {
      console.log(
        `\n  ${results.length - results.filter((result) => !result.ok).length}/${results.length} checks, e a pagina confirmou o efeito · verbos ` +
          `${BROWSER_ACTIONS.length - missing.length}/${BROWSER_ACTIONS.length}` +
          (missing.length > 0 ? ` — FALTAM: ${missing.join(', ')}` : ''),
      )
    }

    const silent = results.filter((result) => result.unanswered).length
    if (silent > 0) {
      console.log(
        `\n  ${silent} desses é "o navegador não respondeu", não "o verbo não funcionou" — numa máquina` +
          '\n  sob carga isso acontece. Rode de novo antes de investigar o toolset.',
      )
    }
  } finally {
    server.close()
    rmSync(work, { recursive: true, force: true })
  }

  if (broken > 0 || missing.length > 0) {
    // Só a legenda do que de fato apareceu: um navegador que não subiu não deixou
    // nenhum "NAO" para explicar.
    if (results.some((result) => !result.ok) || missing.length > 0) {
      console.log('\nO "NAO" acima é o que a página não confirmou; "FALTAM" é o verbo que ninguém exercitou.')
    }
    process.exitCode = 1
  }
}

await main()
