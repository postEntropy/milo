import { describe, expect, it } from 'vitest'
import { effectiveSegment, parseShell } from '../src/core/tools/shell-parse.js'

function segments(command: string) {
  const parsed = parseShell(command)
  if (!parsed.ok) throw new Error(`expected a parse, got: ${parsed.reason}`)
  return parsed.segments
}

describe('parseShell', () => {
  it('reads one command as its program and arguments', () => {
    expect(segments('npm test')).toEqual([{ program: 'npm', args: ['test'], text: 'npm test' }])
  })

  it('splits on the operators a shell uses', () => {
    expect(segments('cd /tmp && rm -rf build').map((segment) => segment.program)).toEqual(['cd', 'rm'])
    expect(segments('a; b || c | d\ne').map((segment) => segment.program)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('keeps a separator inside quotes, and resolves the quotes', () => {
    expect(segments('echo "a; b"')).toEqual([{ program: 'echo', args: ['a; b'], text: 'echo a; b' }])
    expect(segments("printf 'one && two'").at(0)?.args).toEqual(['one && two'])
  })

  it('joins adjacent quoted and unquoted parts of one word', () => {
    expect(segments("echo 'it'\"s\"here").at(0)?.args).toEqual(['itshere'])
  })

  it('reads escapes outside quotes, and inside double quotes', () => {
    expect(segments('echo a\\ b').at(0)?.args).toEqual(['a b'])
    expect(segments('echo "a\\"b"').at(0)?.args).toEqual(['a"b'])
  })

  it('leaves a file-descriptor redirection as one word', () => {
    expect(segments('make 2>&1').at(0)?.args).toEqual(['2>&1'])
  })

  it('answers no segments for an empty line', () => {
    expect(segments('   ')).toEqual([])
  })

  it('refuses what it cannot read, rather than guessing', () => {
    for (const command of [
      'echo $(date)',
      'echo "`date`"',
      'cat <<EOF',
      'diff <(a) <(b)',
      "sh -c 'rm -rf /'",
      "bash -lc 'x'",
      'sudo -s',
      'sudo -is',
      'eval "rm -rf /"',
      'xargs rm',
      'find . -exec rm {} \\;',
      "env -S 'rm -rf /'",
    ]) {
      expect(parseShell(command), command).toMatchObject({ ok: false })
    }
  })

  it('refuses an unclosed quote or a trailing escape', () => {
    expect(parseShell(`echo "x`)).toMatchObject({ ok: false })
    expect(parseShell('echo x\\')).toMatchObject({ ok: false })
  })
})

describe('effectiveSegment', () => {
  it('peels sudo and its own flags', () => {
    expect(effectiveSegment({ program: 'sudo', args: ['-u', 'root', 'rm', '-rf', '/'], text: '' })).toMatchObject({
      program: 'rm',
      args: ['-rf', '/'],
    })
  })

  it('peels env assignments and flags', () => {
    expect(effectiveSegment({ program: 'env', args: ['FOO=1', '-u', 'BAR', 'npm', 'test'], text: '' })).toMatchObject({
      program: 'npm',
      args: ['test'],
    })
  })

  it('peels command, nice, nohup and time', () => {
    expect(effectiveSegment({ program: 'command', args: ['-v', 'git'], text: '' }).program).toBe('git')
    expect(effectiveSegment({ program: 'nice', args: ['-n', '5', 'make'], text: '' }).program).toBe('make')
    expect(effectiveSegment({ program: 'nohup', args: ['python', 'job.py'], text: '' }).program).toBe('python')
    expect(effectiveSegment({ program: 'time', args: ['--', 'make', 'test'], text: '' }).program).toBe('make')
  })

  it('leaves a command with no prefix alone', () => {
    expect(effectiveSegment({ program: 'git', args: ['status'], text: '' }).program).toBe('git')
  })
})
