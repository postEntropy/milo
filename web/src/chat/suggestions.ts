/** The marks a card may wear; kept a plain union so this file stays pure. */
export type SuggestionIcon = 'history' | 'spark' | 'file' | 'terminal' | 'settings'

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
  { icon: 'file', title: 'Summarize a file', detail: 'Read and explain a document', prompt: 'Help me summarize a file in this project.' },
  { icon: 'terminal', title: 'Investigate an error', detail: 'Step-by-step diagnosis', prompt: 'Help me investigate this build error.' },
  { icon: 'settings', title: 'Tune Milo', detail: 'Set up the model and tools', prompt: 'I want to adjust Milo’s settings.' },
  { icon: 'spark', title: 'Plan a change', detail: 'Break it into safe steps', prompt: 'Help me plan a change in the project.' },
]

export interface SuggestInput {
  /** Saved sessions, newest first, as the sidebar lists them. */
  sessions: { id: string; title?: string; preview: string; messageCount: number; recap?: string }[]
  /** What Milo keeps about the person, or null while it is still being read. */
  notes: { text: string }[] | null
  /** Ideas the model drew from what Milo knows; null until they arrive. */
  ideas?: { title: string; prompt: string }[] | null
  /** The session on screen, which is never offered back to itself. */
  currentId?: string
}

/**
 * The cards on the welcome screen, drawn from what is actually here: the last
 * few conversations, opened again with one press; a way into what Milo
 * remembers; and the ideas the model drew from both. Ideas take the slots the
 * standing four would hold, and the standing four pad a shorter list, so the
 * screen is never bare and never two cards of the same thing.
 */
export function buildSuggestions({ sessions, notes, ideas, currentId }: SuggestInput): Suggestion[] {
  const cards: Suggestion[] = []

  for (const session of sessions) {
    if (cards.length >= 3) break
    if (session.id === currentId || session.messageCount === 0) continue
    const label = session.title || session.preview || session.recap
    if (!label) continue
    cards.push({ icon: 'history', title: label, detail: 'Pick up where you left off', action: `resume:${session.id}` })
  }

  if (notes && notes.length > 0) {
    cards.push({
      icon: 'spark',
      title: 'What Milo remembers',
      detail: `${notes.length} ${notes.length === 1 ? 'note' : 'notes'} about you and this project`,
      prompt: 'What do you remember about me and this project?',
    })
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
