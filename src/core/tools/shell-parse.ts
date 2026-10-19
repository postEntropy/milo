/**
 * A shell command read as the commands it actually runs.
 *
 * The point is not to be a shell. It is to make the second command visible: a
 * `rm` after a `;`, a `cp` after `&&`, the real program behind `sudo` or `env`.
 * The rules that decide whether something is dangerous were written against a
 * whole line, and a whole line is exactly what hides the second act.
 *
 * What this cannot read is not guessed at: command substitution, heredocs,
 * process substitution, `sh -c`, `eval`, `xargs` and `find -exec` answer
 * `ok: false`, and the permission layer treats unknown as "ask", never "allow".
 */

export interface ShellSegment {
  /** The program as it was written: `rm`, `npm`, `sudo`. */
  program: string
  args: string[]
  /** Program plus args, quotes resolved, for scanning and summaries. */
  text: string
}

export type ShellParse =
  | { ok: true; segments: ShellSegment[] }
  | { ok: false; reason: string }

/** A segment with `sudo`, `env` and friends peeled off. */
export function effectiveSegment(segment: ShellSegment): ShellSegment {
  let program = segment.program
  let args = [...segment.args]

  // A prefix chain is finite: `sudo env FOO=1 nice rm`. The loop stops at the
  // first token that is not a prefix.
  for (;;) {
    const name = basename(program)
    if (name === 'sudo') {
      const peeled = peel(args, {
        valueFlags: ['-u', '-g', '-p', '-C', '-h', '-r', '-t', '-U', '-D', '-R', '--user', '--group', '--prompt', '--chdir', '--host', '--role', '--type', '--other-user'],
        inlineValueFlags: ['--user=', '--group=', '--prompt=', '--chdir=', '--host=', '--role=', '--type=', '--other-user='],
        plainFlags: ['-E', '-H', '-n', '-S', '-k', '-A', '-b', '--preserve-env', '--set-home', '--non-interactive', '--stdin', '--askpass', '--background', '--login', '--shell'],
      })
      if (!peeled) break
      program = peeled.program
      args = peeled.args
      continue
    }
    if (name === 'env') {
      const peeled = peel(args, {
        valueFlags: ['-u', '--unset', '-C', '--chdir', '-S', '--split-string'],
        inlineValueFlags: ['--unset=', '--chdir=', '--split-string='],
        plainFlags: ['-i', '--ignore-environment', '-', '-0', '--null', '-v', '--debug'],
        assignments: true,
      })
      if (!peeled) break
      program = peeled.program
      args = peeled.args
      continue
    }
    if (name === 'command') {
      const peeled = peel(args, { plainFlags: ['-p', '-v', '-V'] })
      if (!peeled) break
      program = peeled.program
      args = peeled.args
      continue
    }
    if (name === 'nice') {
      const peeled = peel(args, {
        valueFlags: ['-n', '--adjustment'],
        inlineValueFlags: ['--adjustment='],
        plainFlags: ['--'],
        numericFlag: true,
      })
      if (!peeled) break
      program = peeled.program
      args = peeled.args
      continue
    }
    if (name === 'nohup' || name === 'time') {
      const peeled = peel(args, { plainFlags: ['--'] })
      if (!peeled) break
      program = peeled.program
      args = peeled.args
      continue
    }
    break
  }

  // A prefix with nothing after it is the command itself (`sudo` alone); the
  // caller reads the empty program as nothing to unwrap.
  return { program, args, text: [program, ...args].filter(Boolean).join(' ') }
}

interface PeelOptions {
  valueFlags?: string[]
  inlineValueFlags?: string[]
  plainFlags?: string[]
  /** `env` treats `NAME=value` as an assignment, not the program. */
  assignments?: boolean
  /** `nice -5 cmd` is a numeric adjustment. */
  numericFlag?: boolean
}

/**
 * Removes one prefix program and its own arguments. Null when there is no
 * program after the flags — `sudo -u root` with nothing to run.
 */
function peel(args: string[], options: PeelOptions): { program: string; args: string[] } | null {
  const valueFlags = new Set(options.valueFlags ?? [])
  const plainFlags = new Set(options.plainFlags ?? [])
  const inlineValueFlags = options.inlineValueFlags ?? []
  let index = 0

  while (index < args.length) {
    const arg = args[index]!
    if (options.assignments && /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) {
      index += 1
      continue
    }
    if (arg === '--') {
      index += 1
      break
    }
    if (valueFlags.has(arg)) {
      index += 2
      continue
    }
    if (plainFlags.has(arg) || (options.numericFlag && /^-\d+$/.test(arg))) {
      index += 1
      continue
    }
    if (inlineValueFlags.some((flag) => arg.startsWith(flag))) {
      index += 1
      continue
    }
    // `nice -n5` and `env -uroot`: a flag with its value glued on.
    if (/^-[A-Za-z].+/.test(arg) && !arg.startsWith('--') && valueFlags.has(arg.slice(0, 2))) {
      index += 1
      continue
    }
    if (arg.startsWith('-')) {
      // An unknown flag is left to the program itself: stopping here would make
      // `sudo --some-new-flag rm` read as `sudo`.
      return null
    }
    break
  }

  if (index >= args.length) return null
  return { program: args[index]!, args: args.slice(index + 1) }
}

