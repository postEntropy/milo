import os from 'node:os'
import path from 'node:path'

export const MILO_HOME = process.env.MILO_HOME?.trim() || path.join(os.homedir(), '.milo')

export const configFile = (): string => path.join(MILO_HOME, 'config.yml')
export const authFile = (): string => path.join(MILO_HOME, 'auth.json')
export const memoryDir = (): string => path.join(MILO_HOME, 'memory')
export const sessionsDir = (): string => path.join(MILO_HOME, 'sessions')
/** One JSON per session: what that conversation was about, kept out of it. */
export const recapsDir = (): string => path.join(sessionsDir(), 'recaps')
/** Procedures the model loads on demand, one `<name>/SKILL.md` per skill. */
export const skillsDir = (): string => path.join(MILO_HOME, 'skills')
/** Pictures Milo's tools produced. The transcript points here instead of holding them. */
export const imagesDir = (): string => path.join(MILO_HOME, 'images')
/**
 * Everything the browser owns: the profile its cookies and sign-ins live in,
 * and a Chrome Milo downloaded for itself when the machine had none. It belongs
 * to the browser Milo starts, never to the one the person is using.
 */
export const browserDir = (): string => path.join(MILO_HOME, 'browser')
export const browserProfileDir = (): string => path.join(browserDir(), 'profile')
export const browserChromeDir = (): string => path.join(browserDir(), 'chrome')
/** Profiles copied out of a browser the person already uses, one directory each. */
export const browserProfilesDir = (): string => path.join(browserDir(), 'profiles')
/** One append-only JSONL per day: what was asked, answered and run. */
export const historyDir = (): string => path.join(MILO_HOME, 'history')
/**
 * The embedding engine Milo downloaded for itself, and the models it pulls.
 * Its own copy and its own port, so an Ollama someone already runs is neither
 * disturbed nor depended on.
 */
export const embedEngineDir = (): string => path.join(MILO_HOME, 'embed')
/** Sessions written out to be read or handed on, one file per export. */
export const exportsDir = (): string => path.join(MILO_HOME, 'exports')
/** The prompts Milo runs on a timer, one list for the whole install. */
export const routinesFile = (): string => path.join(MILO_HOME, 'routines.json')
/** What was typed at the CLI's prompt, for the arrow keys to walk back through. */
export const inputHistoryFile = (): string => path.join(MILO_HOME, 'input-history.json')
