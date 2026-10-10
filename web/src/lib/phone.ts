/**
 * The width at or under which this is a phone: the layout scrolls the document
 * there — iOS Safari shows the page behind its own bar only then (see
 * `styles.css`) — while a wide screen keeps the thread in its own box.
 *
 * Whatever is a phone's own behaviour hangs off this one query rather than a copy
 * of its own: the scroll maths, the drawer's overlay lock, the colour of the
 * system bars, and dropping the on-screen keyboard when a message is sent.
 */
export const PHONE_QUERY = '(max-width: 900px)'

/** Whether what is showing is a phone, at the moment it is asked. */
export function isPhone(): boolean {
  return window.matchMedia(PHONE_QUERY).matches
}
