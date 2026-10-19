import { describe, expect, it } from 'vitest'
import { modelFamily } from '../src/core/agent/model-family.js'

describe('modelFamily', () => {
  it('reads Claude off the model id behind a gateway', () => {
    expect(modelFamily('commandcode', 'claude-sonnet-5')).toBe('anthropic')
  })

  it('reads a family the id carries an author for', () => {
    expect(modelFamily('openrouter', 'anthropic/claude-sonnet-5')).toBe('anthropic')
  })

  it('reads GPT off the model id, in the o-series shape too', () => {
    expect(modelFamily('commandcode', 'gpt-5.6-luna')).toBe('openai')
    expect(modelFamily('openai', 'o3')).toBe('openai')
  })

  it('reads a Codex id as OpenAI', () => {
    expect(modelFamily('openai', 'codex-mini-latest')).toBe('openai')
  })

  it('falls back to the provider when the id says nothing', () => {
    expect(modelFamily('openai', 'm')).toBe('openai')
    expect(modelFamily('anthropic', 'm')).toBe('anthropic')
  })

  it('answers nothing for a family it has no briefing for', () => {
    expect(modelFamily('opencode', 'deepseek-v4.1-flash')).toBeUndefined()
    expect(modelFamily('ollama', 'llama3.3')).toBeUndefined()
  })
})
