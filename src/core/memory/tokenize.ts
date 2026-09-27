/**
 * The one tokenizer both memory implementations and the session ranker share.
 *
 * It lives on its own because it is not private to a backend: `sessions/recall`
 * ranks past sessions with the same words, so a backend swap must not take the
 * ranker's vocabulary with it.
 */
const STOPWORDS = new Set([
  // The filler of a sentence, in English and in Portuguese.
  'the', 'a', 'an', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'for', 'is', 'are', 'was',
  'were', 'be', 'been', 'it', 'this', 'that', 'with', 'as', 'at', 'by', 'from', 'i', 'you',
  'o', 'a', 'os', 'as', 'um', 'uma', 'de', 'do', 'da', 'e', 'ou', 'que', 'em', 'no', 'na',
  'para', 'por', 'com', 'se', 'meu', 'minha', 'eu', 'voce', 'você', 'é',
  // What makes a question a question. They are in every question and in almost
  // no note, so a match on one of them says nothing — and it was saying plenty:
  // measured on the eval set, `qual` and `como` alone were the whole of why an
  // unrelated question came back with a note, five times out of eight. Nothing
  // is lost by dropping them, because a question still keeps every word that is
  // actually about something.
  'qual', 'quais', 'como', 'quando', 'onde', 'quem', 'quanto', 'quanta', 'quantos', 'quantas',
  'porque', 'porquê', 'pra', 'pro', 'isso', 'isto', 'aquilo', 'aqui', 'ali', 'la', 'lá',
  // The same for the verbs that are the scaffolding of a sentence rather than its
  // subject: "o que eu *faco*" is a question about what comes after it.
  'tem', 'ter', 'foi', 'vai', 'vou', 'sao', 'são', 'esta', 'está', 'estao', 'estão', 'pode',
  'faz', 'fazer', 'faco', 'faço', 'ja', 'já', 'so', 'só', 'mais', 'menos', 'muito', 'nada',
  'tudo', 'bem', 'tambem', 'também', 'ainda', 'agora',
])

/**
 * The words of a text, in the order they were written.
 *
 * Ordered, because adjacency is a signal: a note that contains "tag de release"
 * back to back is more likely to be the note a question about the release tag is
 * after than one that happens to contain both words far apart.
 */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    // Two characters, not three: `rm`, `go`, `io` and `db` are exactly the kind
    // of term a question about a project turns on, and dropping them meant a
    // memory could never be recalled by the word the user actually used.
    .filter((token) => token.length > 1 && !STOPWORDS.has(token))
}

export function tokenize(text: string): Set<string> {
  return new Set(words(text))
}

/**
 * The words a note is *about*, for deciding whether two notes are the same one.
 *
 * The same list as recall, minus the length filter: recall drops single
 * characters because `1` or `a` in a query is noise, but identity must keep
 * them, or "nota 0" and "nota 1" would be one note and a correction would be
 * silently swallowed.
 */
export function contentWords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0 && !STOPWORDS.has(token))
  return new Set(words)
}
