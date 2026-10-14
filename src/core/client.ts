/**
 * The client apps that name themselves in the handshake, beside the gateway they
 * reach. The browser sends nothing — it is the default — and the phone says it is
 * the phone. Both reach the web gateway, so this is what tells the two apart, and
 * what lets the prompt speak to a small screen instead of to a browser.
 *
 * Apart from the prompt it shapes on purpose: the web client reads this list to check
 * the hello frame it just sent, and `agent/system.ts` reaches the filesystem — a
 * browser asking about two strings must not take a home-directory lookup with it.
 */
export const CLIENT_KINDS = ['ios'] as const
export type ClientKind = (typeof CLIENT_KINDS)[number]
