export interface MemoryScope {
  gateway: string
  conversationId: string
  userId?: string
}

export interface MemoryInput {
  text: string
  tags?: string[]
}

export interface MemoryItem {
  id: string
  text: string
  createdAt: number
  tags?: string[]
  score?: number
}

export interface Memory {
  remember(scope: MemoryScope, items: MemoryInput[]): Promise<void>
  recall(scope: MemoryScope, query: string, opts?: { limit?: number }): Promise<MemoryItem[]>
}

export function scopeKey(scope: MemoryScope): string {
  return [scope.gateway, scope.conversationId, scope.userId].filter(Boolean).join(':')
}
