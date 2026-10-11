/** The sections of Settings: the id its address carries, its icon, and its name. */
export const settingsSections = [
  ['provider', 'cpu', 'Provider & model'], ['keys', 'key', 'API keys'], ['memory', 'database', 'Memory'],
  ['gateways', 'server', 'Gateways'], ['web', 'globe', 'Web'],
  ['tools', 'settings', 'Tools'], ['permissions', 'shield', 'Permissions'], ['display', 'eye', 'Display'],
  ['skills', 'spark', 'Skills'], ['sessions', 'history', 'Sessions'],
] as const

/** The section a settings path names, e.g. `/settings/display`; null for a plain `/settings`. */
export function settingsSectionFromPath(pathname: string): string | null {
  const id = /^\/settings\/([a-z]+)\/?$/.exec(pathname)?.[1]
  return id && settingsSections.some(([section]) => section === id) ? id : null
}
