import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { highlight, languageOf, type CodeLanguage, type CodeRole } from '../src/core/highlight.js'

/**
 * The cases both the browser and the phone colour.
 *
 * The lexer exists twice — `src/core/highlight.ts` and `MiloHighlight` in `ios/Highlight` —
 * because the two surfaces have no runtime in common. The cases live in one file, as data, so
 * a divergence has to fail a build on one side rather than show up as the same code coloured
 * two different ways on the two surfaces.
 */
interface RunCase {
  role: CodeRole
  text: string
}
interface HighlightCase {
  name: string
  language: string | null
  code: string
  runs: RunCase[]
}
interface NameCase {
  name: string
  language: CodeLanguage
}
const fixtures: { languageOf: NameCase[]; highlight: HighlightCase[] } = JSON.parse(
  readFileSync(new URL('./fixtures/highlight.json', import.meta.url), 'utf8'),
)

describe('a file name or a fence tag', () => {
  for (const testCase of fixtures.languageOf) {
    it(`reads ${JSON.stringify(testCase.name)} as ${testCase.language}`, () => {
      expect(languageOf(testCase.name)).toBe(testCase.language)
    })
  }
})

describe('a piece of code', () => {
  for (const testCase of fixtures.highlight) {
    it(testCase.name, () => {
      expect(highlight(testCase.code, testCase.language ?? undefined)).toEqual(testCase.runs)
    })
  }
})

describe('what a block of runs promises a renderer', () => {
  const code = 'const a = 1 // one\n/* two */ "three" `four`\nif (a) { a += 0x1f }'

  it('gives back every character, in order, with nothing between the runs', () => {
    expect(highlight(code, 'ts').map((run) => run.text).join('')).toBe(code)
  })

  it('never leaves two runs of the same role touching', () => {
    const runs = highlight(code, 'ts')
    for (let i = 1; i < runs.length; i += 1) {
      expect(runs[i]!.role).not.toBe(runs[i - 1]!.role)
    }
  })
})
