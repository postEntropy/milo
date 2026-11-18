import { z } from 'zod'
import { errorMessage } from '../../util/errors.js'
import { COLOR_PALETTE_IDS } from '../color-palettes.js'
import { CREW_AVATAR_ACCESSORIES, CREW_AVATAR_EYES, CREW_AVATAR_SHAPES } from '../crew.js'
import type { Tool } from './types.js'
import { listProviderModels, listProviders } from '../config/load.js'

const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }),
  z.object({ action: z.literal('show'), id: z.string() }),
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
  z.object({ action: z.literal('providers') }),
  z.object({ action: z.literal('models'), provider: z.string() }),
])

export const crewTool: Tool<z.infer<typeof schema>> = {
  name: 'crew',
  description: 'List Crew bots and their assignments, inspect, rename or customize a bot avatar, or guide or stop a running bot when asked. Use task with a bot id to reuse an available bot. Before choosing a different provider or model, use providers and models to discover configured provider ids and their model ids; never invent one.',
  schema,
  internal: true,
  async execute(args, ctx) {
    if (!ctx.crew) return { content: 'Crew is not available in this session.', isError: true }
    try {
      if (args.action === 'providers') return { content: JSON.stringify(listProviders()) }
      if (args.action === 'models') {
        if (!listProviders().some((provider) => provider.id === args.provider)) return { content: 'That provider is not configured. Use providers to list the available ids.', isError: true }
        return { content: JSON.stringify(await listProviderModels(args.provider)) }
      }
      if (args.action === 'list') {
        const bots = ctx.crew.list()
        return { content: bots.length ? JSON.stringify(bots) : 'There are no Crew bots yet.' }
      }
      if (args.action === 'rename') return { content: JSON.stringify(await ctx.crew.rename(args.id, args.name)) }
      if (args.action === 'avatar') {
        const patch = args.shuffle
          ? 'shuffle'
          : { shape: args.shape, eyes: args.eyes, accessory: args.accessory, palette: args.palette }
        return { content: JSON.stringify(await ctx.crew.updateAvatar(args.id, patch)) }
      }
      if (args.action === 'stop') { await ctx.crew.stop(args.id); return { content: 'Stop requested.' } }
      if (args.action === 'guide') { await ctx.crew.guide(args.id, args.text); return { content: 'Guidance queued for the bot.' } }
      const bot = ctx.crew.list().find((entry) => entry.id === args.id)
      return bot ? { content: JSON.stringify(bot) } : { content: 'No bot has that id.', isError: true }
    } catch (error) {
      return { content: `Could not access Crew: ${errorMessage(error)}`, isError: true }
    }
  },
}
