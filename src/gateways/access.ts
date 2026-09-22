/**
 * Who may talk to a bot gateway.
 *
 * An empty (or missing) list means anyone — the permissive default. A non-empty
 * list fails closed: only those ids get through. An id matches either the
 * sender's user id or the conversation (chat / channel / guild) id, so you can
 * allow a single person or a whole room.
 */
export function isAllowed(
  allowlist: string[] | undefined,
  ids: (string | number | undefined | null)[],
): boolean {
  const allowed = normalize(allowlist)
  if (allowed.size === 0) return true
  return ids.some((id) => id !== undefined && id !== null && allowed.has(String(id).trim()))
}

export function normalize(allowlist: string[] | undefined): Set<string> {
  return new Set(
    (allowlist ?? [])
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  )
}

/** Short state label for the setup screen. */
export function describeAccess(allowlist: string[] | undefined): string {
  const allowed = normalize(allowlist)
  return allowed.size === 0 ? 'anyone' : `${allowed.size} allowed`
}

/** Sent to someone who is not on the list, so they know the id to hand over. */
export function denialMessage(id: string | number | undefined | null): string {
  return `⛔ Not authorized. Your id is ${id ?? 'unknown'} — ask the owner to add it.`
}
