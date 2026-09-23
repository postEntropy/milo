import { describe, expect, it } from 'vitest'
import { parseArgs } from '../src/bin/args.js'
import { resolveCommand, resolveInitialMode, validateArgs } from '../src/bin/dispatch.js'

describe('validateArgs', () => {
  it('accepts the usual command line', () => {
    expect(validateArgs(parseArgs(['chat', '--mode', 'auto']))).toBeNull()
  })

  it('refuses a mode that is not one of the three', () => {
    expect(validateArgs(parseArgs(['--mode', 'fast']))).toBe(
      'Invalid --mode "fast". Use ask, auto or yolo.',
    )
  })

  it('refuses a session id that is not a nickname', () => {
    expect(validateArgs(parseArgs(['--resume', '../../etc/passwd']))).toContain(
      'Invalid session id',
    )
  })

  it('accepts a nickname session id', () => {
    expect(validateArgs(parseArgs(['--resume', 'calm-otter-7']))).toBeNull()
  })
})

describe('resolveInitialMode', () => {
  it('makes --yolo shorthand for --mode yolo', () => {
    expect(resolveInitialMode(parseArgs(['--yolo']))).toBe('yolo')
  })

  it('passes an explicit mode through', () => {
    expect(resolveInitialMode(parseArgs(['--mode', 'auto']))).toBe('auto')
  })

  it('leaves the mode unset otherwise', () => {
    expect(resolveInitialMode(parseArgs([]))).toBeUndefined()
  })
})

describe('resolveCommand', () => {
  it('routes the known commands', () => {
    expect(resolveCommand('serve')).toBe('serve')
    expect(resolveCommand('model')).toBe('model')
    expect(resolveCommand('setup')).toBe('setup')
    expect(resolveCommand('chat')).toBe('chat')
  })

  it('rejects anything else', () => {
    expect(resolveCommand('frobnicate')).toBeNull()
  })
})
