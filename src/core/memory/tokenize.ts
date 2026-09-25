/**
 * The one tokenizer both memory implementations and the session ranker share.
 *
 * It lives on its own because it is not private to a backend: `sessions/recall`
 * ranks past sessions with the same words, so a backend swap must not take the
 * ranker's vocabulary with it.
 */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'for', 'is', 'are', 'was',
  'were', 'be', 'been', 'it', 'this', 'that', 'with', 'as', 'at', 'by', 'from', 'i', 'you',
  'o', 'a', 'os', 'as', 'um', 'uma', 'de', 'do', 'da', 'e', 'ou', 'que', 'em', 'no', 'na',
  'para', 'por', 'com', 'se', 'meu', 'minha', 'eu', 'voce', 'você', 'é',
])

export function tokenize(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    // Two characters, not three: `rm`, `go`, `io` and `db` are exactly the kind
    // of term a question about a project turns on, and dropping them meant a
    // memory could never be recalled by the word the user actually used.
    .filter((token) => token.length > 1 && !STOPWORDS.has(token))
  return new Set(tokens)
}
