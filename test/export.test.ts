import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { exportFileName, renderExportJson, renderExportMarkdown, writeSessionExport } from '../src/core/export.js'
import type { HistoryEntry } from '../src/core/history.js'

const roots: string[] = []

function dir(): string {
  const made = mkdtempSync(path.join(tmpdir(), 'milo-export-'))
  roots.push(made)
  return made
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * A wall-clock time in the runner's own timezone, so the clock the renderer
 * prints is the same string on every machine. Handing it a `Z` timestamp would
 * make the expectation depend on where the suite runs.
 */
const at = (time: string): string => {
  const [hours, minutes, seconds] = time.split(':').map(Number)
  return new Date(2026, 8, 24, hours ?? 0, minutes ?? 0, seconds ?? 0).toISOString()
}

const entries: HistoryEntry[] = [
  { at: at('14:02:11'), session: 'calm-otter-7', scope: 'cli:main', kind: 'user', text: 'leia o arquivo x' },
  {
    at: at('14:02:14'),
    session: 'calm-otter-7',
    scope: 'cli:main',
    kind: 'tool',
    tool: { name: 'read_file', args: { path: 'x' }, result: 'hello\nworld' },
  },
  {
    at: at('14:02:15'),
    session: 'calm-otter-7',
    scope: 'cli:main',
    kind: 'tool',
    tool: { name: 'shell_command', args: { command: 'nope' }, result: 'not found', isError: true },
  },
  {
    at: at('14:03:02'),
    session: 'calm-otter-7',
    scope: 'cli:main',
    kind: 'assistant',
    text: 'O arquivo diz hello.',
    reasoning: 'Preciso ler o arquivo antes de responder.',
  },
]

describe('renderExportMarkdown', () => {
  const text = renderExportMarkdown({ id: 'calm-otter-7', title: 'Ler um arquivo', exportedAt: Date.now() }, entries)

  it('names the session and what it holds', () => {
    expect(text).toContain('# calm-otter-7 — Ler um arquivo')
    expect(text).toContain('- **Session** `calm-otter-7`')
    expect(text).toContain('- **Scope** `cli:main`')
    expect(text).toContain('- **Held** 2 messages · 2 tool calls')
  })

  it('says where the file came from, so it is not mistaken for the transcript', () => {
    expect(text).toContain('the history log, which is the complete record')
  })

  it('carries every message, in the order it happened', () => {
    const positions = ['leia o arquivo x', 'read_file', 'shell_command', 'O arquivo diz hello.'].map((needle) =>
      text.indexOf(needle),
    )
    expect(positions.every((position) => position >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  it('shows a tool call with its arguments and its full result', () => {
    expect(text).toContain('## tool · read_file · 14:02:14')
    expect(text).toContain('"path": "x"')
    expect(text).toContain('hello\nworld')
  })

  it('marks a tool that failed, and says so at the result too', () => {
    expect(text).toContain('## tool · shell_command · 14:02:15 · failed')
    expect(text).toContain('**Result** — it failed')
  })

  it('keeps the reasoning with the answer it produced', () => {
    expect(text).toContain('**Reasoning**')
    expect(text).toContain('Preciso ler o arquivo antes de responder.')
    expect(text.indexOf('**Reasoning**')).toBeLessThan(text.indexOf('O arquivo diz hello.'))
  })

  it('contains a result that is itself full of code fences', () => {
    const tricky = renderExportMarkdown({ id: 's', exportedAt: 0 }, [
      {
        at: at('14:00:00'),
        session: 's',
        scope: 'cli',
        kind: 'tool',
        tool: { name: 'read_file', args: {}, result: '```\ninner fence\n```' },
      },
    ])
    // The inner fence survives, so the block around it did not end on it.
    expect(tricky).toContain('````\n```\ninner fence\n```\n````')
  })

  it('reads times on the reader own clock, not the UTC the log stores', () => {
    // The log stores UTC; a header cut from the raw string sat three hours from
    // the "first event" line above it, which is local.
    const instant = Date.UTC(2026, 8, 24, 14, 2, 14)
    const local = new Date(instant)
    const expected = [local.getHours(), local.getMinutes(), local.getSeconds()]
      .map((value) => String(value).padStart(2, '0'))
      .join(':')

    const rendered = renderExportMarkdown({ id: 's', exportedAt: instant }, [
      { at: new Date(instant).toISOString(), session: 's', scope: 'cli', kind: 'user', text: 'x' },
    ])
    expect(rendered).toContain(`## you · ${expected}`)
  })

  it('is plain Markdown, because a terminal reads this too', () => {
    expect(text).not.toContain('<details')
    expect(text).not.toContain('<summary')
  })

  it('renders a session with nothing in it rather than failing', () => {
    const empty = renderExportMarkdown({ id: 's', exportedAt: Date.now() }, [])
    expect(empty).toContain('# s')
    expect(empty).toContain('- **Held** 0 messages · 0 tool calls')
  })
})

describe('exportFileName', () => {
  it('is the entries themselves, with what is needed to read them', () => {
    const parsed = JSON.parse(renderExportJson({ id: 'calm-otter-7', title: 't', exportedAt: 0 }, entries))
    expect(parsed.session).toBe('calm-otter-7')
    expect(parsed.counts).toEqual({ entries: 4, messages: 2, toolCalls: 2 })
    expect(parsed.entries).toHaveLength(4)
    expect(parsed.entries[1].tool.result).toBe('hello\nworld')
  })
})

describe('exportFileName', () => {
  it('names the session and the moment it was taken', () => {
    const when = new Date(2026, 8, 24, 17, 10, 5)
    expect(exportFileName('calm-otter-7', 'md', when)).toBe('calm-otter-7-20260924-171005.md')
    expect(exportFileName('calm-otter-7', 'json', when)).toBe('calm-otter-7-20260924-171005.json')
  })
})

describe('writeSessionExport', () => {
  /** A log with one session in it, and another session it must not touch. */
  function log(): string {
    const where = dir()
    writeFileSync(
      path.join(where, '2026-09-24.jsonl'),
      `${[
        JSON.stringify({ at: at('14:00:00'), session: 'other-session', scope: 'cli:main', kind: 'user', text: 'nao eu' }),
        ...entries.map((entry) => JSON.stringify(entry)),
      ].join('\n')}\n`,
    )
    return where
  }

  it('writes the session out, and only that session', async () => {
    const out = dir()
    const result = await writeSessionExport({
      id: 'calm-otter-7',
      historyDir: log(),
      outDir: out,
      format: 'md',
    })

    expect(result?.entries).toBe(4)
    expect(result?.messages).toBe(2)
    expect(result?.toolCalls).toBe(2)
    const written = readFileSync(result!.path, 'utf8')
    expect(written).toContain('leia o arquivo x')
    expect(written).not.toContain('nao eu')
  })

  it('writes JSON when it is asked for', async () => {
    const result = await writeSessionExport({ id: 'calm-otter-7', historyDir: log(), outDir: dir(), format: 'json' })
    expect(result?.path.endsWith('.json')).toBe(true)
    expect(JSON.parse(readFileSync(result!.path, 'utf8')).session).toBe('calm-otter-7')
  })

  it('writes nothing at all when the log has nothing to say', async () => {
    const out = dir()
    expect(await writeSessionExport({ id: 'never-ran', historyDir: log(), outDir: out })).toBeNull()
  })

  it('writes nothing when there is no log directory either', async () => {
    expect(await writeSessionExport({ id: 'x', historyDir: path.join(dir(), 'missing'), outDir: dir() })).toBeNull()
  })

  it('keeps the file private — a transcript is what the person said', async () => {
    const { statSync } = await import('node:fs')
    const result = await writeSessionExport({ id: 'calm-otter-7', historyDir: log(), outDir: dir() })
    expect(statSync(result!.path).mode & 0o777).toBe(0o600)
  })
})
