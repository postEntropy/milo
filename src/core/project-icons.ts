/**
 * The marks a project can wear. An id rather than a drawing: the phone draws each one as
 * an SF Symbol and the browser as one of its own, so the two surfaces name the same thing
 * without either borrowing the other's vocabulary. The set is small on purpose — a mark
 * is a glance, not a second name — and it leans on the kinds of work a folder can hold,
 * not only on code.
 */
export const PROJECT_ICONS = [
  { id: 'folder', label: 'Folder' },
  { id: 'code', label: 'Code' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'branch', label: 'Branch' },
  { id: 'notes', label: 'Notes' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'design', label: 'Design' },
  { id: 'camera', label: 'Camera' },
  { id: 'music', label: 'Music' },
  { id: 'video', label: 'Video' },
  { id: 'book', label: 'Book' },
  { id: 'game', label: 'Games' },
  { id: 'ideas', label: 'Ideas' },
  { id: 'science', label: 'Science' },
  { id: 'tools', label: 'Tools' },
  { id: 'rocket', label: 'Launch' },
  { id: 'chart', label: 'Analytics' },
  { id: 'map', label: 'Map' },
  { id: 'home', label: 'Home' },
  { id: 'garden', label: 'Garden' },
  { id: 'food', label: 'Food' },
  { id: 'coffee', label: 'Coffee' },
  { id: 'health', label: 'Health' },
  { id: 'fitness', label: 'Fitness' },
  { id: 'pets', label: 'Pets' },
  { id: 'travel', label: 'Travel' },
  { id: 'explore', label: 'Explore' },
  { id: 'web', label: 'Web' },
  { id: 'mail', label: 'Mail' },
  { id: 'security', label: 'Security' },
  { id: 'link', label: 'Links' },
  { id: 'archive', label: 'Archive' },
  { id: 'shop', label: 'Shop' },
  { id: 'money', label: 'Money' },
  { id: 'business', label: 'Business' },
  { id: 'server', label: 'Server' },
  { id: 'data', label: 'Data' },
  { id: 'cpu', label: 'Hardware' },
  { id: 'cloud', label: 'Cloud' },
  { id: 'run', label: 'Run' },
] as const

export type ProjectIcon = (typeof PROJECT_ICONS)[number]['id']

/** What a project wears when nothing was chosen: the neutral mark, not a missing one. */
export const DEFAULT_PROJECT_ICON: ProjectIcon = 'folder'

export function isProjectIcon(value: unknown): value is ProjectIcon {
  return typeof value === 'string' && PROJECT_ICONS.some((icon) => icon.id === value)
}

/** The valid ids as one line, for a refusal that names them. */
export function projectIconNames(): string {
  return PROJECT_ICONS.map((icon) => icon.id).join(', ')
}
