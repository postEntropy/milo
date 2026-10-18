import { useMemo } from 'react'
import { highlight, type CodeRole } from '../../../src/core/highlight.js'

/**
 * Code, coloured — the one place the roles `src/core/highlight.ts` reads out of a block become
 * this surface's classes. The phone draws those same roles from the same lexer's Swift port,
 * so one fence does not read two ways.
 *
 * Two shapes because the two callers need different things: the markdown renderer hands its
 * result over as an HTML string, while the screens build elements of their own.
 */

/** The class each role is drawn as. The one table — neither shape names a role of its own. */
const CODE_CLASS: Record<CodeRole, string> = {
  plain: 'code-plain',
  comment: 'code-comment',
  string: 'code-string',
  number: 'code-number',
  keyword: 'code-keyword',
}

/** One block of code, as the screens draw it. */
export function Code({ code, language }: { code: string; language?: string }) {
  const runs = useMemo(() => keyed(code, language), [code, language])
  return <>{runs.map((run) => <span className={CODE_CLASS[run.role]} key={run.key}>{run.text}</span>)}</>
}

/** The same runs as HTML, for the renderer whose result is handed over as a string. */
export function codeHtml(code: string, language?: string): string {
  return highlight(code, language)
    .map((run) => `<span class="${CODE_CLASS[run.role]}">${escapeHtml(run.text)}</span>`)
    .join('')
}

/**
 * A run's text is not a key on its own — a line repeating a word repeats the run — so each
 * text carries how many times it has come before, the way the thread keys its duplicates.
 */
function keyed(code: string, language?: string): { role: CodeRole; text: string; key: string }[] {
  const seen = new Map<string, number>()
  return highlight(code, language).map((run) => {
    const occurrence = seen.get(run.text) ?? 0
    seen.set(run.text, occurrence + 1)
    return { role: run.role, text: run.text, key: `${run.role}:${run.text}:${occurrence}` }
  })
}

/** The three characters that would otherwise be read as markup: a run is text and only text. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
