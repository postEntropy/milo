/**
 * A saved session as the wire carries it: what it is called, when it moved, and where
 * it works. Kept apart from the row that draws it, so the listing rules — which list a
 * session belongs to, how many of a project's are drawn — can be read and tested without
 * a component.
 */
export type SessionSummary = {
  id: string
  title?: string
  preview: string
  messageCount: number
  updatedAt: number
  recap?: string
  running?: boolean
  /** The session moved after it was last looked at; absent when it did not. */
  unread?: boolean
  project?: string
}
