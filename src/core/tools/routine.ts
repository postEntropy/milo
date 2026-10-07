import { z } from 'zod'
import {
  describeTarget,
  describeWhen,
  formatLocal,
  nextRunAt,
  parseWhen,
  ROUTINE_GATEWAYS,
  type Routine,
  type RoutineGateway,
  type RoutineTarget,
} from '../routines.js'
import type { RoutineStore, Tool, ToolContext, ToolResult } from './types.js'

const schema = z.object({
  action: z
    .enum(['create', 'update', 'remove', 'list'])
    .optional()
    .describe(
      'What to do. Default "create": make a new routine. "list": show the routines and their ids. "update": change an existing routine, named by `id`. "remove": delete one, named by `id`. To change or remove one, list first and use the id it shows.',
    ),
  id: z
    .string()
    .optional()
    .describe(
      'The routine to change or remove — its id from `action: "list"`, like "calm-otter-7". Required for "update" and "remove".',
    ),
  prompt: z
    .string()
    .optional()
    .describe(
      'What to do when the routine fires — the message of the turn, written as the person would have asked it in the moment. Required for "create"; on "update" it replaces the prompt.',
    ),
  name: z
    .string()
    .optional()
    .describe(
      'What to call the routine — two or three words, e.g. "daily briefing" or "deploy status". This is how the person refers to it and how its message is signed in the chat. Absent: the first words of the prompt are used.',
    ),
  every: z
    .string()
    .optional()
    .describe('An interval: "30s", "30m", "2h", "1d". Use when the person said "every …".'),
  at: z
    .string()
    .optional()
    .describe('A wall-clock time, "08:00" or "8h". Use when the person said "every day at …" or "every Monday at …".'),
  days: z
    .array(z.string())
    .optional()
    .describe('Days of the week for `at`, e.g. ["mon","tue","wed"] or ["mon-fri"]. Absent means every day. Not with `dayOfMonth`.'),
  dayOfMonth: z
    .array(z.string())
    .optional()
    .describe('Days of the month for `at`, e.g. ["1"] or ["1","15"] or ["1-15"]. Use for "the 1st of each month"; not with `days`.'),
  month: z
    .array(z.string())
    .optional()
    .describe('Months for `at`, e.g. ["dec"] or ["jul","aug"]. Use for "every December". Combines with `days` or `dayOfMonth`.'),
  gateway: z
    .enum(['telegram', 'discord', 'web', 'none'])
    .optional()
    .describe('Where to deliver. "none" keeps the runs on the Routines screen and posts them nowhere. Absent: the chat this request came from, when it can receive messages. On "update": absent leaves the destination as it is.'),
  conversationId: z
    .string()
    .optional()
    .describe('The chat or channel id on that gateway. Absent: the chat this request came from. Not needed when gateway is "none".'),
  allow: z
    .array(z.string())
    .optional()
    .describe(
      'Tools this routine may use with nobody there to confirm, e.g. ["shell_command","send_file"] — needed for anything that writes, runs or sends something, since a scheduled run has no one to ask. Every name is a standing grant, and the person is asked to approve it when the routine is created, so name the fewest that do it. On "update": what is passed replaces the grants.',
    ),
  enabled: z
    .boolean()
    .optional()
    .describe('For "update": run it (true) or pause it (false). Absent: unchanged.'),
})

export type RoutineArgs = z.infer<typeof schema>

const NOT_A_TIME =
  'That is not a time I can set. Say it as an interval ("every 30 minutes"), a time ("every day at 8"), or a date ("the 1st of each month", "every 25 December", "weekdays in July"), and I will make it a routine.'

