import { z } from 'zod'
import { errorMessage } from '../../util/errors.js'
import { parseWhen, ROUTINE_GATEWAYS, type RoutineGateway, type RoutineTarget } from '../routines.js'
import type { Tool } from './types.js'

const schema = z.object({
  action: z.enum(['create', 'list', 'show', 'pause', 'resume', 'cancel', 'update']),
  id: z.string().optional().describe('The work id shown by list.'),
  name: z.string().max(120).optional().describe('A short name for the work.'),
  objective: z.string().max(8_000).optional().describe('The complete objective, including what the person wants reported.'),
  every: z.string().optional().describe('A recurring interval, such as 2h. Omit all schedule fields for one-time work.'),
  at: z.string().optional().describe('The local clock time for recurring work, such as 08:00.'),
  days: z.array(z.string()).optional(),
  dayOfMonth: z.array(z.string()).optional(),
  month: z.array(z.string()).optional(),
  once: z.boolean().optional().describe('On update, remove the schedule and make the next run one-time.'),
  gateway: z.enum(['telegram', 'discord', 'web', 'none']).optional(),
  chatId: z.string().optional(),
  allow: z.array(z.string()).optional().describe('Tools allowed unattended; these are standing grants the person must approve.'),
}).superRefine((args, ctx) => {
  const scheduled = args.every !== undefined || args.at !== undefined || args.days !== undefined || args.dayOfMonth !== undefined || args.month !== undefined
  if (args.action !== 'create') {
    if (args.name !== undefined || args.allow !== undefined || args.gateway !== undefined || args.chatId !== undefined) {
      ctx.addIssue({ code: 'custom', message: `name, allow, gateway and chatId only apply to action "create".` })
    }
  }
  if (args.action !== 'create' && args.action !== 'update') {
    if (scheduled || args.objective !== undefined || args.once !== undefined) {
      ctx.addIssue({ code: 'custom', message: `schedule, once and objective only apply to create or update.` })
    }
  }
  if (args.once && (args.action !== 'update' || scheduled)) {
    ctx.addIssue({ code: 'custom', message: 'once only applies on update without schedule fields.' })
  }
  if (args.name && /[\r\n]/.test(args.name)) {
    ctx.addIssue({ code: 'custom', message: 'Work name must fit on one line.' })
  }
})
type Args = z.infer<typeof schema>

function target(args: Args, origin?: { gateway: string; chatId: string }): RoutineTarget | null {
  if (args.gateway === 'none') return { gateway: 'none' }
  if (args.gateway && args.chatId) return { gateway: args.gateway, chatId: args.chatId }
  if (args.gateway || args.chatId) return null
  if (origin && (ROUTINE_GATEWAYS as readonly string[]).includes(origin.gateway)) return { gateway: origin.gateway as RoutineGateway, chatId: origin.chatId }
  return { gateway: 'none' }
}

function needsCreateConfirmation(args: Args): boolean {
  if (args.action !== 'create' || !(args.allow?.length)) return false
  if (!args.name?.trim() || !args.objective?.trim() || args.allow.includes('gmail_send')) return false
  return true
}

export const delegatedWorkTool: Tool<Args> = {
  name: 'delegated_work',
  description: 'Manage work delegated to Milo to run in the background. Create one-time work or ongoing work on a schedule; it starts when milo serve is running and ongoing work runs again at its scheduled time. Give a complete objective and a short name. The same agent can create Crew bots during the work. Use list before show, update, pause, resume or cancel, and use the exact id. Update changes the objective or replaces the schedule while not running. A run may use only its standing grants without a person present: name the fewest needed in allow, which asks the person to approve them. The work inherits the current Session folder and delivers to the current chat when possible; gateway none keeps its history without sending a message.',
  schema,
  asksWhen: (args) => needsCreateConfirmation(args) || ((args.action === 'resume' || args.action === 'update') && Boolean(args.id?.trim())),
  requiresConfirmation: (args) => needsCreateConfirmation(args) || ((args.action === 'resume' || args.action === 'update') && Boolean(args.id?.trim())),
  async execute(args, ctx) {
    if (!ctx.delegatedWork || !ctx.sessionId) return { content: 'Delegated work is not available in this session.', isError: true }
    try {
      if (args.action === 'list') {
        const items = ctx.delegatedWork.list()
        return { content: items.length ? JSON.stringify(items) : 'No delegated work yet.' }
      }
      if (args.action === 'create') {
        if (!args.name?.trim() || !args.objective?.trim()) return { content: 'Work needs a name and objective.', isError: true }
        if (args.allow?.includes('gmail_send')) return { content: 'Sending mail needs approval for each message and cannot be granted to unattended work.', isError: true }
        const unknown = ctx.availableTools ? (args.allow ?? []).filter((name) => !ctx.availableTools!.includes(name)) : []
        if (unknown.length) return { content: `Unknown tools: ${unknown.join(', ')}. Available tools: ${ctx.availableTools!.join(', ')}.`, isError: true }
        const scheduled = args.every !== undefined || args.at !== undefined || args.days !== undefined || args.dayOfMonth !== undefined || args.month !== undefined
        const schedule = scheduled ? parseWhen(args) : undefined
        if (scheduled && !schedule) return { content: 'Choose a valid interval or local time for this work.', isError: true }
        const destination = target(args, ctx.origin)
        if (!destination) return { content: 'Provide a gateway and chat id together, or use gateway none.', isError: true }
        const work = await ctx.delegatedWork.create({ name: args.name, objective: args.objective, schedule: schedule ?? undefined, target: destination, allow: args.allow ?? [], originSessionId: ctx.sessionId, project: ctx.projectId })
        return { content: `Created delegated work "${work.name}" (${work.id}). It starts when milo serve is running. ${work.schedule ? 'It repeats on the requested schedule.' : 'It runs once.'} Allowed tools: ${work.allow.length ? work.allow.join(', ') : 'none'}.` }
      }
      if (!args.id) return { content: 'Provide the work id from the list.', isError: true }
      if (args.action === 'show') {
        const work = ctx.delegatedWork.list().find((item) => item.id === args.id)
        return work ? { content: JSON.stringify(work) } : { content: 'No delegated work has that id.', isError: true }
      }
      if (args.action === 'update') {
        const scheduled = args.every !== undefined || args.at !== undefined || args.days !== undefined || args.dayOfMonth !== undefined || args.month !== undefined
        if (args.once && scheduled) return { content: 'Choose a schedule or one-time work, not both.', isError: true }
        const schedule = scheduled ? parseWhen(args) : undefined
        if (scheduled && !schedule) return { content: 'Choose a valid interval or local time for this work.', isError: true }
        if (args.objective === undefined && !scheduled && !args.once) return { content: 'Provide an objective or schedule to change.', isError: true }
        const work = await ctx.delegatedWork.edit(args.id, { objective: args.objective, schedule: args.once ? null : schedule ?? undefined })
        return { content: `Updated ${work.name}: ${work.state}.` }
      }
      const work = await ctx.delegatedWork.control(args.id, args.action)
      return { content: `${work.name}: ${work.state}${work.pauseAfterRun ? ' (will pause after this run)' : ''}.` }
    } catch (error) {
      return { content: `Could not manage delegated work: ${errorMessage(error)}`, isError: true }
    }
  },
}
