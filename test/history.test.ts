import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { HistoryEntry } from '../src/core/history.js'

// Point the log somewhere throwaway *before* the path module is loaded.
const home = mkdtempSync(path.join(tmpdir(), 'milo-history-'))
process.env.MILO_HOME = home

const { fileHistory, searchHistory, historyDays, historyStatus, trimHistory } = await import(
  '../src/core/history.js'
)
// Imported after the home is pointed at a throwaway directory: a static import
// would be hoisted above the line that sets it and read the real one.
const { runHistory } = await import('../src/bin/history.js')

const historyDir = path.join(home, 'history')

const entry = (over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  at: '2026-09-22T21:00:00.000Z',
  session: 'calm-otter-7',
  scope: 'cli:main',
  kind: 'user',
  text: 'hello',
  ...over,
})

const dayFiles = (): string[] => readdirSync(historyDir).sort()
const readLines = (file: string): string[] =>
  readFileSync(path.join(historyDir, file), 'utf8').trim().split('\n')

describe('fileHistory', () => {
  it('appends one JSON line per entry, in a file only its owner can read', () => {
    fileHistory.append([entry({ text: 'first' }), entry({ text: 'second' })])

    const [file] = dayFiles()
    expect(file).toMatch(/^\d{4}-\d{2}-\d{2}\.jsonl$/)
    expect(readLines(file!).map((line) => JSON.parse(line).text)).toEqual(['first', 'second'])
    expect(statSync(path.join(historyDir, file!)).mode & 0o777).toBe(0o600)
  })

  it('writes nothing when there is nothing to write', () => {
    const before = dayFiles().length
    fileHistory.append([])
    expect(dayFiles().length).toBe(before)
  })
})

describe('searchHistory', () => {
  it('matches every term, whatever the case, newest first', () => {
    fileHistory.append([
      entry({ at: '2026-09-22T20:00:00.000Z', text: 'the fetch_url tool pages a long page' }),
      entry({ at: '2026-09-22T21:00:00.000Z', text: 'another note about the FETCH_URL cache' }),
      entry({ text: 'unrelated' }),
    ])

    expect(searchHistory('fetch_url').map((hit) => hit.at)).toEqual([
      '2026-09-22T21:00:00.000Z',
      '2026-09-22T20:00:00.000Z',
    ])
    expect(searchHistory('fetch_url cache')).toHaveLength(1)
    expect(searchHistory('fetch_url missing')).toEqual([])
  })

  it('searches the reasoning and the tools, not just the words said', () => {
    fileHistory.append([
      entry({
        at: '2026-09-22T22:00:00.000Z',
        kind: 'assistant',
        text: 'done',
        reasoning: 'the page cache is the reason paging is fast',
      }),
      entry({
        at: '2026-09-22T22:01:00.000Z',
        kind: 'tool',
        tool: {
          name: 'fetch_url',
          args: { url: 'https://example.test/doc', offset: 40000 },
          result: 'more text',
          isError: false,
        },
      }),
    ])

    expect(searchHistory('page cache')).toHaveLength(1)
    expect(searchHistory('offset 40000')).toHaveLength(1)
    expect(searchHistory('more text')).toHaveLength(1)
  })

  it('skips a line a crash left half-written', () => {
    const file = path.join(historyDir, dayFiles()[0]!)
    // The good line stays; the torn one is what a kill mid-append leaves behind.
    writeFileSync(
      file,
      `${JSON.stringify(entry({ text: 'the whole line' }))}\n{"at":"2026-09-22T23:00:00.000Z","sess`,
    )

    expect(searchHistory('whole line')).toHaveLength(1)
  })

  it('stops at the limit', () => {
    fileHistory.append([
      entry({ text: 'repeated one' }),
      entry({ text: 'repeated two' }),
      entry({ text: 'repeated three' }),
    ])

    expect(searchHistory('repeated', { limit: 2 })).toHaveLength(2)
  })

  it('only reads the days it was asked for', () => {
    fileHistory.append([entry({ text: 'from today' })])
    mkdirSync(historyDir, { recursive: true })
    writeFileSync(
      path.join(historyDir, '2020-01-01.jsonl'),
      `${JSON.stringify(entry({ at: '2020-01-01T10:00:00.000Z', text: 'from years ago' }))}\n`,
    )

    expect(searchHistory('from today', { days: 1 })).toHaveLength(1)
    expect(searchHistory('years ago', { days: 1 })).toEqual([])
    expect(searchHistory('years ago', { days: 2 })).toHaveLength(1)
  })

  it('finds nothing, quietly, when there is no log yet', () => {
    expect(searchHistory('anything', { dir: path.join(home, 'nowhere') })).toEqual([])
    expect(searchHistory('  ')).toEqual([])
  })
})

