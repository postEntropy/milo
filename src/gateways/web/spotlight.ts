import { isWildcardHost } from './http.js'

/**
 * A host as a URL names it. A wildcard bind has no name of its own — `0.0.0.0` is
 * not an address anything opens — and the popup always runs on this machine, so it
 * talks to loopback. A bare IPv6 address needs its brackets.
 */
export function hostForUrl(host: string): string {
  const trimmed = host.trim()
  if (!trimmed || isWildcardHost(trimmed)) return '127.0.0.1'
  return trimmed.includes(':') && !trimmed.startsWith('[') ? `[${trimmed}]` : trimmed
}

/**
 * Where a person's browser should open Milo, token and all.
 *
 * The token rides in the query because an address in a browser is the only thing
 * that authenticates it: a link handed to `xdg-open` has no headers to carry one.
 * `open` names a session to resume — that is how the spotlight hands a
 * conversation it outgrew to the full app.
 */
export function appUrl(options: { host: string; port: number; token?: string; open?: string }): string {
  const url = new URL(`http://${hostForUrl(options.host)}:${options.port}/`)
  if (options.token) url.searchParams.set('t', options.token)
  if (options.open) url.searchParams.set('open', options.open)
  return url.href
}
