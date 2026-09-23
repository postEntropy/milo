import os from 'node:os'
import path from 'node:path'

export const MILO_HOME = process.env.MILO_HOME?.trim() || path.join(os.homedir(), '.milo')

export const configFile = (): string => path.join(MILO_HOME, 'config.json')
export const authFile = (): string => path.join(MILO_HOME, 'auth.json')
export const memoryDir = (): string => path.join(MILO_HOME, 'memory')
export const sessionsDir = (): string => path.join(MILO_HOME, 'sessions')
/** One JSON per session: what that conversation was about, kept out of it. */
export const recapsDir = (): string => path.join(sessionsDir(), 'recaps')
/** One append-only JSONL per day: what was asked, answered and run. */
export const historyDir = (): string => path.join(MILO_HOME, 'history')
/** What was typed at the CLI's prompt, for the arrow keys to walk back through. */
export const inputHistoryFile = (): string => path.join(MILO_HOME, 'input-history.json')
