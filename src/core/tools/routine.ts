import { z } from 'zod'
import {
  describeTarget,
  describeWhen,
  formatLocal,
  nextRunAt,
  parseWhen,
  ROUTINE_GATEWAYS,
  type RoutineGateway,
  type RoutineTarget,
} from '../routines.js'
import type { Tool, ToolContext } from './types.js'

const schema = z.object({
  prompt: z
    .string()
    .min(1)
    .describe(
      'What to do when the routine fires — the message of the turn, written as the person would have asked it in the moment.',
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
    .describe('An interval: "30m", "2h", "1d". Use when the person said "every …".'),
  at: z
    .string()
    .optional()
    .describe('A wall-clock time, "08:00" or "8h". Use when the person said "every day at …" or "every Monday at …".'),
  days: z
    .array(z.string())
    .optional()
    .describe('Days for `at`, e.g. ["mon","tue","wed"] or ["mon-fri"]. Absent means every day.'),
  gateway: z
    .enum(['telegram', 'discord', 'web'])
    .optional()
    .describe('Where to deliver. Absent: the chat this request came from, when it can receive messages.'),
  conversationId: z
    .string()
    .optional()
    .describe('The chat or channel id on that gateway. Absent: the chat this request came from.'),
  allow: z
    .array(z.string())
    .optional()
    .describe(
      'Tools this routine may use with nobody there to confirm, e.g. ["shell_command","send_file"] — needed for anything that writes, runs or sends something, since a scheduled run has no one to ask. Every name is a standing grant, and the person is asked to approve it when the routine is created, so name the fewest that do it.',
    ),
})

export type RoutineArgs = z.infer<typeof schema>

export const routineTool: Tool<RoutineArgs> = {
  name: 'routine',
  description:
    'Create a routine: a prompt Milo runs on a timer and delivers to a chat, with nobody there when it fires. What the person says comes in natural language and this turns it into a routine — "every two hours" is `every: "2h"`, "every day at 8" is `at: "08:00"`, "every Monday at 9" is `at: "09:00"` with `days: ["mon"]`, "weekdays at 8" is `at: "08:00"` with `days: ["mon-fri"]`. A routine fires at its next time and every time after; it does not run while `milo serve` is down, and a time missed that way is skipped rather than caught up. It delivers to the chat the request came from when that chat can receive messages; from a surface that cannot (the CLI), name `gateway` and `conversationId` — ask the person which chat, do not guess. Its answer is text, and it can also deliver files with `send_file` — a picture as a picture, anything else as a document — so "every morning, screenshot the screen and send it" is `shell_command` plus `send_file`, both named in `allow`. A routine runs with nobody to confirm anything: reading needs no permission, but anything that writes, runs a command or sends a file has to be named in `allow`, and the person is asked to approve those tools before the routine exists. Ask them in the conversation rather than deciding for them, and keep the list to what the prompt actually needs. Always say the name, the time, the destination and the granted tools back, so they can correct it before it ever fires.',
  schema,
  asksWhen: (args) => (args.allow?.length ?? 0) > 0,
  async execute(args, ctx) {
    if (!ctx.routine) {
      return { content: 'Routines are not available in this session.', isError: true }
    }

    const when = parseWhen({ every: args.every, at: args.at, days: args.days })
    if (!when) {
      return {
        content:
          'That is not a time I can set. Say it as an interval ("every 30 minutes") or a time ("every day at 8"), and I will make it a routine.',
        isError: true,
      }
    }

    const target = resolveTarget(args, ctx)
    if (!target) {
      return {
        content:
          'I need to know which chat to deliver to: pass `gateway` ("telegram", "discord" or "web") and `conversationId`.',
        isError: true,
      }
    }

    try {
      const routine = await ctx.routine({
        prompt: args.prompt,
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
  },
}

/**
 * Where the answer goes. A person who says "every day at 8, send me that" while
 * talking to the bot on Telegram means that chat, so the conversation the turn
 * came from is the default — for the surfaces that can receive a message on their
 * own. The CLI cannot, so there the target has to be named.
 */
function resolveTarget(args: RoutineArgs, ctx: ToolContext): RoutineTarget | null {
  if (args.gateway && args.conversationId) {
    return { gateway: args.gateway, conversationId: args.conversationId }
  }
  // Half a target is not one: guessing the other half is how a routine goes quiet.
  if (args.gateway || args.conversationId) return null

  const origin = ctx.origin
  if (origin && (ROUTINE_GATEWAYS as readonly string[]).includes(origin.gateway)) {
    return { gateway: origin.gateway as RoutineGateway, conversationId: origin.conversationId }
  }
  return null
}
