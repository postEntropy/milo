import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { TURNS_SQL, TurnIndex, turnIndexFile } from '../src/core/memory/turns.js'

const tempDir = () => mkdtempSync(path.join(tmpdir(), 'milo-turns-'))

const scope = { gateway: 'cli', conversationId: 'main' }
const DAY = '2026-09-25'

function entry(kind: string, text: string, extra: Record<string, unknown> = {}) {
  return {
    at: `${DAY}T12:00:00.000Z`,
    session: 'calm-otter-7',
    scope: 'cli:main',
    kind,
    text,
    ...extra,
  }
}

/** One day-file of the log, one entry per line, and nothing else. */
function writeLog(dir: string, lines: unknown[], day = DAY): string {
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${day}.jsonl`)
  writeFileSync(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(''))
  return file
}

/** What the offset table says, which is how a pass records what it has read. */
function offsetOf(index: TurnIndex, name: string): number | undefined {
  const internals = index as unknown as {
    db: {
      prepare: (sql: string) => { get: (...args: unknown[]) => { offset?: number } | undefined }
    }
  }
  return internals.db.prepare('select offset from files where name = ?').get(name)?.offset
}

describe('TurnIndex', () => {
  it('keeps what the person typed and not the replies', async () => {
    const dir = tempDir()
    writeLog(dir, [
      entry('user', 'meu editor e o neovim'),
      entry('assistant', 'a resposta fala de SECRET_REPLY'),
      { ...entry('tool', ''), tool: { name: 'grep', args: {}, result: 'SECRET_TOOL' } },
    ])

    const index = new TurnIndex({ dir })
    expect((await index.recall(scope, 'neovim')).map((hit) => hit.text)).toEqual([
      'meu editor e o neovim',
    ])
    // Replies are reachable through `search_history`, which reads the log itself.
    expect(await index.recall(scope, 'SECRET_REPLY')).toEqual([])
    expect(await index.recall(scope, 'SECRET_TOOL')).toEqual([])
    index.close()
  })

  it('reaches a turn from any session, gateway or day', async () => {
    const dir = tempDir()
    writeLog(
      dir,
      [entry('user', 'a senha gira na segunda', { scope: 'telegram:8924510981' })],
      '2026-01-02',
    )
    writeLog(dir, [entry('user', 'o deploy sai na sexta', { session: 'brave-fox-2' })])

    const index = new TurnIndex({ dir })
    // Asked from a conversation neither of them belongs to: one install, one
    // memory — and no cap on how far back it reads.
    expect((await index.recall(scope, 'senha segunda')).map((hit) => hit.text)).toEqual([
      'a senha gira na segunda',
    ])
    expect(await index.recall(scope, 'segunda sexta deploy')).toHaveLength(2)
    index.close()
  })

  it('keeps to a recency window, dropping the days that fall out', async () => {
    const dir = tempDir()
    writeLog(dir, [entry('user', 'a senha antiga gira na segunda', { at: '2000-01-01T12:00:00.000Z' })], '2000-01-01')
    writeLog(dir, [entry('user', 'o deploy sai hoje')])

    // No window (the default): the whole log is reachable, however old.
    const all = new TurnIndex({ dir })
    expect(await all.recall(scope, 'senha antiga')).toHaveLength(1)
    all.close()

    // A window: the day that fell out is neither read nor kept.
    const windowed = new TurnIndex({ dir, windowDays: 365 })
    expect(await windowed.recall(scope, 'senha antiga')).toEqual([])
    expect(await windowed.recall(scope, 'deploy hoje')).toHaveLength(1)
    windowed.close()

    // Dropped, not merely unfound: reopening without a window does not bring it
    // back, because the row is gone from the index.
    const again = new TurnIndex({ dir })
    expect(await again.recall(scope, 'senha antiga')).toEqual([])
    again.close()
  })

  it('reads only what was appended since the last pass', async () => {
    const dir = tempDir()
    const file = writeLog(dir, [entry('user', 'primeira nota')])

    const index = new TurnIndex({ dir })
    expect(await index.recall(scope, 'primeira')).toHaveLength(1)
    // The pass consumed the file, so the next one has nothing left to read.
    expect(offsetOf(index, `${DAY}.jsonl`)).toBe(statSync(file).size)

    // A turn landing while the process runs: the next question sees it, without
    // the whole day-file being read again.
    const before = statSync(file).size
    appendFileSync(file, `${JSON.stringify(entry('user', 'nota acrescentada depois'))}\n`)
    expect((await index.recall(scope, 'acrescentada')).map((hit) => hit.text)).toEqual([
      'nota acrescentada depois',
    ])
    expect(offsetOf(index, `${DAY}.jsonl`)).toBe(statSync(file).size)
    expect(offsetOf(index, `${DAY}.jsonl`)).toBeGreaterThan(before)
    index.close()
  })

  it('leaves a half-written line for the next pass', async () => {
    const dir = tempDir()
    const half = JSON.stringify(entry('user', 'linha pela metade'))
    const file = writeLog(dir, [entry('user', 'nota inteira')])
    // A turn being written right now: its newline has not landed yet.
    appendFileSync(file, half.slice(0, 20))

    const index = new TurnIndex({ dir })
    expect(await index.recall(scope, 'linha metade')).toEqual([])
    expect(await index.recall(scope, 'inteira')).toHaveLength(1)

    appendFileSync(file, `${half.slice(20)}\n`)
    expect((await index.recall(scope, 'linha metade')).map((hit) => hit.text)).toEqual([
      'linha pela metade',
    ])
    index.close()
  })

  it('keeps one row for a sentence said twice, at the newest telling', async () => {
    const dir = tempDir()
    writeLog(dir, [
      entry('user', 'bom dia', { at: '2026-09-24T10:00:00.000Z' }),
      entry('user', 'Bom  dia', { at: '2026-09-25T09:00:00.000Z' }),
    ])

    const index = new TurnIndex({ dir })
    const hits = await index.recall(scope, 'dia')
    expect(hits).toHaveLength(1)
    expect(hits[0]!.createdAt).toBe(Date.parse('2026-09-25T09:00:00.000Z'))
    index.close()
  })

  it('matches with or without the accent', async () => {
    const dir = tempDir()
    writeLog(dir, [entry('user', 'a configuração do proxy está pronta')])

    const index = new TurnIndex({ dir })
    expect(await index.recall(scope, 'configuracao')).toHaveLength(1)
    expect(await index.recall(scope, 'configuração')).toHaveLength(1)
    index.close()
  })

  it('answers nothing for a question that is all filler', async () => {
    const dir = tempDir()
    writeLog(dir, [entry('user', 'qualquer coisa')])

    const index = new TurnIndex({ dir })
    expect(await index.recall(scope, 'the of and')).toEqual([])
    index.close()
  })

  it('says nothing when there is no log yet', async () => {
    const index = new TurnIndex({ dir: path.join(tempDir(), 'history') })
    expect(await index.recall(scope, 'qualquer coisa')).toEqual([])
    index.close()
  })

  it('rebuilds itself from the log when its file is gone', async () => {
    const dir = tempDir()
    writeLog(dir, [entry('user', 'a memoria e do install')])

    const first = new TurnIndex({ dir })
    expect(await first.recall(scope, 'install')).toHaveLength(1)
    first.close()

    // Derived and disposable: the log is the record, so the index is a cache of
    // it and never the thing that holds the only copy.
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(`${turnIndexFile(dir)}${suffix}`, { force: true })
    }
    const rebuilt = new TurnIndex({ dir })
    expect((await rebuilt.recall(scope, 'install')).map((hit) => hit.text)).toEqual([
      'a memoria e do install',
    ])
    rebuilt.close()
  })

  it('throws away a database it cannot open rather than failing recall', async () => {
    const dir = tempDir()
    writeLog(dir, [entry('user', 'a senha gira na segunda')])
    writeFileSync(turnIndexFile(dir), 'not a database at all')

    const index = new TurnIndex({ dir })
    expect((await index.recall(scope, 'senha')).map((hit) => hit.text)).toEqual([
      'a senha gira na segunda',
    ])
    index.close()
  })

  it('drives the query from the index instead of probing it once per row', async () => {
    const dir = tempDir()
    writeLog(
      dir,
      Array.from({ length: 500 }, (_, i) =>
        entry(
          'user',
          i % 50 === 0
            ? `a tag de release e v0.${i}`
            : `nota ${i} sobre o modulo de deploy do servidor`,
        ),
      ),
    )

    const index = new TurnIndex({ dir })
    // White-box for the same reason as the facts store: both plans return the
    // same rows, and the wrong one walks the table probing the index per row.
    const internals = index as unknown as {
      db: { prepare: (sql: string) => { all: (...args: unknown[]) => { detail: string }[] } }
    }
    const plan = internals.db
      .prepare(`explain query plan ${TURNS_SQL}`)
      .all('deploy', 5)
      .map((row) => row.detail)

    expect(plan[0]).toContain('turns_fts')
    expect(plan.join(' | ')).not.toMatch(/\bSCAN (t|turns)\b/)
    index.close()
  })
})
