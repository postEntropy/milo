import { describe, expect, it } from 'vitest'
import { parseArgs } from '../src/bin/args.js'

describe('parseArgs', () => {
  it('defaults to the chat with nothing set', () => {
    expect(parseArgs([])).toEqual({
      command: 'chat',
      version: false,
      help: false,
      yolo: false,
      continueSession: false,
    })
  })

  it('takes the command as the first bare word', () => {
    expect(parseArgs(['setup']).command).toBe('setup')
    expect(parseArgs(['model']).command).toBe('model')
    expect(parseArgs(['serve']).command).toBe('serve')
    expect(parseArgs(['nonsense']).command).toBe('nonsense')
  })

  it('does not mistake a flag for the command', () => {
    expect(parseArgs(['--help']).command).toBe('chat')
    expect(parseArgs(['-v']).version).toBe(true)
  })

  it('reads the flags that take a value', () => {
    const args = parseArgs([
      '--provider',
      'openrouter',
      '--model',
      'anthropic/claude',
      '--mode',
      'auto',
      '--resume',
      'calm-otter-7',
    ])

    expect(args.provider).toBe('openrouter')
    expect(args.model).toBe('anthropic/claude')
    expect(args.mode).toBe('auto')
    expect(args.resume).toBe('calm-otter-7')
  })

  it('takes -m as the model and -c as continue', () => {
    const args = parseArgs(['-m', 'gpt-4o-mini', '-c'])
    expect(args.model).toBe('gpt-4o-mini')
    expect(args.continueSession).toBe(true)
  })

  it('treats --yolo as the mode shortcut', () => {
    expect(parseArgs(['--yolo']).yolo).toBe(true)
  })

  it('leaves a flag with a missing value undefined instead of throwing', () => {
    expect(parseArgs(['--model']).model).toBeUndefined()
    expect(parseArgs(['--mode']).mode).toBeUndefined()
  })
})
