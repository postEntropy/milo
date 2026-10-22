/**
 * Syntax colouring, decided once for every surface that draws code: the diff of a project's
 * folder, a fenced block in a reply, a file read back.
 *
 * Roles, not colours — this says what a run of characters *is*, and each surface paints that
 * role with its own palette (`--code-*` in `web/src/styles.css`, `MiloTheme` on the phone,
 * `theme.ts` in the terminal). The browser and the phone must agree about the roles, so the
 * Swift port in `ios/Highlight` is held to the cases in `test/fixtures/highlight.json`.
 *
 * Families, not grammars: a language here is a comment syntax, a keyword list, and whether it
 * quotes with backticks or triple quotes. This is not a parser — the point is that reading code
 * is pleasant, never that every token is placed by a specification.
 */

export type CodeRole = 'plain' | 'comment' | 'string' | 'number' | 'keyword'

/** One run of characters: the whole of `code` lands in runs, in order, with nothing between. */
export type CodeRun = { role: CodeRole; text: string }

/** The languages this colours. `plain` is text we have no rules for: strings and numbers only. */
export type CodeLanguage =
  | 'ts'
  | 'js'
  | 'swift'
  | 'rust'
  | 'python'
  | 'shell'
  | 'css'
  | 'json'
  | 'yaml'
  | 'ruby'
  | 'plain'

/** How a language marks a comment. `none` is JSON, which has none. */
type Family = 'slash' | 'hash' | 'none'

const FAMILY: Record<CodeLanguage, Family> = {
  ts: 'slash',
  js: 'slash',
  swift: 'slash',
  rust: 'slash',
  css: 'slash',
  json: 'none',
  yaml: 'hash',
  python: 'hash',
  shell: 'hash',
  ruby: 'hash',
  plain: 'none',
}

/**
 * The marks a string opens with, per language. Rust and Swift have no `'` quote at all — a `'`
 * there opens a lifetime or a character — and JSON has none either, so reading one as a quote
 * would colour half a line that is not a string. A backtick is JavaScript's template, written
 * to span lines.
 */
const QUOTES: Record<CodeLanguage, string[]> = {
  ts: ['"', "'", '`'],
  js: ['"', "'", '`'],
  swift: ['"'],
  rust: ['"'],
  python: ['"', "'"],
  shell: ['"', "'"],
  css: ['"', "'"],
  json: ['"'],
  yaml: ['"', "'"],
  ruby: ['"', "'"],
  plain: ['"', "'"],
}

/**
 * What carries meaning in each language. Deliberately short: a word list is what a reader
 * recognises at a glance, and a longer one (every builtin, every framework name) turns a block
 * into confetti.
 */
