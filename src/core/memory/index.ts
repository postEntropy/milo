import type { MemoryConfig } from '../config/schema.js'
import { FileMemory, fileMemoryStatus } from './local.js'
import { SqliteMemory, sqliteMemoryFile, sqliteMemoryStatus } from './sqlite.js'
import type { Memory, MemoryStatus } from './types.js'

export * from './types.js'
export { FileMemory } from './local.js'
export { DEFAULT_KEEP_SAID, SqliteMemory } from './sqlite.js'

export function createMemory(config: MemoryConfig, dir: string): Memory {
  switch (config.backend) {
    case 'sqlite':
      return new SqliteMemory({ dir, keepSaid: config.keepSaid })
    case 'file':
      return new FileMemory({ dir })
    default: {
      // Unreachable while this switch and the schema agree — which is the point:
      // a backend added to `MemorySchema` and forgotten here is a type error on
      // this assignment, not a turn that fails at runtime.
      const unhandled: never = config.backend
      throw new Error(`Unknown memory backend: ${String(unhandled)}`)
    }
  }
}

/**
 * What is actually in the store, for the setup screen. Reads it off disk so the
 * screen needs no runtime — the same way it re-reads `auth.json` on navigation —
 * and creates nothing.
 */
export function memoryStatus(config: MemoryConfig, dir: string): MemoryStatus {
  switch (config.backend) {
    case 'sqlite':
      return sqliteMemoryStatus(sqliteMemoryFile(dir))
    case 'file':
      return fileMemoryStatus(dir)
    default: {
      const unhandled: never = config.backend
      throw new Error(`Unknown memory backend: ${String(unhandled)}`)
    }
  }
}
