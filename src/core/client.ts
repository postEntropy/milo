/**
 * The client apps that name themselves in the handshake, beside the gateway they
 * reach. The browser sends nothing — it is the default — while the phone and
 * Spotlight name themselves. All reach the web gateway, so this tells the prompt
 * which surface is speaking now, independently of where the session began.
 *
 * Apart from the prompt it shapes on purpose: the web client reads this list to check
 * the hello frame it just sent, and `agent/system.ts` reaches the filesystem — a
 * browser asking about two strings must not take a home-directory lookup with it.
 */
export const CLIENT_KINDS = ['ios', 'spotlight'] as const
export type ClientKind = (typeof CLIENT_KINDS)[number]
