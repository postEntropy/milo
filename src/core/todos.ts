/**
 * The plan a turn keeps: a short checklist the person watches while the work
 * runs. It is the model's own list — set with the `todo` tool — carried as one
 * piece of state so every surface draws it the same way.
 */

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export const TODO_STATUSES: readonly TodoStatus[] = ['pending', 'in_progress', 'completed']

export interface TodoItem {
  content: string
  status: TodoStatus
}

/** The one mark a status wears, wherever a checklist is drawn as text. */
export function todoMark(status: TodoStatus): string {
  if (status === 'completed') return '✔'
  if (status === 'in_progress') return '▸'
  return '☐'
}

/**
 * The checklist as plain lines, one step each. The shape the terminal and the
 * chat gateways share; the web draws its own, but from these same items.
 */
export function formatTodos(items: TodoItem[]): string {
  return items.map((item) => `${todoMark(item.status)} ${item.content}`).join('\n')
}

/**
 * The plan out of a `todo` call's arguments, checked rather than trusted: a
 * transcript is read back from disk, so a value that is no longer the shape it
 * was written as is dropped instead of drawn broken.
 */
export function todosFromArgs(args: unknown): TodoItem[] {
  if (!args || typeof args !== 'object') return []
  const list = (args as { todos?: unknown }).todos
  if (!Array.isArray(list)) return []
  const items: TodoItem[] = []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    if (typeof record.content !== 'string' || !record.content.trim()) continue
    if (!TODO_STATUSES.includes(record.status as TodoStatus)) continue
    items.push({ content: record.content, status: record.status as TodoStatus })
  }
  return items
}
