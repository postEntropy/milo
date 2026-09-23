import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// Point the app at a throwaway home *before* the module under test loads.
const home = mkdtempSync(path.join(tmpdir(), 'milo-input-history-'))
process.env.MILO_HOME = home

const { readInputHistory, saveInputHistory } = await import('../src/gateways/cli/input-history.js')

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
})