describe('the turn index over the log', () => {
  it('reads back what the writer wrote', async () => {
    const { TurnIndex } = await import('../src/core/memory/turns.js')
    fileHistory.append([entry({ text: 'meu editor e o neovim' })])

    // The two halves have to agree on one format, and this is the only test that
    // would catch them drifting apart: the writer writes JSONL, the index reads
    // it, and recall answers from what came out.
    const index = new TurnIndex({ dir: historyDir })
    const hits = await index.recall({ gateway: 'cli', conversationId: 'main' }, 'neovim')
    expect(hits.map((hit) => hit.text)).toEqual(['meu editor e o neovim'])
    index.close()
  })
})

describe('the log on disk', () => {
  it('reports what it costs and which days it spans', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milo-history-status-'))
    writeFileSync(path.join(dir, '2020-01-01.jsonl'), 'x'.repeat(100))
    writeFileSync(path.join(dir, '2020-01-02.jsonl'), 'y'.repeat(50))

    const report = historyStatus(dir)
    expect(report.files).toBe(2)
    expect(report.bytes).toBe(150)
    expect(report.oldest).toBe('2020-01-01')
    expect(report.newest).toBe('2020-01-02')
    expect(historyDays(dir)).toEqual(['2020-01-01', '2020-01-02'])
  })

  it('trims only the days before the date it was given', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milo-history-trim-'))
    for (const day of ['2020-01-01', '2020-06-01', '2026-01-01']) {
      writeFileSync(path.join(dir, `${day}.jsonl`), '{}\n')
    }

    const removed = trimHistory('2025-01-01', dir)
    expect(removed).toEqual(['2020-01-01', '2020-06-01'])
    expect(historyDays(dir)).toEqual(['2026-01-01'])
  })

  it('reports nothing, quietly, when there is no log yet', () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), 'milo-history-empty-')), 'history')
    expect(historyStatus(dir)).toMatchObject({ files: 0, bytes: 0 })
    expect(trimHistory('2025-01-01', dir)).toEqual([])
  })
})

describe('milo history', () => {
  it('prints what the log holds', async () => {
    const lines: string[] = []
    const code = await runHistory(['history'], { out: (line) => lines.push(line), err: () => {} })

    expect(code).toBe(0)
    expect(lines[0]).toMatch(/^\d+ day-file\(s\), /)
  })

  it('refuses a trim with no date, and deletes nothing', async () => {
    const err: string[] = []
    const code = await runHistory(['history', 'trim'], {
      out: () => {},
      err: (line) => err.push(line),
      confirm: async () => true,
    })

    expect(code).toBe(1)
    expect(err.join('\n')).toContain('--older-than')
  })

  it('says there is nothing older instead of deleting', async () => {
    const out: string[] = []
    const code = await runHistory(['history', 'trim', '--before', '1970-01-01'], {
      out: (line) => out.push(line),
      err: () => {},
      confirm: async () => true,
    })

    expect(code).toBe(0)
    expect(out.join('\n')).toContain('Nothing older than')
  })
})
