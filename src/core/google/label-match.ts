/**
 * Which of a page's messages carry a label — the predicate alone, with no store behind it.
 *
 * It lives apart from the label store so a surface that already holds the page can
 * apply the same reading itself: the web screen filters the mail it has drawn, rather
 * than asking again for a page that does not change with the label. Shared, so the
 * screen and the agent's tool cannot come to disagree about what "has this label" means.
 */
export function carryingLabel<T extends { labels?: readonly { id: string }[] }>(messages: T[], labelId?: string): T[] {
  return labelId ? messages.filter((message) => (message.labels ?? []).some((label) => label.id === labelId)) : messages
}
