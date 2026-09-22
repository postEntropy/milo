import os from 'node:os'
import path from 'node:path'

export const MILO_HOME = process.env.MILO_HOME?.trim() || path.join(os.homedir(), '.milo')

export const configFile = (): string => path.join(MILO_HOME, 'config.json')
export const authFile = (): string => path.join(MILO_HOME, 'auth.json')
export const memoryDir = (): string => path.join(MILO_HOME, 'memory')
export const sessionsDir = (): string => path.join(MILO_HOME, 'sessions')
