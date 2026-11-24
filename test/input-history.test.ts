import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// Point the app at a throwaway home *before* the module under test loads.
const home = mkdtempSync(path.join(tmpdir(), 'milo-input-history-'))
process.env.MILO_HOME = home

const { appendInputHistory, readInputHistory, saveInputHistory } = await import(
  '../src/gateways/cli/input-history.js'
)
const { REDACTED_SECRET } = await import('../src/core/secrets.js')

const file = path.join(home, 'input-history.json')

describe('input history on disk', () => {
  afterEach(() => rmSync(file, { force: true }))

  it('comes back in the order it was sent', async () => {
    await saveInputHistory(['primeira', 'segunda'])
    expect(readInputHistory()).toEqual(['primeira', 'segunda'])
  })

  it('starts empty when there is no file yet', () => {
    expect(readInputHistory()).toEqual([])
  })

  it('drops a file it cannot read instead of failing the chat', () => {
    writeFileSync(file, '{ not json')
    expect(readInputHistory()).toEqual([])
  })

  it('keeps only the lines, whatever else is in the file', () => {
    writeFileSync(file, JSON.stringify(['ok', 42, null, '', '   ', 'também']))
    expect(readInputHistory()).toEqual(['ok', 'também'])
  })

  it('redacts secrets before appending, deduplicates after redaction, and preserves arrow navigation order', async () => {
    let history: string[] = []
    history = appendInputHistory(history, 'ls -la', 10)
    history = appendInputHistory(history, 'senha: DummyCliSecret1!', 10)
    history = appendInputHistory(history, 'senha: DummyCliSecret2!', 10)
    history = appendInputHistory(history, 'pwd', 10)

    expect(history).toEqual(['ls -la', `senha: ${REDACTED_SECRET}`, 'pwd'])

    await saveInputHistory(history)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const raw = readFileSync(file, 'utf8')
    expect(raw).not.toContain('DummyCliSecret1!')
    expect(raw).not.toContain('DummyCliSecret2!')
    expect(readInputHistory()).toEqual(['ls -la', `senha: ${REDACTED_SECRET}`, 'pwd'])
  })

  it('redacts entries passed directly to saveInputHistory', async () => {
    await saveInputHistory(['password: DirectSaveSecret99!'])
    expect(readFileSync(file, 'utf8')).not.toContain('DirectSaveSecret99!')
    expect(readInputHistory()).toEqual([`password: ${REDACTED_SECRET}`])
  })
})
