import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/** A process start identity, stable for its lifetime and distinct after PID reuse. */
export function processIdentity(pid: number): string | undefined {
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
      return fields[19] && boot ? `${boot}:${fields[19]}` : undefined
    }
    if (process.platform === 'darwin') {
      return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim() || undefined
    }
  } catch {
    // The process may have exited, or this platform may not expose its start time.
  }
  return undefined
}

export function processIsGone(pid: number, identity?: string): boolean {
  try {
    process.kill(pid, 0)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return false
    throw error
  }
  const current = identity ? processIdentity(pid) : undefined
  return Boolean(current && identity && current !== identity)
}
