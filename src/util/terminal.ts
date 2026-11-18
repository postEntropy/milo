import { spawn } from 'node:child_process'
import process from 'node:process'
import { createInterface } from 'node:readline/promises'

/**
 * A URL an emulator can click. Wrapping the visible text in an OSC 8 hyperlink
 * makes it a real link in terminals that support it (Kitty, Ghostty, WezTerm,
 * foot, iTerm2, Windows Terminal), whatever their own URL detector decides — and
 * prints it bare when the stream is not a terminal, so a redirected log stays
 * text. The text is left unchanged on screen: only the escape is added.
 */
export function hyperlink(url: string, text = url): string {
  if (!process.stderr.isTTY) return text
  return `\u001b]8;;${url}\u001b\\${text}\u001b]8;;\u001b\\`
}

/** Prompts for a single line when attached to an interactive TTY; returns '' otherwise. */
export async function askOnTty(question: string): Promise<string> {
  if (!process.stdin.isTTY) return ''
  const readline = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await readline.question(question)
  } finally {
    readline.close()
  }
}

/** Asks a yes/no confirmation on an interactive TTY, defaulting to false when piped. */
export async function confirmOnTty(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false
  return /^y(es)?$/i.test((await askOnTty(question)).trim())
}

/** Opens `url` in the system browser best-effort (never fails if unavailable). */
export function openBrowser(url: string): void {
  const command =
    process.platform === 'darwin'
      ? (['open', [url]] as const)
      : process.platform === 'win32'
        ? (['cmd', ['/c', 'start', '', url]] as const)
        : (['xdg-open', [url]] as const)
  try {
    const child = spawn(command[0], [...command[1]], { stdio: 'ignore', detached: true })
    child.on('error', () => undefined)
    child.unref()
  } catch {
    // Opening a browser is a convenience; callers print the URL alongside it.
  }
}
