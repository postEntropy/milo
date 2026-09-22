import { FileMemory } from './local.js'
import type { Memory } from './types.js'
import type { MemoryConfig } from '../config/schema.js'

export * from './types.js'
export { FileMemory } from './local.js'

export function createMemory(config: MemoryConfig, dir: string): Memory {
  switch (config.backend) {
    case 'file':
    default:
      return new FileMemory({ dir })
  }
}
