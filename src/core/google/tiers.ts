/**
 * How much a Google grant is allowed to do, said once.
 *
 * There is no default: the level is a decision made when connecting, and every
 * surface that offers it — `milo google connect`, the setup screen, the web panel
 * — draws the same four options from here, so they cannot drift apart. The list
 * is ordered: `tierAtLeast` reads it as one grant covering the ones below it.
 */
import { z } from 'zod'

export const GoogleAccessSchema = z.enum(['none', 'modify', 'compose', 'send'])
export type GoogleAccess = z.infer<typeof GoogleAccessSchema>

export interface GoogleTier {
  id: GoogleAccess
  /** A short name for the row or button the person picks. */
  label: string
  /** What the grant can do, in the words the person reads. */
  description: string
}

export const GOOGLE_TIERS: GoogleTier[] = [
  {
    id: 'none',
    label: 'Read only',
    description: 'Search and read mail and files. Nothing in the account is changed.',
  },
  {
    id: 'modify',
    label: 'Tidy up',
    description: 'Also archive mail and mark it read — inside the account, and nothing leaves it.',
  },
  {
    id: 'compose',
    label: 'Write drafts',
    description: 'Also write drafts. Nothing is sent.',
  },
  {
    id: 'send',
    label: 'Send mail',
    description: 'Everything above, including sending mail as you.',
  },
]

const ORDER: GoogleAccess[] = ['none', 'modify', 'compose', 'send']

/** Whether a grant of `granted` covers everything `required` needs. */
export function tierAtLeast(granted: GoogleAccess, required: GoogleAccess): boolean {
  return ORDER.indexOf(granted) >= ORDER.indexOf(required)
}

/** The tier a stored account resolves to: its own, or read-only when it predates the choice. */
export function accessOf(account: { access?: GoogleAccess } | null | undefined): GoogleAccess {
  return account?.access ?? 'none'
}

/** What a grant permits, as the sentence a surface shows beside it. */
export function describeAccess(access: GoogleAccess): string {
  return GOOGLE_TIERS.find((tier) => tier.id === access)?.description ?? access
}

/** The short name of a level, for a line that names it rather than explains it. */
export function accessLabel(access: GoogleAccess): string {
  return GOOGLE_TIERS.find((tier) => tier.id === access)?.label ?? access
}
