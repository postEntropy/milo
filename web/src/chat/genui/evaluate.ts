/**
 * The values of a widget's inputs, by input id.
 */
export interface GenUiDateRangeValue {
  from: string
  to: string
}

export type GenUiInputValue = number | string | boolean | string[] | GenUiDateRangeValue
export type GenUiValues = Record<string, GenUiInputValue>

type Token =
  | { kind: 'number'; value: number }
  | { kind: 'ident'; name: string }
  | { kind: 'op'; op: string }

interface Cursor {
  tokens: Token[]
  at: number
}

/**
 * A widget's `stat` formula, evaluated without `eval`.
 *
 * The grammar is the whole of it: numbers, input ids, `+ - * /` and parentheses.
 * There is nothing else to express — no calls, no property access, no strings —
 * so a tree can carry arithmetic and nothing more, which is the entire reason no
 * sandbox is needed. A formula that does not parse, reads an id that is not a
 * number, or comes out non-finite (a division by zero) is null, and the renderer
 * shows a dash rather than a wrong number.
 */
export function evaluateFormula(formula: string, values: GenUiValues): number | null {
  const tokens = tokenize(formula)
  if (!tokens) return null
  const cursor: Cursor = { tokens, at: 0 }
  const value = expression(cursor, values)
  if (value === null || cursor.at !== tokens.length) return null
  return Number.isFinite(value) ? value : null
}

/** A number as the widget shows it, at the decimal places asked for. */
export function formatNumber(value: number, decimals?: number): string {
  const places = decimals ?? (Number.isInteger(value) ? 0 : 2)
  return value.toLocaleString(undefined, { minimumFractionDigits: places, maximumFractionDigits: places })
}

/** A `text` node with its `{id}` references filled in from the current inputs. */
export function interpolate(text: string, values: GenUiValues): string {
  return text.replace(/\{([A-Za-z][A-Za-z0-9_]{0,31})\}/g, (whole, name: string) => {
    const value = values[name]
    if (value === undefined) return whole
    return typeof value === 'number'
      ? formatNumber(value)
      : Array.isArray(value)
        ? value.join(', ')
        : typeof value === 'object'
          ? `${value.from} – ${value.to}`
          : String(value)
  })
}

function tokenize(input: string): Token[] | null {
  const tokens: Token[] = []
  let index = 0
  while (index < input.length) {
    const char = input[index]!
    if (char === ' ' || char === '\t') {
      index += 1
      continue
    }
    if ('+-*/()'.includes(char)) {
      tokens.push({ kind: 'op', op: char })
      index += 1
      continue
    }
    if (char >= '0' && char <= '9') {
      const match = /^[0-9]*\.?[0-9]+/.exec(input.slice(index))
      if (!match) return null
      tokens.push({ kind: 'number', value: Number(match[0]) })
      index += match[0].length
      continue
    }
    if (char === '_' || (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z')) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(input.slice(index))
      if (!match) return null
      tokens.push({ kind: 'ident', name: match[0] })
      index += match[0].length
      continue
    }
    return null
  }
  return tokens
}

/** `term (('+' | '-') term)*` */
function expression(cursor: Cursor, values: GenUiValues): number | null {
  let left = term(cursor, values)
  if (left === null) return null
  while (cursor.at < cursor.tokens.length) {
    const token = cursor.tokens[cursor.at]!
    if (token.kind !== 'op' || (token.op !== '+' && token.op !== '-')) break
    cursor.at += 1
    const right = term(cursor, values)
    if (right === null) return null
    left = token.op === '+' ? left + right : left - right
  }
  return left
}

/** `factor (('*' | '/') factor)*` */
function term(cursor: Cursor, values: GenUiValues): number | null {
  let left = factor(cursor, values)
  if (left === null) return null
  while (cursor.at < cursor.tokens.length) {
    const token = cursor.tokens[cursor.at]!
    if (token.kind !== 'op' || (token.op !== '*' && token.op !== '/')) break
    cursor.at += 1
    const right = factor(cursor, values)
    if (right === null) return null
    left = token.op === '*' ? left * right : left / right
  }
  return left
}

/** A signed number, an input id, or a parenthesised expression. */
function factor(cursor: Cursor, values: GenUiValues): number | null {
  const token = cursor.tokens[cursor.at]
  if (!token) return null
  if (token.kind === 'op' && token.op === '-') {
    cursor.at += 1
    const value = factor(cursor, values)
    return value === null ? null : -value
  }
  if (token.kind === 'op' && token.op === '+') {
    cursor.at += 1
    return factor(cursor, values)
  }
  if (token.kind === 'op' && token.op === '(') {
    cursor.at += 1
    const value = expression(cursor, values)
    if (value === null) return null
    const close = cursor.tokens[cursor.at]
    if (close?.kind !== 'op' || close?.op !== ')') return null
    cursor.at += 1
    return value
  }
  if (token.kind === 'number') {
    cursor.at += 1
    return token.value
  }
  if (token.kind === 'ident') {
    cursor.at += 1
    return numberValue(values[token.name])
  }
  return null
}

function numberValue(value: GenUiInputValue | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean') return value ? 1 : 0
  return null
}