const OWN_KEYWORDS: Record<CodeLanguage, string[]> = {
  ts: [
    'abstract',
    'any',
    'as',
    'async',
    'await',
    'break',
    'case',
    'catch',
    'class',
    'const',
    'continue',
    'declare',
    'default',
    'delete',
    'do',
    'else',
    'enum',
    'export',
    'extends',
    'finally',
    'for',
    'from',
    'function',
    'if',
    'implements',
    'import',
    'in',
    'instanceof',
    'interface',
    'let',
    'new',
    'of',
    'readonly',
    'return',
    'satisfies',
    'static',
    'super',
    'switch',
    'this',
    'throw',
    'try',
    'type',
    'typeof',
    'var',
    'void',
    'while',
    'yield',
  ],
  js: [
    'async',
    'await',
    'break',
    'case',
    'catch',
    'class',
    'const',
    'continue',
    'default',
    'delete',
    'do',
    'else',
    'export',
    'extends',
    'finally',
    'for',
    'from',
    'function',
    'if',
    'import',
    'in',
    'instanceof',
    'let',
    'new',
    'of',
    'return',
    'static',
    'super',
    'switch',
    'this',
    'throw',
    'try',
    'typeof',
    'var',
    'void',
    'while',
    'yield',
  ],
  swift: [
    'actor',
    'any',
    'as',
    'async',
    'await',
    'break',
    'case',
    'catch',
    'class',
    'continue',
    'default',
    'defer',
    'deinit',
    'do',
    'else',
    'enum',
    'extension',
    'fileprivate',
    'final',
    'for',
    'func',
    'guard',
    'if',
    'import',
    'in',
    'init',
    'internal',
    'is',
    'lazy',
    'let',
    'open',
    'override',
    'private',
    'protocol',
    'public',
    'repeat',
    'return',
    'self',
    'some',
    'static',
    'struct',
    'switch',
    'throw',
    'throws',
    'try',
    'typealias',
    'var',
    'weak',
    'where',
    'while',
  ],
  rust: [
    'as',
    'async',
    'await',
    'break',
    'const',
    'continue',
    'crate',
    'dyn',
    'else',
    'enum',
    'extern',
    'fn',
    'for',
    'if',
    'impl',
    'in',
    'let',
    'loop',
    'match',
    'mod',
    'move',
    'mut',
    'pub',
    'ref',
    'return',
    'self',
    'Self',
    'static',
    'struct',
    'super',
    'trait',
    'type',
    'unsafe',
    'use',
    'where',
    'while',
  ],
  python: [
    'and',
    'as',
    'assert',
    'async',
    'await',
    'break',
    'class',
    'continue',
    'def',
    'del',
    'elif',
    'else',
    'except',
    'finally',
    'for',
    'from',
    'global',
    'if',
    'import',
    'in',
    'is',
    'lambda',
    'nonlocal',
    'not',
    'or',
    'pass',
    'raise',
    'return',
    'self',
    'try',
    'while',
    'with',
    'yield',
  ],
  shell: [
    'case',
    'do',
    'done',
    'elif',
    'else',
    'esac',
    'exit',
    'export',
    'fi',
    'for',
    'function',
    'if',
    'in',
    'local',
    'readonly',
    'return',
    'set',
    'shift',
    'then',
    'trap',
    'unset',
    'until',
    'while',
  ],
  css: [],
  json: [],
  yaml: [],
  ruby: [
    'begin',
    'break',
    'case',
    'class',
    'def',
    'do',
    'else',
    'elsif',
    'end',
    'ensure',
    'for',
    'if',
    'in',
    'module',
    'next',
    'require',
    'rescue',
    'return',
    'self',
    'then',
    'unless',
    'until',
    'when',
    'while',
    'yield',
  ],
  plain: [],
}

/** The words every language reads the same way, appended to whatever it knows of its own. */
const LITERALS = ['false', 'nil', 'none', 'null', 'true', 'undefined']

const KEYWORDS = new Map<CodeLanguage, Set<string>>(
  (Object.keys(OWN_KEYWORDS) as CodeLanguage[]).map((language) => [
    language,
    new Set([...OWN_KEYWORDS[language], ...LITERALS]),
  ]),
)

/**
 * A fence's tag, or a file's own name, to one of the languages above.
 *
 * A hint we do not know — a `haskell` fence, a `.hbs` file — is `plain` rather than a guess, since
 * colouring by the wrong rules is worse than not colouring. A *missing* hint is the exception:
 * a fence the model opened without a tag is most often TypeScript or JavaScript, which is what
 * `ts` is here, and the one thing that loses is a `#` comment that is not a comment.
 */
export function languageOf(hint?: string): CodeLanguage {
  const named = hint?.trim().toLowerCase() ?? ''
  if (named === '') return 'ts'
  const file = named.split(/[\\/]/).pop() ?? named
  const direct = ALIASES[file]
  if (direct) return direct
  const dot = file.lastIndexOf('.')
  if (dot === -1) return 'plain'
  return ALIASES[file.slice(dot + 1)] ?? 'plain'
}

const ALIASES: Record<string, CodeLanguage> = {
  ts: 'ts',
  tsx: 'ts',
  mts: 'ts',
  cts: 'ts',
  typescript: 'ts',
  js: 'js',
  jsx: 'js',
  mjs: 'js',
  cjs: 'js',
  javascript: 'js',
  swift: 'swift',
  rust: 'rust',
  rs: 'rust',
  py: 'python',
  python: 'python',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  shell: 'shell',
  console: 'shell',
  dockerfile: 'shell',
  makefile: 'shell',
  css: 'css',
  scss: 'css',
  less: 'css',
  json: 'json',
  jsonc: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  rb: 'ruby',
  ruby: 'ruby',
  md: 'plain',
  markdown: 'plain',
  txt: 'plain',
  text: 'plain',
  log: 'plain',
}

/**
 * The runs of one piece of code. Every character lands in exactly one run, so a surface can
 * draw them one after another without adding anything between them — and adjacent runs of the
 * same role are one run, so a renderer does not close and reopen a colour at every character.
 */