export const routineTool: Tool<RoutineArgs> = {
  name: 'routine',
  description:
    'Manage routines: a prompt Milo runs on a timer and delivers to a chat — or to no chat at all — with nobody there when it fires. Use it when the person wants something to happen on a schedule ("every two hours", "every weekday at 8", "the 1st of each month") or wants to change, pause or drop one they already have. What the person says comes in natural language; you turn it into a routine. "every two hours" is `every: "2h"`; "every 30 seconds" is `every: "30s"` (seconds and minutes are both fine — the shortest is one second); "every day at 8" is `at: "08:00"`; "every Monday at 9" is `at: "09:00"` with `days: ["mon"]`; "weekdays at 8" is `at: "08:00"` with `days: ["mon-fri"]`; "the 1st of each month at 9" is `at: "09:00"` with `dayOfMonth: ["1"]`; "every 25 December" is `at: "09:00"` with `month: ["dec"]` and `dayOfMonth: ["25"]`; and "every Monday in July" is `at: "09:00"` with `days: ["mon"]` and `month: ["jul"]` — a day of the week and a day of the month are never combined, so pick one. A routine fires at its next time and every time after; it does not run while `milo serve` is down, and a time missed that way is skipped rather than caught up. It delivers to the chat the request came from when that chat can receive messages; from a surface that cannot (the CLI), name `gateway` and `conversationId` — ask the person which chat, do not guess. A routine may also deliver nowhere: `gateway: "none"` (what the web UI calls "Routines screen only") keeps every run on the Routines screen and posts to no chat — reach for it whenever the person does not want the answer in a chat, and say that back to them. Its answer is text, and it can also deliver files with `send_file` — a picture as a picture, anything else as a document. That is the only thing that makes a picture a picture: the file lands on the run\'s own record, which is what the Routines screen draws, so a routine whose output IS an image must `send_file` it even when it delivers nowhere — a path in the answer is text. So "every morning, screenshot the screen and send it" is `shell_command` plus `send_file`, both named in `allow`. A routine runs with nobody to confirm anything: reading needs no permission, but anything that writes, runs a command or sends a file has to be named in `allow`, and the person is asked to approve those tools before the routine exists. Ask them in the conversation rather than deciding for them, and keep the list to what the prompt actually needs. Always say the name, the time, the destination and the granted tools back, so they can correct it before it ever fires.\n\nTo change or remove a routine, first call this tool with `action: "list"` — it names every routine with its id. Then call again with `action: "update"` or `"remove"` and that `id`. Do not guess an id. On `update`, pass only what changes: a new `at`/`every` (and the `days`, `dayOfMonth` or `month` it keeps — restate the whole schedule, the fields you leave out are not carried over), a new `gateway`+`conversationId` or `"none"`, a new `prompt` or `name`, `enabled` to pause or resume, or a new `allow`. An `update` with nothing to change changes nothing. Say what the routine is now after an update, and confirm which one you removed — by name, not id.',
  schema,
  asksWhen: (args) => args.action === 'remove' || (args.allow?.length ?? 0) > 0,
  async execute(args, ctx) {
    const routines = ctx.routine
    if (!routines) {
      return { content: 'Routines are not available in this session.', isError: true }
    }

    switch (args.action ?? 'create') {
      case 'list':
        return handleList(routines)
      case 'update':
        return await handleUpdate(args, routines)
      case 'remove':
        return await handleRemove(args, routines)
      default:
        return await handleCreate(args, ctx, routines)
    }
  },
}

/** `calm-otter-7 — "daily briefing" — 08:00, mon–fri → telegram:123 — next …, never run`. */
function describeRoutine(routine: Routine): string {
  const next = routine.enabled
    ? `next ${formatLocal(nextRunAt(routine.when, new Date()))}`
    : 'paused'
  const last = routine.lastRunAt
    ? `last ${routine.lastResult ?? 'ok'} at ${formatLocal(new Date(routine.lastRunAt))}`
    : 'never run'
  return `${routine.id} — "${routine.name ?? routine.prompt}" — ${describeWhen(routine.when)} → ${describeTarget(routine.target)} — ${next}, ${last}`
}

function handleList(routines: RoutineStore): ToolResult {
  const all = routines.list()
  if (all.length === 0) return { content: 'No routines yet.' }
  return { content: `Routines (${all.length}):\n${all.map(describeRoutine).join('\n')}` }
}

async function handleCreate(args: RoutineArgs, ctx: ToolContext, routines: RoutineStore): Promise<ToolResult> {
  const prompt = args.prompt?.trim()
  if (!prompt) {
    return { content: 'A routine needs a prompt — what to do when it fires.', isError: true }
  }
  const when = parseWhen({
    every: args.every,
    at: args.at,
    days: args.days,
    dayOfMonth: args.dayOfMonth,
    month: args.month,
  })
  if (!when) return { content: NOT_A_TIME, isError: true }

  const target = resolveTarget(args, ctx)
  if (!target) {
    return {
      content:
        'I need to know where to deliver: pass `gateway` ("telegram", "discord", "web", or "none" for the Routines screen) and `conversationId`.',
      isError: true,
    }
  }

  try {
    const routine = await routines.create({
      prompt,
      name: args.name,
      when,
      target,
      allow: args.allow?.length ? args.allow : undefined,
      enabled: true,
    })
    const next = formatLocal(nextRunAt(routine.when, new Date()))
    const granted = routine.allow?.length ? `, may use ${routine.allow.join(', ')}` : ''
    return {
      content: `Created routine "${routine.name ?? routine.prompt}" — ${describeWhen(routine.when)}, next ${next}, delivered to ${describeTarget(routine.target)}${granted}. Id ${routine.id}; \`milo routines remove ${routine.id}\` removes it.`,
    }
  } catch (error) {
    return { content: error instanceof Error ? error.message : String(error), isError: true }
  }
}

