/**
 * A provider's refusal, read once.
 *
 * The body is kept as well as the sentence a screen shows: a provider may name the
 * limit it would accept in the refusal itself, and that is what lets the request be
 * asked again correctly instead of failing the turn over a catalog that lied.
 */
export interface ProviderFailure {
  /** The sentence a surface shows: the status, and the reason the body holds. */
  message: string
  /** The body's own words, uncut from the sentence — where a stated limit is read. */
  detail: string
}

/** The most of a refusal this keeps: one body, not a page of a proxy's HTML. */
const MAX_DETAIL = 4_000

/** The most of a reason this puts on one line: enough for the provider's own sentence. */
const MAX_REASON = 500

/**
 * Reads a failed response's body and turns it into the sentence a person reads. Bodies
 * differ per vendor, and some nest a JSON string inside JSON; both are read here, so a
 * screen says what the provider said rather than pasting the envelope around it.
 */
export async function readFailure(response: Response): Promise<ProviderFailure> {
  let detail = ''
  try {
    detail = (await response.text()).slice(0, MAX_DETAIL)
  } catch {
    // A body that cannot be read is a refusal with no words to add.
  }
  const reason = reasonOf(detail).slice(0, MAX_REASON)
  return {
    message: `Provider request failed (${response.status} ${response.statusText})${reason ? `: ${reason}` : ''}`,
    detail,
  }
}

/**
 * The highest output ceiling a refusal names, when it refused one. Vendors spell the
 * limit differently; the shapes below are the ones seen in the wild, and anything else
 * is surfaced rather than guessed at.
 */
export function outputTokenCap(detail: string): number | undefined {
  const patterns = [
    /max_tokens[^0-9]*\(current value:\s*\d+\)\s*must be between\s+\d+\s+and\s+(\d+)/i,
    /max_tokens[^0-9]*(?:must be|is)\s+(?:less than or equal to|at most|no more than)\s+(\d+)/i,
    /max_tokens:\s*\d+\s*>\s*(\d+)/i,
    /maximum allowed number of output tokens[^0-9]*(\d+)/i,
  ]
  for (const pattern of patterns) {
    const found = detail.match(pattern)
    if (found) return Number(found[1])
  }
  return undefined
}

/**
 * The ceiling to ask for: what was wanted, lowered to the limit a provider stated.
 * A request with no ceiling of its own is given the provider's, since asking for its
 * own maximum is how a long answer keeps all the room the route allows.
 */
export function clampOutput(tokens: number | undefined, cap: number | undefined): number | undefined {
  if (cap === undefined) return tokens
  return tokens === undefined ? cap : Math.min(tokens, cap)
}

/** The reason inside a body: the deepest `error.message` / `message` it carries. */
function reasonOf(detail: string): string {
  const text = detail.trim()
  if (!text) return ''
  return reasonValue(parseJson(text) ?? text) ?? text
}

function reasonValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text) return undefined
    // `{"error":{"message":"{\"code\":400,...}"}}` is a body inside a body.
    const parsed = parseJson(text)
    return parsed === undefined ? text : (reasonValue(parsed) ?? text)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined

  const record = value as Record<string, unknown>
  const nested = reasonValue(record.error)
  if (nested) return nested
  for (const key of ['message', 'detail', 'reason']) {
    const reason = reasonValue(record[key])
    if (reason) return reason
  }
  return undefined
}

function parseJson(text: string): unknown {
  if (!text.startsWith('{') && !text.startsWith('[')) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}