export function highlight(code: string, language?: string): CodeRun[] {
  const lang = languageOf(language)
  const family = FAMILY[lang]
  const quotes = QUOTES[lang]
  const keywords = KEYWORDS.get(lang) ?? new Set<string>()
  const runs: CodeRun[] = []

  const push = (role: CodeRole, text: string): void => {
    if (text === '') return
    const last = runs[runs.length - 1]
    if (last !== undefined && last.role === role) last.text += text
    else runs.push({ role, text })
  }

  let i = 0
  while (i < code.length) {
    const char = code[i]!

    // A comment runs to the end of its line, or to the `*/` that closes it — and an unclosed
    // one takes the rest of the block, which is what a reply still streaming looks like.
    if (family === 'slash' && code.startsWith('//', i)) {
      const end = lineEnd(code, i)
      push('comment', code.slice(i, end))
      i = end
      continue
    }
    if (family === 'slash' && code.startsWith('/*', i)) {
      const close = code.indexOf('*/', i + 2)
      const end = close === -1 ? code.length : close + 2
      push('comment', code.slice(i, end))
      i = end
      continue
    }
    if (family === 'hash' && char === '#') {
      const end = lineEnd(code, i)
      push('comment', code.slice(i, end))
      i = end
      continue
    }

    // A triple quote is a string that runs past its own line — Python's one way of writing
    // prose inside code.
    if (lang === 'python' && (code.startsWith('"""', i) || code.startsWith("'''", i))) {
      const fence = code.slice(i, i + 3)
      const close = code.indexOf(fence, i + 3)
      const end = close === -1 ? code.length : close + 3
      push('string', code.slice(i, end))
      i = end
      continue
    }

    // A quoted string ends at its own closing quote on the same line: a lone apostrophe in a
    // sentence is not a string, and one left open would otherwise swallow the rest of a file.
    // A backtick (JavaScript's template) is the exception, because it is written to span lines.
    if (quotes.includes(char)) {
      const end = stringEnd(code, i, char, char === '`')
      if (end === -1) {
        push('plain', char)
        i += 1
        continue
      }
      push('string', code.slice(i, end))
      i = end
      continue
    }

    if (isDigit(char) || (char === '.' && isDigit(code[i + 1]))) {
      const end = numberEnd(code, i)
      push('number', code.slice(i, end))
      i = end
      continue
    }

    if (isIdentifierStart(char)) {
      const end = identifierEnd(code, i)
      const word = code.slice(i, end)
      push(keywords.has(word) ? 'keyword' : 'plain', word)
      i = end
      continue
    }

    push('plain', char)
    i += 1
  }

  return runs
}

/** Where the line holding `from` ends — the newline itself belongs to the line before it. */
function lineEnd(code: string, from: number): number {
  const newline = code.indexOf('\n', from)
  return newline === -1 ? code.length : newline
}

/**
 * Where a string opened at `from` ends, closing quote included — or -1 when nothing closed it,
 * which leaves the quote to stand for itself.
 */
function stringEnd(code: string, from: number, quote: string, across: boolean): number {
  const stop = across ? code.length : lineEnd(code, from)
  let i = from + 1
  while (i < stop) {
    if (code[i] === '\\') {
      i += 2
      continue
    }
    if (code[i] === quote) return i + 1
    i += 1
  }
  return across ? code.length : -1
}

/** Where the number starting at `from` ends: digits, `_` separators, one dot, and a hex tail. */
function numberEnd(code: string, from: number): number {
  let i = from
  if (code[i] === '0' && (code[i + 1] === 'x' || code[i + 1] === 'X')) {
    i += 2
    while (i < code.length && /[0-9a-fA-F_]/.test(code[i]!)) i += 1
    return i
  }
  let dot = false
  while (i < code.length) {
    const char = code[i]!
    if (isDigit(char) || char === '_') {
      i += 1
      continue
    }
    if (char === '.' && !dot) {
      dot = true
      i += 1
      continue
    }
    break
  }
  return i
}

function identifierEnd(code: string, from: number): number {
  let i = from
  while (i < code.length && isIdentifierPart(code[i]!)) i += 1
  return i
}

function isIdentifierStart(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z_$]/.test(char)
}

function isIdentifierPart(char: string): boolean {
  return /[A-Za-z0-9_$]/.test(char)
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= '0' && char <= '9'
}
