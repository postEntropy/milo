export const REDACTED_SECRET = '[redacted secret]'
export const REDACTED_PRIVATE_KEY = '[redacted private key]'

export const SECRET_REDACTED_NOTICE =
  'A possible secret or credential in your message was redacted before saving or sending it.'

export const SECRET_REDACTED_INSTRUCTION =
  'Note: A possible secret or credential in the user message was automatically redacted to [redacted secret] before saving or sending. Do not ask the user to send secrets in chat and do not treat the placeholder as a literal credential.'

const PRIVATE_KEY_RE =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g

const TOKEN_RE =
  /\b(?:sk-(?:proj-|svcacct-|or-v1-|ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z_-]{35}|(?:AKIA|ASIA)[0-9A-Z]{16}|xox[baprs]-[0-9A-Za-z-]{10,}|[rs]k_(?:live|test)_[0-9a-zA-Z]{16,}|\d{8,12}:[A-Za-z0-9_-]{30,}|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g

const URL_CREDENTIALS_RE = /(\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/\s:@]+:)([^@\s]+)(@)/g

const AUTH_HEADER_RE = /(\bAuthorization\s*:\s*(?:Bearer|Basic|Token)\s+)([^\s"']+)/gi
const BEARER_RE = /(\bBearer\s+)([A-Za-z0-9._~+/=-]{16,})/gi

const ENV_ASSIGNMENT_RE =
  /(\b[A-Z][A-Z0-9_]*(?:_KEY|_SECRET|_TOKEN|_PASSWORD|_PASSWD|_PWD|_CREDENTIAL|_CREDENTIALS)\s*=\s*)(?:"([^"\n]+)"|'([^'\n]+)'|([^\s,;]+))/g

const LABELED_SECRET_RE =
  /(\b(?:(?:minha|sua|my|your)\s+)?(?:senha|password|passwd|pwd|passcode|passphrase|pin|otp|cvv|cvc|api[_ -]?key|client[_ -]?secret|access[_ -]?token|refresh[_ -]?token|auth[_ -]?token|secret|token)\s*[:=][^\S\n]*)(?:"([^"\n]+)"|'([^'\n]+)'|([^\s,;]+))/gi

const PROSE_SECRET_RE =
  /(\b(?:(?:minha|a|sua|my|the|your)\s+)?(?:senha|password|passcode)\s+(?:é|eh|is)\s+)(?:"([^"\n]+)"|'([^'\n]+)'|([^\s,;?]+))/gi

function isTrivialPlaceholder(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.length < 3) return true
  if (trimmed.startsWith('[redacted')) return true
  if (/^\*+$/.test(trimmed)) return true
  if (/^<[^>]+>$/.test(trimmed)) return true
  if (/^[?!.,:;-]+$/.test(trimmed)) return true
  return false
}

function looksLikeCredentialToken(value: string): boolean {
  if (isTrivialPlaceholder(value) || value.length < 4) return false
  const hasDigit = /\p{Nd}/u.test(value)
  const hasSymbol = /[^\p{L}\p{N}]/u.test(value)
  const hasUpper = /\p{Lu}/u.test(value)
  const hasLower = /\p{Ll}/u.test(value)
  return hasDigit || hasSymbol || (hasUpper && hasLower)
}

function replaceMatchedValue(
  prefix: string,
  doubleQuoted: string | undefined,
  singleQuoted: string | undefined,
  bare: string | undefined,
  requireCredentialShape: boolean,
): string | null {
  const value = doubleQuoted ?? singleQuoted ?? bare ?? ''
  if (isTrivialPlaceholder(value)) return null
  if (requireCredentialShape && bare !== undefined && !looksLikeCredentialToken(value)) return null
  if (doubleQuoted !== undefined) return `${prefix}"${REDACTED_SECRET}"`
  if (singleQuoted !== undefined) return `${prefix}'${REDACTED_SECRET}'`
  return `${prefix}${REDACTED_SECRET}`
}

/**
 * Redacts obvious secrets and labeled credentials from text before it is
 * persisted or sent to external model/embedding endpoints. Idempotent.
 */
export function redactSecrets(text: string): { text: string; redacted: boolean } {
  if (!text) return { text, redacted: false }
  let redacted = false
  let next = text

  next = next.replace(PRIVATE_KEY_RE, () => {
    redacted = true
    return REDACTED_PRIVATE_KEY
  })

  next = next.replace(URL_CREDENTIALS_RE, (full, prefix: string, pass: string, suffix: string) => {
    if (isTrivialPlaceholder(pass)) return full
    redacted = true
    return `${prefix}${REDACTED_SECRET}${suffix}`
  })

  next = next.replace(AUTH_HEADER_RE, (full, prefix: string, token: string) => {
    if (isTrivialPlaceholder(token)) return full
    redacted = true
    return `${prefix}${REDACTED_SECRET}`
  })

  next = next.replace(BEARER_RE, (full, prefix: string, token: string) => {
    if (isTrivialPlaceholder(token)) return full
    redacted = true
    return `${prefix}${REDACTED_SECRET}`
  })

  next = next.replace(
    ENV_ASSIGNMENT_RE,
    (full, prefix: string, dq?: string, sq?: string, bare?: string) => {
      const replacement = replaceMatchedValue(prefix, dq, sq, bare, false)
      if (!replacement) return full
      redacted = true
      return replacement
    },
  )

  next = next.replace(
    LABELED_SECRET_RE,
    (full, prefix: string, dq?: string, sq?: string, bare?: string) => {
      const replacement = replaceMatchedValue(prefix, dq, sq, bare, false)
      if (!replacement) return full
      redacted = true
      return replacement
    },
  )

  next = next.replace(
    PROSE_SECRET_RE,
    (full, prefix: string, dq?: string, sq?: string, bare?: string) => {
      const replacement = replaceMatchedValue(prefix, dq, sq, bare, true)
      if (!replacement) return full
      redacted = true
      return replacement
    },
  )

  next = next.replace(TOKEN_RE, () => {
    redacted = true
    return REDACTED_SECRET
  })

  return { text: next, redacted }
}

/** Recursively redacts secrets inside JSON-like values without mutating inputs. */
export function redactSecretsInValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') {
    const out = redactSecrets(value)
    return out.redacted ? out.text : value
  }
  if (!value || typeof value !== 'object') return value
  if (value instanceof Uint8Array || value instanceof Date || value instanceof RegExp) return value
  if (seen.has(value)) return value
  seen.add(value)

  if (Array.isArray(value)) {
    let changed = false
    const out = value.map((item) => {
      const next = redactSecretsInValue(item, seen)
      if (next !== item) changed = true
      return next
    })
    return changed ? out : value
  }

  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return value

  let changed = false
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    const next = redactSecretsInValue(entry, seen)
    if (next !== entry) changed = true
    out[key] = next
  }
  return changed ? out : value
}