async function handleUpdate(args: RoutineArgs, routines: RoutineStore): Promise<ToolResult> {
  const id = args.id?.trim()
  if (!id) {
    return { content: 'Name the routine by its id — pass `action: "list"` to see them.', isError: true }
  }
  const existing = routines.list().find((routine) => routine.id === id)
  if (!existing) return { content: `No routine ${id}.`, isError: true }

  // A schedule is changed all at once: what the person did not restate is not
  // carried over, which the description says and the reply makes visible.
  let when: Routine['when'] | undefined
  if (args.every !== undefined || args.at !== undefined || args.days !== undefined || args.dayOfMonth !== undefined || args.month !== undefined) {
    const parsed = parseWhen({
      every: args.every,
      at: args.at,
      days: args.days,
      dayOfMonth: args.dayOfMonth,
      month: args.month,
    })
    if (!parsed) return { content: NOT_A_TIME, isError: true }
    when = parsed
  }

  let target: RoutineTarget | undefined
  if (args.gateway !== undefined || args.conversationId !== undefined) {
    if (args.gateway === 'none') target = { gateway: 'none' }
    else if (args.gateway && args.conversationId) target = { gateway: args.gateway, conversationId: args.conversationId }
    else {
      return {
        content:
          'A destination needs both a gateway ("telegram", "discord" or "web") and a `conversationId`, or `gateway: "none"` for the Routines screen.',
        isError: true,
      }
    }
  }

  const patch: Partial<Omit<Routine, 'id' | 'createdAt'>> = {}
  if (args.prompt !== undefined) patch.prompt = args.prompt.trim()
  if (args.name !== undefined) patch.name = args.name
  if (when !== undefined) patch.when = when
  if (target !== undefined) patch.target = target
  if (args.allow !== undefined) patch.allow = args.allow
  if (args.enabled !== undefined) patch.enabled = args.enabled

  if (Object.keys(patch).length === 0) {
    return { content: `Nothing to change on ${describeRoutine(existing)}.` }
  }

  const updated = await routines.update(id, patch)
  if (!updated) return { content: `No routine ${id}.`, isError: true }
  return { content: `Updated ${describeRoutine(updated)}.` }
}

async function handleRemove(args: RoutineArgs, routines: RoutineStore): Promise<ToolResult> {
  const id = args.id?.trim()
  if (!id) {
    return { content: 'Name the routine by its id — pass `action: "list"` to see them.', isError: true }
  }
  const existing = routines.list().find((routine) => routine.id === id)
  if (!existing) return { content: `No routine ${id}.`, isError: true }
  if (!(await routines.remove(id))) return { content: `No routine ${id}.`, isError: true }
  return { content: `Removed "${existing.name ?? existing.prompt}" (${id}).` }
}

/**
 * Where a new routine delivers. A person who says "every day at 8, send me that"
 * while talking to the bot on Telegram means that chat, so the conversation the
 * turn came from is the default — for the surfaces that can receive a message on
 * their own. The CLI cannot, so there the target has to be named.
 */
function resolveTarget(args: RoutineArgs, ctx: ToolContext): RoutineTarget | null {
  // Delivering nowhere is a choice, not a missing half: the runs are kept on the
  // Routines screen and no chat is named.
  if (args.gateway === 'none') return { gateway: 'none' }
  if (args.gateway && args.conversationId) {
    return { gateway: args.gateway, conversationId: args.conversationId }
  }
  // Half a target is not one: guessing the other half is how a routine goes quiet.
  if (args.gateway || args.conversationId) return null

  const origin = ctx.origin
  if (origin?.gateway === 'none') return { gateway: 'none' }
  if (origin && (ROUTINE_GATEWAYS as readonly string[]).includes(origin.gateway)) {
    return { gateway: origin.gateway as RoutineGateway, conversationId: origin.conversationId }
  }
  return null
}
