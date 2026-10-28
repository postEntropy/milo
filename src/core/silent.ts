/**
 * What a turn answers with when saying anything would only add noise — the one
 * word that means "nothing to report". A finished background job and a routine's
 * run both use it, and both keep the run on record while the person's chat gets
 * nothing.
 */
export const SILENT = 'SILENT'

/** Whether a turn's words are that sentinel, or nothing at all. */
export function isSilent(answer: string): boolean {
  const trimmed = answer.trim()
  return trimmed === '' || trimmed === SILENT
}
