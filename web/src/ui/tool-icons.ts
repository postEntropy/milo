import type { IconName } from './Icons.js'

/**
 * The line icon a tool wears in the browser. The text surfaces — Telegram,
 * Discord, the terminal — draw the emoji from `tool-line.ts`, because a chat
 * client only has characters; a browser has a pen, and an emoji beside a drawn
 * interface reads as a different hand. This is the browser's own answer to the
 * same question, and it is deliberately a table of its own rather than a field in
 * the shared one: the shared table must keep the emoji for the surfaces that
 * cannot draw.
 */
const TOOL_ICONS: Record<string, IconName> = {
  read_file: 'file',
  list_dir: 'folder',
  // Which files match a pattern, against which lines inside them carry a term:
  // different questions, so different marks.
  glob: 'files',
  grep: 'search',
  fetch_url: 'link',
  write_file: 'file-plus',
  edit_file: 'edit',
  remember: 'database',
  recall: 'history',
  search_history: 'history',
  web_search: 'globe',
  read_skill: 'note',
  task: 'spark',
  shell_command: 'terminal',
  browser_open: 'compass',
  browser_snapshot: 'eye',
  browser_screenshot: 'camera',
  browser_act: 'cursor',
}

/** A tool's mark, and a plain one for a tool this table has never heard of. */
export function toolIconName(name: string): IconName {
  return TOOL_ICONS[name] ?? 'settings'
}
