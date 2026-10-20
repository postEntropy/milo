/**
 * What `/` offers, as one list: the name, what follows it in a usage line, and what
 * it does. The daemon's `/help`, the browser's palette and the phone's draw this
 * same list. The browser imports it; the phone cannot, so the daemon sends it in
 * the `ready` frame — one declaration, three surfaces.
 */
export interface CommandEntry {
  name: string
  /** The part after the name in a usage line, when the command takes one. */
  usage?: string
  hint: string
}

export const COMMAND_CATALOG: CommandEntry[] = [
  { name: 'mode', usage: ' ask|auto|yolo', hint: 'permission mode, saved for every surface' },
  { name: 'yolo', hint: 'toggle yolo mode' },
  { name: 'tools', usage: ' full|name|off', hint: 'how much of each tool call to show' },
  {
    name: 'thinking',
    usage: ' expanded|collapsed',
    hint: "open the model's reasoning under the question or leave it folded (display only; /effort is what changes how it thinks)",
  },
  { name: 'effort', usage: ' low|medium|high', hint: 'how hard the model thinks (the one that costs)' },
  {
    name: 'provider',
    usage: ' [id]',
    hint: 'the provider the install answers with: list them, or switch to one',
  },
  {
    name: 'model',
    usage: ' [id]',
    hint: "the model the install answers with: list the current provider's, or switch to one",
  },
  { name: 'new', usage: ' [title]', hint: 'start a new session' },
  { name: 'sessions', usage: ' [page]', hint: 'list saved sessions' },
  { name: 'resume', usage: ' <id>', hint: 'switch to another session' },
  { name: 'fork', usage: ' [id] [turn]', hint: 'branch into a new session from this or a named session' },
  { name: 'stats', hint: 'numbers for the current session' },
  { name: 'jobs', usage: ' [kill <id>]', hint: 'the background jobs, and how they are doing' },
  {
    name: 'compact',
    hint: 'fold the oldest turns into the summary now, instead of when the context fills up',
  },
  {
    name: 'export',
    usage: ' [md|json]',
    hint: 'write this session out as a file, tool calls and reasoning included',
  },
  { name: 'skills', hint: 'the skills installed, and where they live' },
  { name: 'memory', usage: ' [forget <id>]', hint: 'what Milo keeps, and how to drop one of them' },
  { name: 'clear', hint: 'forget this session' },
  { name: 'status', hint: 'permission mode and display settings' },
  { name: 'stop', hint: 'stop the turn running now, and anything queued behind it' },
  { name: 'steer', usage: ' <text>', hint: 'hand text to the turn running now, at its next step' },
  { name: 'queue', usage: ' <text>', hint: 'say it as its own turn, after the one running now' },
  { name: 'help', hint: 'this message' },
]
