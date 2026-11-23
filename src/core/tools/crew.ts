import { z } from 'zod'
import { errorMessage } from '../../util/errors.js'
import { COLOR_PALETTE_IDS } from '../color-palettes.js'
import { CREW_AVATAR_ACCESSORIES, CREW_AVATAR_EYES, CREW_AVATAR_SHAPES } from '../crew.js'
import type { Tool } from './types.js'
import { listProviderModels, listProviders } from '../config/load.js'

const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), includeArchived: z.boolean().optional() }),
  z.object({ action: z.literal('show'), id: z.string() }),
  z.object({
    action: z.literal('create'),
    name: z.string(),
    handle: z.string().optional(),
    instructions: z.string().optional(),
  }),
  z.object({
    action: z.literal('update'),
    id: z.string(),
    name: z.string().optional(),
    handle: z.string().optional(),
    instructions: z.string().optional(),
  }),
  z.object({ action: z.literal('rename'), id: z.string(), name: z.string() }),
  z.object({
    action: z.literal('avatar'),
    id: z.string(),
    shuffle: z.boolean().optional(),
    shape: z.enum(CREW_AVATAR_SHAPES).optional(),
    eyes: z.enum(CREW_AVATAR_EYES).optional(),
    accessory: z.enum(CREW_AVATAR_ACCESSORIES).optional(),
    palette: z.enum(COLOR_PALETTE_IDS).optional(),
  }),
  z.object({ action: z.literal('stop'), id: z.string() }),
  z.object({ action: z.literal('guide'), id: z.string(), text: z.string() }),
  z.object({ action: z.literal('keep'), id: z.string() }),
  z.object({ action: z.literal('remove'), id: z.string() }),
  z.object({ action: z.literal('providers') }),
  z.object({ action: z.literal('models'), provider: z.string() }),
])

export const crewTool: Tool<z.infer<typeof schema>> = {
  name: 'crew',
  description: 'List active Crew bots (pass includeArchived: true to include archived one-off task bots) and their assignments, create a bot, inspect, update profile (name, handle, instructions), rename, customize, keep an archived bot in Crew, or remove a bot, or guide or stop a running bot when asked. Use list first to find a bot id, and task with a bot id to reuse an available bot. Removing asks for confirmation outside Unrestricted mode and cannot be undone. Before choosing a different provider or model, use providers and models to discover configured provider ids and their model ids; never invent one.',
  schema,
  internal: true,
  requiresConfirmation: (args) => args.action === 'remove',
  async execute(args, ctx) {
    if (!ctx.crew) return { content: 'Crew is not available in this session.', isError: true }
    try {
      if (args.action === 'providers') return { content: JSON.stringify(listProviders()) }
      if (args.action === 'models') {
        if (!listProviders().some((provider) => provider.id === args.provider)) return { content: 'That provider is not configured. Use providers to list the available ids.', isError: true }
        return { content: JSON.stringify(await listProviderModels(args.provider)) }
      }
      if (args.action === 'list') {
        const bots = ctx.crew.list({ includeArchived: args.includeArchived })
        return { content: bots.length ? JSON.stringify(bots) : args.includeArchived ? 'There are no Crew bots yet.' : 'There are no active Crew bots.' }
      }
      if (args.action === 'create') {
        return {
          content: JSON.stringify(
            await ctx.crew.create({
              name: args.name,
              handle: args.handle,
              instructions: args.instructions,
            }),
          ),
        }
      }
      if (args.action === 'update') {
        if (args.name === undefined && args.handle === undefined && args.instructions === undefined) {
          return { content: 'Pass at least one profile field to update (name, handle, instructions).', isError: true }
        }
        return {
          content: JSON.stringify(
            await ctx.crew.updateProfile(args.id, {
              name: args.name,
              handle: args.handle,
              instructions: args.instructions,
            }),
          ),
        }
      }
      if (args.action === 'rename') return { content: JSON.stringify(await ctx.crew.rename(args.id, args.name)) }
      if (args.action === 'avatar') {
        const hasTraits = args.shape !== undefined || args.eyes !== undefined || args.accessory !== undefined || args.palette !== undefined
        if (!args.shuffle && !hasTraits) {
          return { content: 'Pass shuffle or at least one avatar trait (shape, eyes, accessory, palette).', isError: true }
        }
        const patch = args.shuffle
          ? 'shuffle'
          : { shape: args.shape, eyes: args.eyes, accessory: args.accessory, palette: args.palette }
        return { content: JSON.stringify(await ctx.crew.updateAvatar(args.id, patch)) }
      }
      if (args.action === 'stop') { await ctx.crew.stop(args.id); return { content: 'Stop requested.' } }
      if (args.action === 'guide') { await ctx.crew.guide(args.id, args.text); return { content: 'Guidance queued for the bot.' } }
      if (args.action === 'keep') {
        const bot = await ctx.crew.keep(args.id)
        return { content: JSON.stringify(bot) }
      }
      if (args.action === 'remove') {
        const bot = await ctx.crew.remove(args.id)
        return { content: `Removed bot ${bot.name} (${bot.id}).` }
      }
      const bot = ctx.crew.get(args.id)
      return bot ? { content: JSON.stringify(bot) } : { content: 'No bot has that id.', isError: true }
    } catch (error) {
      return { content: `Could not access Crew: ${errorMessage(error)}`, isError: true }
    }
  },
}
