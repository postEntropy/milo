import { describe, expect, it } from 'vitest'
import { DEFAULT_SYSTEM_PROMPT, buildSystemPrompt, formatToolSignature } from '../src/core/agent/system'
import type { ToolSpec } from '../src/core/providers/types'

const tool: ToolSpec = {
  name: 'read_file',
  description: 'Read a file',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' }, limit: { type: 'number' } },
    required: ['path'],
  },
}

describe('formatToolSignature', () => {
  it('marks optional parameters with a question mark', () => {
    expect(formatToolSignature(tool)).toBe('read_file(path, limit?)')
  })
})

describe('buildSystemPrompt', () => {
  it('includes environment, tools and memories', () => {
    const prompt = buildSystemPrompt({
      base: 'BASE',
      cwd: '/tmp/x',
      provider: 'commandcode',
      model: 'some-model',
      tools: [tool],
      memories: [{ id: '1', text: 'likes tmux', createdAt: 0 }],
      now: new Date(2026, 8, 22),
    })

    expect(prompt).toContain('BASE')
    expect(prompt).toContain('Working directory: /tmp/x')
    expect(prompt).toContain('Today: 2026-09-22')
    expect(prompt).toContain('Model: commandcode/some-model')
    expect(prompt).toContain('read_file(path, limit?) — Read a file')
    expect(prompt).toContain('What you remember')
    expect(prompt).toContain('- likes tmux')
  })

  it('omits empty sections', () => {
    const prompt = buildSystemPrompt({
      base: 'BASE',
      cwd: '/a',
      provider: 'p',
      model: 'm',
      tools: [],
      memories: [],
    })
    expect(prompt).not.toContain('Available tools')
    expect(prompt).not.toContain('What you remember')
    expect(prompt).toContain('## Environment')
  })

  it('does not claim a surface in the base prompt', () => {
    expect(DEFAULT_SYSTEM_PROMPT.toLowerCase()).not.toContain('terminal')
    expect(DEFAULT_SYSTEM_PROMPT.toLowerCase()).not.toContain('telegram')
  })

  it('forbids reciting its own setup and capabilities', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain('Do not introduce yourself')
    expect(DEFAULT_SYSTEM_PROMPT).toContain('not a description of your abilities')

    const prompt = buildSystemPrompt({
      base: DEFAULT_SYSTEM_PROMPT,
      surface: 'cli',
      cwd: '/a',
      provider: 'p',
      model: 'm',
      tools: [],
      memories: [],
    })
    expect(prompt).toContain('do not recite it back')
  })

  it('tells the model which surface it is on', () => {
    const telegram = buildSystemPrompt({
      base: 'BASE',
      surface: 'telegram',
      cwd: '/a',
      provider: 'p',
      model: 'm',
      tools: [],
      memories: [],
    })
    expect(telegram).toContain('You are talking through a Telegram chat')
    expect(telegram).toContain('Markdown renders as a rich message')
    expect(telegram).toContain("not on the user's device")

    const cli = buildSystemPrompt({
      base: 'BASE',
      surface: 'cli',
      cwd: '/a',
      provider: 'p',
      model: 'm',
      tools: [],
      memories: [],
    })
    expect(cli).toContain('terminal')
    expect(cli).not.toContain("not on the user's device")
  })
})
