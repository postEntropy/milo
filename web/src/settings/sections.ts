/** The sections of Settings: the id its address carries, its icon, and its name. */
export const settingsSections = [
  ['provider', 'cpu', 'Provider & model'], ['keys', 'key', 'API keys'], ['display', 'palette', 'Appearance'],
  ['tools', 'settings', 'Tools'], ['skills', 'spark', 'Skills'], ['memory', 'database', 'Memory'], ['permissions', 'shield', 'Permissions'],
  ['sessions', 'history', 'Sessions'], ['gateways', 'server', 'Gateways'], ['web', 'globe', 'Web'],
] as const

export type SettingsSectionId = (typeof settingsSections)[number][0]

/** Visual grouping for the Settings navigation rail and mobile index. */
export const settingsSectionGroups: ReadonlyArray<{
  label: string
  ids: ReadonlyArray<SettingsSectionId>
}> = [
  { label: 'General', ids: ['provider', 'keys', 'display'] },
  { label: 'Agent', ids: ['tools', 'skills', 'memory', 'permissions'] },
  { label: 'System', ids: ['sessions', 'gateways', 'web'] },
]

/** The section a settings path names, e.g. `/settings/display`; null for a plain `/settings`. */
export function settingsSectionFromPath(pathname: string): string | null {
  const id = /^\/settings\/([a-z]+)\/?$/.exec(pathname)?.[1]
  return id && settingsSections.some(([section]) => section === id) ? id : null
}
