import {
  DEFAULT_PROJECT_ICON,
  isProjectIcon,
  type ProjectIcon,
} from '../../../src/core/project-icons.ts'
import type { IconName } from '../ui/Icons.js'

/**
 * The drawing each project mark wears here. The catalog is the core's — the ids and the
 * words are shared with the phone — and only the drawings differ: an SF Symbol there,
 * one of this set here. `Record<ProjectIcon, …>` makes the compiler refuse a catalog
 * entry this screen forgot.
 */
const marks: Record<ProjectIcon, IconName> = {
  folder: 'folder',
  code: 'code',
  terminal: 'terminal',
  branch: 'branch',
  notes: 'note',
  tasks: 'list-check',
  design: 'palette',
  camera: 'camera',
  music: 'music',
  video: 'video',
  book: 'book',
  game: 'gamepad',
  ideas: 'spark',
  science: 'flask',
  tools: 'wrench',
  rocket: 'rocket',
  chart: 'chart',
  map: 'map',
  home: 'home',
  garden: 'leaf',
  food: 'utensils',
  coffee: 'coffee',
  health: 'heart',
  fitness: 'dumbbell',
  pets: 'paw',
  travel: 'plane',
  explore: 'compass',
  web: 'globe',
  mail: 'mail',
  security: 'shield',
  link: 'link',
  archive: 'archive',
  shop: 'cart',
  money: 'coins',
  business: 'building',
  server: 'server',
  data: 'database',
  cpu: 'cpu',
  cloud: 'cloud',
  run: 'play',
}

/** What a project wears: its own mark, or the neutral one when it has none or one this build does not know. */
export function projectMark(icon: string | undefined): IconName {
  if (isProjectIcon(icon)) return marks[icon]
  return marks[DEFAULT_PROJECT_ICON]
}
