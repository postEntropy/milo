import { readdirSync } from 'node:fs'
import path from 'node:path'

export interface Hit {
  file: string
  line: number
  text: string
  detail: string
}

/**
 * Portuguese words with no English homograph, so one whole word on a line of a surface
 * means the copy was written in the wrong language. Both spellings of each word count,
 * because dropping the accent is as wrong as writing it in Portuguese.
 */
const PORTUGUESE_WORDS = [
  'anterior',
  'anteriormente',
  'próximo',
  'próxima',
  'próximos',
  'próximas',
  'proximo',
  'proxima',
  'proximos',
  'proximas',
  'sessão',
  'sessões',
  'sessao',
  'sessoes',
  'não',
  'nao',
  'você',
  'voce',
  'usuário',
  'usuarios',
  'arquivo',
  'arquivos',
  'erro',
  'erros',
  'cancelar',
  'salvar',
  'nenhum',
  'nenhuma',
  'carregando',
  'enviar',
  'enviado',
  'voltar',
  'fechar',
  'abrir',
  'remover',
  'adicionar',
  'configuração',
  'configurações',
  'memória',
  'memoria',
  'tentativa',
  'selecione',
  'selecionar',
  'selecionado',
  'ativar',
  'desativar',
  'mensagem',
  'conversa',
  'pergunta',
  'resposta',
  'atalho',
  'iniciar',
  'pronto',
  'talvez',
]

const COPY_WORD = new RegExp(`\\b(?:${PORTUGUESE_WORDS.join('|')})\\b`, 'iu')

/** A whole line the author meant as prose rather than as something the person reads. */
function isComment(line: string): boolean {
  const trimmed = line.trimStart()
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
}

/** Portuguese copy in a source file, one hit per offending line. */
export function findPortugueseCopy(file: string, source: string): Hit[] {
  return source.split('\n').flatMap((line, index) => {
    if (isComment(line)) return []
    const match = COPY_WORD.exec(line)
    if (!match) return []
    return [{ file, line: index + 1, text: line.trim(), detail: match[0] }]
  })
}

/** Every file under `dir` with one of `extensions`, sorted so the report is stable. */
export function sourceFiles(dir: string, extensions: string[]): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...sourceFiles(full, extensions))
    else if (extensions.includes(path.extname(entry.name))) found.push(full)
  }
  return found.sort()
}

/** Selectors whose rule draws something the person presses. */
const CONTROL_SELECTOR = /button|btn|card|pill|tab|option/i

const BORDER_WIDTH =
  /border(?:-(?:inline|block)(?:-(?:start|end))?|-(?:top|right|bottom|left))?:\s*([\d.]+)px/gi

interface RuleBlock {
  selector: string
  body: string
  line: number
}

/** The line a character offset sits on. */
function lineAt(css: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset; i++) if (css[i] === '\n') line++
  return line
}

/**
 * Every rule in a stylesheet with the line its selector starts on, comments skipped so
 * a commented-out rule is not read as a live one.
 */
function ruleBlocks(css: string): RuleBlock[] {
  const blocks: RuleBlock[] = []
  const open: { selector: string; line: number }[] = []
  let selectorFrom = 0

  for (let i = 0; i < css.length; i++) {
    if (css[i] === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2)
      i = end === -1 ? css.length : end + 1
      selectorFrom = i + 1
      continue
    }
    if (css[i] === '{') {
      const raw = css.slice(selectorFrom, i)
      const start = selectorFrom + (raw.length - raw.trimStart().length)
      open.push({ selector: raw.trim().replace(/\s+/g, ' '), line: lineAt(css, start) })
      selectorFrom = i + 1
      continue
    }
    if (css[i] === '}') {
      const opened = open.pop()
      if (opened) blocks.push({ ...opened, body: css.slice(selectorFrom, i) })
      selectorFrom = i + 1
    }
  }

  return blocks.sort((a, b) => a.line - b.line)
}

/**
 * Controls drawn with an outline instead of the filled surface this house uses. Fields,
 * panels and content chrome may carry a border; something the person presses may not.
 */
export function findOutlinedControls(file: string, css: string): Hit[] {
  const hits: Hit[] = []
  for (const block of ruleBlocks(css)) {
    if (!CONTROL_SELECTOR.test(block.selector)) continue
    for (const match of block.body.matchAll(BORDER_WIDTH)) {
      if (Number(match[1]) === 0) continue
      hits.push({
        file,
        line: block.line,
        text: block.selector,
        detail: match[0].replace(/\s+/g, ' ').trim(),
      })
    }
  }
  return hits
}
