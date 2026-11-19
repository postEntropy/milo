import { type CrewBot, type CrewStore, normalizeBotHandle } from './crew.js'
import { extractProjectMentionMatches, type Project, type ProjectMentionMatch, readProjects } from './projects.js'
import type { BotAuthor, ContentPart, Message } from './providers/types.js'

export interface ExplicitMentionRef {
  kind: 'bot' | 'folder'
  id: string
  start: number
  end: number
}

export interface ParsedCrewMentions {
  bots: CrewBot[]
  unknown: string[]
  hasExplicitMentions: boolean
}

export interface ParseCrewMentionsOptions {
  ignoreHandles?: readonly string[]
  projects?: readonly Project[]
}

export interface ResolvedMessageMentions extends ParsedCrewMentions {
  folders: Project[]
}

export interface ResolveMessageMentionsOptions extends ParseCrewMentionsOptions {
  explicitMentions?: readonly ExplicitMentionRef[]
  resolveBots?: boolean
}

const FENCED_CODE_BLOCK_PATTERN = /```[\s\S]*?```|~~~[\s\S]*?~~~/g
const INLINE_CODE_PATTERN = /`[^`\n]*`/g
const CREW_MENTION_PATTERN =
  /(?:^|[\s([{"'])@([a-zA-Z0-9][a-zA-Z0-9_-]*)(?=$|[\s,;:!?)\]}"']|\.(?![a-zA-Z0-9_/-]))/g

function blankPreservingOffsets(match: string): string {
  return match.replace(/[^\n]/g, ' ')
}

function stripCodeSpans(text: string): string {
  return text
    .replace(FENCED_CODE_BLOCK_PATTERN, blankPreservingOffsets)
    .replace(INLINE_CODE_PATTERN, blankPreservingOffsets)
}

function safeReadProjects(): Project[] {
  try {
    return readProjects()
  } catch {
    return []
  }
}

function collectExplicitMentions(
  text: string,
  refs: readonly ExplicitMentionRef[] | undefined,
): {
  botAt: Map<number, ExplicitMentionRef>
  folderAt: Map<number, ExplicitMentionRef>
  folderSpans: ExplicitMentionRef[]
} {
  const botAt = new Map<number, ExplicitMentionRef>()
  const folderAt = new Map<number, ExplicitMentionRef>()
  const folderSpans: ExplicitMentionRef[] = []
  if (!refs?.length) return { botAt, folderAt, folderSpans }

  const sorted = [...refs]
    .filter((ref) => Number.isInteger(ref.start) && Number.isInteger(ref.end) && ref.start >= 0 && ref.end > ref.start && ref.end <= text.length && text[ref.start] === '@')
    .sort((a, b) => a.start - b.start)

  let minStart = 0
  for (const ref of sorted) {
    if (ref.start < minStart) continue
    minStart = ref.end
    if (ref.kind === 'bot') {
      botAt.set(ref.start, ref)
    } else {
      folderAt.set(ref.start, ref)
      folderSpans.push(ref)
    }
  }
  return { botAt, folderAt, folderSpans }
}

/**
 * Resolves Crew bot and folder `@mentions` in a single pass so each `@mention`
 * maps to at most one destination: explicit autocomplete choices win over name
 * collisions, multi-word folder mentions own their full span, and manual single-word
 * collisions never trigger both a bot and a folder at once.
 */
export function resolveMessageMentions(
  text: string,
  crew: Pick<CrewStore, 'get' | 'list' | 'findByHandle'> | undefined,
  options?: ResolveMessageMentionsOptions,
): ResolvedMessageMentions {
  if (!text.includes('@') && !options?.explicitMentions?.length) {
    return { bots: [], unknown: [], folders: [], hasExplicitMentions: false }
  }

  const stripped = stripCodeSpans(text)
  const resolveBots = (options?.resolveBots ?? true) && crew !== undefined
  const ignored = new Set(
    (options?.ignoreHandles ?? [])
      .map((handle) => normalizeBotHandle(handle))
      .filter((handle) => handle.length > 0),
  )

  const { botAt, folderAt, folderSpans } = collectExplicitMentions(stripped, options?.explicitMentions)
  const projects = options?.projects ?? safeReadProjects()
  const projectMatches = extractProjectMentionMatches(stripped, projects)
  const projectMatchAt = new Map<number, ProjectMentionMatch>()
  for (const projectMatch of projectMatches) {
    projectMatchAt.set(projectMatch.start, projectMatch)
  }

  const bots: CrewBot[] = []
  const seenBotIds = new Set<string>()
  const unknown: string[] = []
  const seenUnknown = new Set<string>()
  const claimedBotStarts = new Set<number>()
  const handledExplicitBotStarts = new Set<number>()

  const pushBot = (bot: CrewBot) => {
    if (seenBotIds.has(bot.id)) return
    seenBotIds.add(bot.id)
    bots.push(bot)
  }

  const pushUnknown = (handle: string) => {
    if (!handle || seenUnknown.has(handle)) return
    seenUnknown.add(handle)
    unknown.push(handle)
  }

  if (resolveBots && crew) {
    for (const match of stripped.matchAll(CREW_MENTION_PATTERN)) {
      const rawHandle = match[1] ?? ''
      const mentionAt = (match.index ?? 0) + match[0].lastIndexOf('@')
      if (folderSpans.some((span) => mentionAt >= span.start && mentionAt < span.end)) {
        continue
      }
      if (projectMatches.some((span) => mentionAt > span.start && mentionAt < span.end)) {
        continue
      }

      const normalized = normalizeBotHandle(rawHandle)
      const explicitBot = botAt.get(mentionAt)
      if (explicitBot) {
        handledExplicitBotStarts.add(mentionAt)
        const bot = crew.get(explicitBot.id) ?? (normalized ? crew.findByHandle(normalized) : undefined)
        if (bot) {
          claimedBotStarts.add(mentionAt)
          pushBot(bot)
        } else {
          pushUnknown(normalized || explicitBot.id)
        }
        continue
      }

      const folderMatch = projectMatchAt.get(mentionAt)
      if (folderMatch && folderMatch.end - (folderMatch.start + 1) > rawHandle.length) {
        // Multi-word or punctuated folder mentions (e.g. `@Personal Notes`) own their full
        // span and must neither fail as `@Personal` nor invoke a `@personal` bot.
        continue
      }

      if (!normalized || ignored.has(normalized)) continue

      const bot = crew.findByHandle(normalized)
      if (bot) {
        claimedBotStarts.add(mentionAt)
        pushBot(bot)
        continue
      }

      if (folderMatch) continue
      pushUnknown(normalized)
    }

    for (const [start, explicitBot] of botAt) {
      if (handledExplicitBotStarts.has(start)) continue
      const bot = crew.get(explicitBot.id)
      if (bot) {
        claimedBotStarts.add(start)
        pushBot(bot)
      } else {
        const rawToken = stripped.slice(explicitBot.start + 1, explicitBot.end).trim()
        pushUnknown(normalizeBotHandle(rawToken) || explicitBot.id)
      }
    }
  }

  const folderCandidates: Array<{ start: number; project: Project }> = []
  for (const folderRef of folderSpans) {
    const byId = projects.find((project) => project.id === folderRef.id)
    const fallbackMatch = projectMatchAt.get(folderRef.start)?.project
    const resolved = byId ?? fallbackMatch
    if (resolved) folderCandidates.push({ start: folderRef.start, project: resolved })
  }
  for (const projectMatch of projectMatches) {
    if (folderAt.has(projectMatch.start)) continue
    if (botAt.has(projectMatch.start) || claimedBotStarts.has(projectMatch.start)) continue
    if (folderSpans.some((span) => projectMatch.start >= span.start && projectMatch.start < span.end)) continue
    folderCandidates.push({ start: projectMatch.start, project: projectMatch.project })
  }
  folderCandidates.sort((a, b) => a.start - b.start)

  const folders: Project[] = []
  const seenFolderPaths = new Set<string>()
  for (const candidate of folderCandidates) {
    if (seenFolderPaths.has(candidate.project.path)) continue
    seenFolderPaths.add(candidate.project.path)
    folders.push(candidate.project)
  }

  return {
    bots,
    unknown,
    folders,
    hasExplicitMentions: bots.length > 0 || unknown.length > 0,
  }
}

/**
 * Extracts explicit `@handle` Crew bot mentions from user text in order of appearance.
 * Code blocks/spans, emails, file paths, ignored gateway bot usernames, and registered
 * folder mentions that do not match a Crew bot are skipped cleanly.
 */
export function parseCrewMentions(
  text: string,
  crew: Pick<CrewStore, 'get' | 'list' | 'findByHandle'>,
  options?: ParseCrewMentionsOptions,
): ParsedCrewMentions {
  const { bots, unknown, hasExplicitMentions } = resolveMessageMentions(text, crew, options)
  return { bots, unknown, hasExplicitMentions }
}

export function unknownCrewBotsError(
  unknownHandles: readonly string[],
  crew: Pick<CrewStore, 'list'>,
): string {
  const formattedUnknown = unknownHandles.map((handle) => `@${handle}`).join(', ')
  const heading =
    unknownHandles.length === 1
      ? `Crew bot not found: ${formattedUnknown}.`
      : `Crew bots not found: ${formattedUnknown}.`

  const available = crew.list()
  if (available.length === 0) {
    return `${heading} No Crew bots are configured yet.`
  }

  const choices = available
    .map((bot) => (bot.handle ? `@${bot.handle} (${bot.name})` : bot.name))
    .join(', ')
  return `${heading} Available bots: ${choices}.`
}

export function resolveBotAuthor(
  bot: BotAuthor,
  crew?: Pick<CrewStore, 'get'>,
): BotAuthor {
  const live = crew?.get(bot.id)
  if (!live) return bot
  return {
    id: live.id,
    name: live.name,
    ...(live.handle ? { handle: live.handle } : bot.handle ? { handle: bot.handle } : {}),
    avatar: live.avatar ?? bot.avatar,
  }
}

function formatBotAttributionTag(author: BotAuthor): string {
  return author.handle ? `[Crew bot ${author.name} (@${author.handle})]` : `[Crew bot ${author.name}]`
}

/**
 * Returns a non-mutating projection of Session messages for a model turn so prior
 * Crew bot responses (and failures) carry explicit authorship when multiple authors
 * share a Session.
 */
export function projectMessagesForModel(
  messages: readonly Message[],
  crew?: Pick<CrewStore, 'get'>,
  currentBotId?: string,
): Message[] {
  const hasMultipleAuthors =
    currentBotId === undefined
      ? messages.some((msg) => msg.role === 'assistant' && !msg.internal && msg.bot !== undefined)
      : messages.some(
          (msg) =>
            msg.role === 'assistant' &&
            !msg.internal &&
            msg.bot?.id !== currentBotId &&
            (msg.bot !== undefined || msg.content.length > 0 || msg.error !== undefined),
        )

  if (!hasMultipleAuthors) {
    return messages.filter((msg) => !(msg.role === 'assistant' && msg.content.length === 0 && msg.error))
  }

  return messages.map((msg) => {
    if (msg.role !== 'assistant' || msg.internal || !msg.bot) return msg

    const author = resolveBotAuthor(msg.bot, crew)
    const tag = formatBotAttributionTag(author)

    if (msg.content.length === 0 && msg.error) {
      return {
        ...msg,
        content: [{ type: 'text', text: `${tag} failed to respond: ${msg.error}` }],
      }
    }

    const prefix = `${tag}:\n`
    const nextContent: ContentPart[] = []
    let leadingReasoningCount = 0
    while (
      leadingReasoningCount < msg.content.length &&
      msg.content[leadingReasoningCount]?.type === 'reasoning'
    ) {
      nextContent.push(msg.content[leadingReasoningCount]!)
      leadingReasoningCount += 1
    }

    const firstBodyPart = msg.content[leadingReasoningCount]
    if (firstBodyPart?.type === 'text') {
      nextContent.push({
        ...firstBodyPart,
        text: `${prefix}${firstBodyPart.text}`,
      })
      nextContent.push(...msg.content.slice(leadingReasoningCount + 1))
    } else {
      nextContent.push({ type: 'text', text: tag })
      nextContent.push(...msg.content.slice(leadingReasoningCount))
    }

    if (msg.error) {
      nextContent.push({ type: 'text', text: `\n[Error: ${msg.error}]` })
    }

    return {
      ...msg,
      content: nextContent,
    }
  })
}