function basename(program: string): string {
  const clean = program.trim()
  const slash = clean.lastIndexOf('/')
  return (slash === -1 ? clean : clean.slice(slash + 1)).toLowerCase()
}

/** The commands a line runs, or why it cannot be read. */
export function parseShell(command: string): ShellParse {
  const segments: ShellSegment[] = []
  let tokens: string[] = []
  let token: string | null = null
  let quote: "'" | '"' | null = null
  let index = 0

  const begin = (): void => {
    if (token === null) token = ''
  }
  const push = (char: string): void => {
    begin()
    token += char
  }
  const endToken = (): void => {
    if (token !== null) {
      tokens.push(token)
      token = null
    }
  }
  const endSegment = (): void => {
    endToken()
    if (tokens.length > 0) {
      const program = tokens[0]!
      segments.push({ program, args: tokens.slice(1), text: tokens.join(' ') })
      tokens = []
    }
  }

  while (index < command.length) {
    const char = command[index]!

    if (quote === "'") {
      if (char === "'") quote = null
      else push(char)
      index += 1
      continue
    }

    if (quote === '"') {
      if (char === '\\') {
        const next = command[index + 1]
        if (next === undefined) return { ok: false, reason: 'the command ends with a backslash' }
        push(next)
        index += 2
        continue
      }
      if (char === '"') {
        quote = null
        index += 1
        continue
      }
      if (char === '`') return { ok: false, reason: 'command substitution (backticks)' }
      if (char === '$' && command[index + 1] === '(') {
        return { ok: false, reason: 'command substitution ($(…))' }
      }
      push(char)
      index += 1
      continue
    }

    // Unquoted.
    if (char === '\\') {
      const next = command[index + 1]
      if (next === undefined) return { ok: false, reason: 'the command ends with a backslash' }
      push(next)
      index += 2
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      begin()
      index += 1
      continue
    }
    if (char === '`') return { ok: false, reason: 'command substitution (backticks)' }
    if (char === '$' && command[index + 1] === '(') {
      return { ok: false, reason: 'command substitution ($(…))' }
    }
    if (char === '<' && command[index + 1] === '<') {
      return { ok: false, reason: 'a heredoc (<<)' }
    }
    if (char === '<' && command[index + 1] === '(') {
      return { ok: false, reason: 'process substitution (<(…))' }
    }
    if (char === '>' && command[index + 1] === '(') {
      return { ok: false, reason: 'process substitution (>(…))' }
    }
    if (char === ';' || char === '\n') {
      endSegment()
      index += 1
      continue
    }
    if (char === '|') {
      endSegment()
      index += command[index + 1] === '|' ? 2 : 1
      continue
    }
    if (char === '&' && command[index + 1] === '&') {
      endSegment()
      index += 2
      continue
    }
    if (char === ' ' || char === '\t' || char === '\r') {
      endToken()
      index += 1
      continue
    }

    push(char)
    index += 1
  }

  if (quote !== null) return { ok: false, reason: 'an unclosed quote' }
  endSegment()

  for (const segment of segments) {
    const unsupported = unreadableSegment(segment)
    if (unsupported) return { ok: false, reason: unsupported }
  }

  return { ok: true, segments }
}

/** A command whose effect is another command this parser cannot see. */
function unreadableSegment(segment: ShellSegment): string | null {
  const raw = basename(segment.program)
  if (raw === 'sudo' && segment.args.some((arg) => /^-[A-Za-z]*[is][A-Za-z]*$/.test(arg) || arg === '--shell' || arg === '--login')) {
    return 'an interactive or login shell behind sudo'
  }
  if (
    (raw === 'env' || segment.args.includes('env')) &&
    segment.args.some((arg) => arg === '-S' || arg === '--split-string' || arg.startsWith('--split-string='))
  ) {
    return 'an env split string (env -S)'
  }

  const effective = effectiveSegment(segment)
  const program = basename(effective.program)

  // `-c`, and the bundles a shell accepts: `-lc`, `-ec`.
  const shellString = effective.args.some(
    (arg) => arg === '--command' || (/^-[A-Za-z]+$/.test(arg) && arg.includes('c')),
  )
  if (['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish'].includes(program) && shellString) {
    return 'a shell string (sh -c)'
  }
  if (program === 'eval') return 'eval'
  if (program === 'xargs') return 'xargs'
  if (program === 'find' && effective.args.some((arg) => ['-exec', '-execdir', '-ok', '-okdir'].includes(arg))) {
    return 'find -exec'
  }
  return null
}
