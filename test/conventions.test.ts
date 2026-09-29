import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { findOutlinedControls, findPortugueseCopy, sourceFiles, type Hit } from './conventions.js'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/** Where the person reads the product: the terminal and chat surfaces, and the web UI. */
const COPY_SURFACES = ['src/gateways', 'web/src']
// `src/core` is deliberately out of scope: it holds domain data that is Portuguese on
// purpose — the lexical memory's stopword list, for one — not copy anyone reads.

function report(hits: Hit[]): string[] {
  return hits.map((hit) => {
    const where = path.relative(repoRoot, hit.file)
    return `${where}:${hit.line} — "${hit.detail}" in: ${hit.text}`
  })
}

const copyFiles = COPY_SURFACES.flatMap((dir) =>
  sourceFiles(path.join(repoRoot, dir), ['.ts', '.tsx', '.css']),
)
const cssFiles = sourceFiles(path.join(repoRoot, 'web/src'), ['.css'])

describe('user-facing copy is English', () => {
  it('writes no Portuguese into the surfaces the person reads', () => {
    const hits = copyFiles.flatMap((file) => findPortugueseCopy(file, readFileSync(file, 'utf8')))

    expect(report(hits)).toEqual([])
  })

  it('scans the surfaces it claims to, so the check above cannot pass on nothing', () => {
    const where = copyFiles.map((file) => path.relative(repoRoot, file))
    expect(where.length).toBeGreaterThan(20)
    expect(where).toContain('src/gateways/actions.ts')
    expect(where).toContain('web/src/chat/MessageList.tsx')
  })

  it('catches Portuguese inside a string, and English that looks like it', () => {
    expect(findPortugueseCopy('x.ts', "push({ label: '◀ Anterior' })")[0]?.detail).toBe('Anterior')
    expect(findPortugueseCopy('x.ts', "push({ label: 'Proxima' })")[0]?.detail).toBe('Proxima')
    expect(findPortugueseCopy('x.ts', "push({ label: 'Next ▶' })")).toEqual([])
    expect(findPortugueseCopy('x.ts', "const error = 'error loading the list'")).toEqual([])
  })

  it('leaves the author’s own prose alone', () => {
    expect(findPortugueseCopy('x.ts', "// 'Não. Em yolo…' reads as one sentence.")).toEqual([])
    expect(findPortugueseCopy('x.ts', "  * a nota, como quem fala // não é copy")).toEqual([])
  })
})

describe('interactive controls are filled, not outlined', () => {
  it('draws no button, card, pill or option with a border', () => {
    const hits = cssFiles.flatMap((file) => findOutlinedControls(file, readFileSync(file, 'utf8')))

    expect(report(hits)).toEqual([])
  })

  it('reads the stylesheet the interface is drawn from', () => {
    expect(cssFiles.map((file) => path.relative(repoRoot, file))).toContain('web/src/styles.css')
  })

  it('leaves a bordered field or panel alone, and flags an outlined control', () => {
    expect(findOutlinedControls('a.css', '.field input { border: 1px solid var(--border); }')).toEqual([])
    expect(findOutlinedControls('a.css', '.notice { border: 1px solid var(--border); }')).toEqual([])
    expect(findOutlinedControls('a.css', '.card { border: 0; }')).toEqual([])
    expect(findOutlinedControls('a.css', '.btn { border: 1px solid red; }')).toHaveLength(1)
    expect(
      findOutlinedControls('a.css', '.session-card { border-inline-start: 3px solid var(--secondary); }'),
    ).toHaveLength(1)
  })

  it('reports the line the selector starts on, inside a media query too', () => {
    const css = [
      '.a { color: red; }',
      '@media (max-width: 720px) {',
      '  .model-option {',
      '    border: 1px solid var(--border);',
      '  }',
      '}',
    ].join('\n')

    const hits = findOutlinedControls('a.css', css)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.line).toBe(3)
    expect(hits[0]?.text).toBe('.model-option')
  })
})
