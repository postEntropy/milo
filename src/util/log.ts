/**
 * Two channels to stderr: failures the conversation carries on from but an
 * operator should still see (`logWarn`), and what only matters while debugging
 * (`logDebug`, behind `MILO_DEBUG=1`).
 */
export function logWarn(message: string): void {
  console.error(`[milo] ${message}`)
}

export function logDebug(message: string): void {
  if (process.env.MILO_DEBUG === '1') console.error(`[milo:debug] ${message}`)
}
