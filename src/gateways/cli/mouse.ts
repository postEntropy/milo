import { PassThrough } from 'node:stream'

/** The mouse, as the terminal reports it: presses, drags, releases and the wheel,
 * in SGR form (`CSI < button ; column ; row M|m`). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape byte is the first byte of what this matches
const MOUSE_EVENT = /\u001b\[<(\d+);(\d+);(\d+)([Mm])/g

/** The button codes a wheel tick carries, with the modifier bits masked off. */
const WHEEL_UP = 64
const WHEEL_DOWN = 65
const BUTTON_MASK = 0b11000011

/**
 * A wheel tick as the key it means: one line of the transcript.
 *
 * Alt+arrows, not the bare ones: a bare up/down walks the input history, and the
 * meta form is a key nothing else in the TUI uses. It is also a key the composer
 * ignores — measured, because a wheel event handed to a text field as it arrives
 * is *typed into it*, which is why the events are translated here instead of
 * reaching Ink untouched.
 */
const WHEEL_KEYS: Record<number, string> = {
  [WHEEL_UP]: '\u001b[1;3A',
  [WHEEL_DOWN]: '\u001b[1;3B',
}

/** A mouse event that a write boundary cut in half, waiting to be finished. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the same escape byte, held while it is incomplete
const PARTIAL = /^\u001b\[<\d*(;\d*(;\d*)?)?$/

export interface WheelTranslation {
  /** What to hand on to the app: everything that is not a mouse event. */
  text: string
  /** The cut event, to start the next chunk with. */
  carry: string
}

/**
 * Rewrites the mouse events in one chunk of terminal input: the wheel becomes the
 * key it means, and everything else — a press, a drag, a release — is dropped,
 * because there is nothing in this TUI for a click to mean and a stray one would
 * otherwise land in whatever field has the cursor.
 *
 * A tick is not one write: a drag arrives as several events to the buffer, and a
 * long one can be split across two reads, which is what the carry is for.
 */
export function translateWheel(chunk: string, carry = ''): WheelTranslation {
  const input = carry + chunk
  let text = ''
  let at = 0

  for (const match of input.matchAll(MOUSE_EVENT)) {
    const index = match.index ?? 0
    text += input.slice(at, index)
    at = index + match[0].length
    const key = WHEEL_KEYS[Number(match[1]) & BUTTON_MASK]
    if (key) text += key
  }

  const rest = input.slice(at)
  if (PARTIAL.test(rest)) return { text, carry: rest }
  return { text: text + rest, carry: '' }
}

/**
 * The terminal's input, with the mouse taken out of it.
 *
 * Ink reads stdin in "readable" mode and owns the raw mode of the tty, so this is
 * a pass-through that carries the same surface — `read`, `setRawMode`, `ref`,
 * `isTTY` — while rewriting what comes through it. The terminal decodes as utf8
 * on the way in, because cutting a multi-byte character in half at a write
 * boundary is how an `ç` becomes two wrong ones.
 *
 * Typed as the tty stream Ink asks for: it is not one, and everything that
 * reaches past the surface below goes to the real one.
 */
export function mouseStdin(): NodeJS.ReadStream {
  const source = process.stdin
  const filtered = new PassThrough()
  const input = filtered as PassThrough & {
    isTTY?: boolean
    setRawMode?(mode: boolean): void
    ref(): void
    unref(): void
  }

  input.isTTY = source.isTTY
  input.setRawMode = (mode: boolean) => source.setRawMode(mode)
  input.ref = () => source.ref()
  input.unref = () => source.unref()

  let carry = ''
  source.setEncoding('utf8')
  source.on('data', (chunk: string) => {
    const { text, carry: held } = translateWheel(chunk, carry)
    carry = held
    if (text) filtered.write(text)
  })

  return filtered as unknown as NodeJS.ReadStream
}
