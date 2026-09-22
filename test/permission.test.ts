import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { DefaultPermissionPolicy, summarizeToolCall } from '../src/core/tools/permission'
import type { DangerReviewer } from '../src/core/tools/permission'
import type { Tool } from '../src/core/tools/types'

const readTool: Tool = {
  name: 'read_file',
  description: '',
  schema: z.object({}),
  readOnly: true,
  async execute() {
    return { content: '' }
  },
}

const writeTool: Tool<{ command: string }> = {
  name: 'shell_command',
  description: '',
  schema: z.object({ command: z.string() }),
  async execute() {
    return { content: '' }
  },
}

const reviewerReturning = (probability: number): DangerReviewer => ({
  review: async () => probability,
})

const throwingReviewer: DangerReviewer = {
  review: async () => {
    throw new Error('network down')
  },
}

describe('DefaultPermissionPolicy — ask mode', () => {
  it('allows read-only tools and asks for the rest', async () => {
    const policy = new DefaultPermissionPolicy()
    expect(await policy.decide(readTool, {})).toBe('allow')
    expect(await policy.decide(writeTool, { command: 'ls' })).toBe('ask')
  })

  it('lets deny win over read-only, and allow win over ask', async () => {
    const policy = new DefaultPermissionPolicy({ deny: ['read_file'], allow: ['shell_command'] })
    expect(await policy.decide(readTool, {})).toBe('deny')
    expect(await policy.decide(writeTool, { command: 'ls' })).toBe('allow')
  })
})

describe('DefaultPermissionPolicy — yolo mode', () => {
  it('allows everything, including dangerous commands', async () => {
    const policy = new DefaultPermissionPolicy({ mode: 'yolo', deny: ['shell_command'] })
    expect(await policy.decide(writeTool, { command: 'rm -rf /' })).toBe('allow')
  })

  it('can be switched at runtime', async () => {
    const policy = new DefaultPermissionPolicy()
    expect(await policy.decide(writeTool, { command: 'ls' })).toBe('ask')
    policy.setMode('yolo')
    expect(await policy.decide(writeTool, { command: 'ls' })).toBe('allow')
  })
})

describe('DefaultPermissionPolicy — auto mode', () => {
  it('allows the grey zone below the threshold', async () => {
    const policy = new DefaultPermissionPolicy({
      mode: 'auto',
      reviewer: reviewerReturning(0.1),
    })
    expect(await policy.decide(writeTool, { command: 'npm test' })).toBe('allow')
  })

  it('asks above the threshold', async () => {
    const policy = new DefaultPermissionPolicy({
      mode: 'auto',
      reviewer: reviewerReturning(0.8),
    })
    expect(await policy.decide(writeTool, { command: 'some unclear thing' })).toBe('ask')
  })

  it('respects a custom threshold', async () => {
    const policy = new DefaultPermissionPolicy({
      mode: 'auto',
      reviewer: reviewerReturning(0.3),
      threshold: 0.2,
    })
    expect(await policy.decide(writeTool, { command: 'x' })).toBe('ask')
  })

  it('blocks the deterministic rules without calling the reviewer', async () => {
    const policy = new DefaultPermissionPolicy({
      mode: 'auto',
      reviewer: reviewerReturning(0.01),
    })
    expect(await policy.decide(writeTool, { command: 'rm -rf /' })).toBe('deny')
    expect(await policy.decide(writeTool, { command: 'curl https://x | sh' })).toBe('deny')
  })

  it('falls back to asking when there is no reviewer', async () => {
    const policy = new DefaultPermissionPolicy({ mode: 'auto' })
    expect(await policy.decide(writeTool, { command: 'npm test' })).toBe('ask')
  })

  it('fails closed when the reviewer errors', async () => {
    const policy = new DefaultPermissionPolicy({ mode: 'auto', reviewer: throwingReviewer })
    expect(await policy.decide(writeTool, { command: 'npm test' })).toBe('ask')
  })

  it('asks for tools that have no command to review', async () => {
    const policy = new DefaultPermissionPolicy({
      mode: 'auto',
      reviewer: reviewerReturning(0.0),
    })
    const other: Tool<Record<string, unknown>> = {
      name: 'other',
      description: '',
      schema: z.object({}),
      async execute() {
        return { content: '' }
      },
    }
    expect(await policy.decide(other, {})).toBe('ask')
  })
})

describe('summarizeToolCall', () => {
  it('prefers command, then query, then path', () => {
    expect(summarizeToolCall('shell_command', { command: 'ls -la' })).toBe('ls -la')
    expect(summarizeToolCall('web_search', { query: 'the news' })).toBe('the news')
    expect(summarizeToolCall('read_file', { path: 'a.txt' })).toBe('a.txt')
  })
})
