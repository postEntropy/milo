/** The marks a card may wear; kept a plain union so this file stays pure. */
export type SuggestionIcon = 'history' | 'spark' | 'file' | 'terminal' | 'settings' | 'mail' | 'list-check' | 'repeat'

export interface Suggestion {
  icon: SuggestionIcon
  title: string
  detail: string
  /** Sent as a message when the card is pressed; absent when it acts instead. */
  prompt?: string
  /** An action id to run, e.g. `resume:<session id>`. */
  action?: string
}

/** What stands on the welcome screen when nothing better is known. */
export const defaultSuggestions: Suggestion[] = [
  { icon: 'mail', title: 'Triage my inbox', detail: 'Say what actually needs an answer', prompt: 'Go through my inbox and tell me what actually needs me.' },
  { icon: 'list-check', title: 'Plan today', detail: 'Shape what is open into a short list', prompt: 'Look at my task lists and help me plan today.' },
  { icon: 'repeat', title: 'Set up a routine', detail: 'Put a job on a schedule', prompt: 'Help me set up a routine that runs on a schedule.' },
  { icon: 'file', title: 'Summarize a file', detail: 'Read a document back in plain words', prompt: 'Help me summarize a file in this project.' },
]

export interface SuggestInput {
  /** Saved sessions, newest first, as the sidebar lists them. */
  sessions: { id: string; title?: string; preview: string; messageCount: number; recap?: string }[]
  /** Ideas the model drew from what Milo knows; null until they arrive. */
  ideas?: { title: string; prompt: string }[] | null
  /** The session on screen, which is never offered back to itself. */
  currentId?: string
}

/**
 * The cards on the welcome screen, drawn from what is actually here: the last
 * conversation, opened again with one press, and the ideas the model drew from
 * what Milo knows. One recent session, not several: the rest of the sidebar is a
 * press away, so the screen spends its slots on what is new — the ideas — instead
 * of listing what is already in front of the person. Ideas take the slots the
 * standing four would hold, and the standing four pad a shorter list, so the
 * screen is never bare and never two cards of the same thing.
 */
export function buildSuggestions({ sessions, ideas, currentId }: SuggestInput): Suggestion[] {
  const cards: Suggestion[] = []

  for (const session of sessions) {
    if (cards.length >= 1) break
    if (session.id === currentId || session.messageCount === 0) continue
    const label = session.title || session.preview || session.recap
    if (!label) continue
    cards.push({ icon: 'history', title: label, detail: 'Pick up where you left off', action: `resume:${session.id}` })
  }

  const generated: Suggestion[] = (ideas ?? []).map((idea) => ({
    icon: 'spark',
    title: idea.title,
    detail: idea.prompt,
    prompt: idea.prompt,
  }))

  for (const fallback of [...generated, ...defaultSuggestions]) {
    if (cards.length >= 4) break
    if (cards.some((card) => card.title === fallback.title)) continue
    cards.push(fallback)
  }

  return cards.slice(0, 4)
}
