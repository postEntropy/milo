import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { AgentEvent } from '../src/core/agent/events.js'
import type {
  ChatRequest,
  Provider,
  StreamEvent,
} from '../src/core/providers/types.js'
import type { ChatSurface } from '../src/gateways/surface.js'

const isolatedMiloHome = mkdtempSync(path.join(tmpdir(), 'milo-crew-home-'))
process.env.MILO_HOME = isolatedMiloHome

const { DEFAULT_SYSTEM_PROMPT } = await import('../src/core/agent/system.js')
const { CrewStore } = await import('../src/core/crew.js')
const { parseCrewMentions, resolveMessageMentions } = await import('../src/core/crew-mentions.js')
const { SqliteMemory } = await import('../src/core/memory/sqlite.js')
const { addProject, removeProject } = await import('../src/core/projects.js')
const { ROUTINE_GATEWAY } = await import('../src/core/routines.js')
const { AgentRuntime } = await import('../src/core/runtime.js')
const { FileSessionStore } = await import('../src/core/sessions/file-store.js')
const { MemoryRecapStore } = await import('../src/core/sessions/recap.js')
const { MemorySessionSeen } = await import('../src/core/sessions/seen.js')
const { taskTool } = await import('../src/core/tools/task.js')
const { ToolRegistry } = await import('../src/core/tools/registry.js')
const { DefaultPermissionPolicy } = await import('../src/core/tools/permission.js')
const { itemsFromMessages } = await import('../src/gateways/cli/history-items.js')
const { buildCommandContext, handleCommand } = await import('../src/gateways/commands.js')
const { runTurn } = await import('../src/gateways/runner.js')
const { WebSettings } = await import('../src/gateways/web/settings.js')
const { transcriptOf } = await import('../src/gateways/web/transcript.js')

const dirs: string[] = []

function tempDir(prefix = 'milo-crew-chat-'): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

afterAll(() => {
  rmSync(isolatedMiloHome, { recursive: true, force: true })
})

interface RecordedCall {
  system: string
  messages: ChatRequest['messages']
}

class ScriptedProvider implements Provider {
  readonly id = 'scripted'
  readonly calls: RecordedCall[] = []
  private readonly responder: (request: ChatRequest, callIndex: number) => AsyncGenerator<StreamEvent>

  constructor(
    responder: (request: ChatRequest, callIndex: number) => AsyncGenerator<StreamEvent>,
  ) {
    this.responder = responder
  }

  async *stream(request: ChatRequest): AsyncGenerator<StreamEvent> {
    const index = this.calls.length
    this.calls.push({
      system: request.system ?? '',
      messages: structuredClone(request.messages),
    })
    yield* this.responder(request, index)
  }
}

function makeRuntimeHarness(options: {
  dir: string
  provider: Provider
  registry?: InstanceType<typeof ToolRegistry>
  instructionsText?: string
}) {
  const crew = new CrewStore(path.join(options.dir, 'crew.json'))
  const store = new FileSessionStore({ dir: path.join(options.dir, 'sessions') })
  const memory = new SqliteMemory({ dir: path.join(options.dir, 'memory') })
  const recaps = new MemoryRecapStore()
  const seen = new MemorySessionSeen()
  const createRuntime = (overrideProvider?: Provider) =>
    new AgentRuntime({
      provider: overrideProvider ?? options.provider,
      model: 'mock-model',
      system: DEFAULT_SYSTEM_PROMPT,
      registry: options.registry ?? new ToolRegistry(),
      memory,
      cwd: options.dir,
      crew,
      store,
      recaps,
      seen,
      permissionPolicy: new DefaultPermissionPolicy(),
      instructions: options.instructionsText
        ? () => ({
            kind: 'present' as const,
            file: path.join(options.dir, 'AGENTS.md'),
            text: options.instructionsText!,
          })
        : undefined,
    })
  return { crew, store, memory, createRuntime }
}

async function collectEvents(stream: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of stream) {
    events.push(event)
  }
  return events
}

describe('Crew conversations, mentions, and profiles', () => {
  it('applies permanent instructions to both direct bot Sessions and task missions, while keeping them separate from assignments and honoring folder/tool/permission rules', async () => {
    const dir = tempDir()
    const registry = new ToolRegistry()
    const executedWrites: string[] = []
    const writeSchema = z.object({ path: z.string(), content: z.string() })
    registry.register({
      name: 'write_file',
      description: 'Write a file.',
      schema: writeSchema,
      requiresConfirmation: () => true,
      execute: async (raw) => {
        const args = writeSchema.parse(raw)
        executedWrites.push(args.path)
        return { content: `Wrote ${args.path}` }
      },
    })
    registry.register(taskTool)

    const provider = new ScriptedProvider(async function* (request): AsyncGenerator<StreamEvent> {
      const last = request.messages.at(-1)
      const promptText = last?.content.map((p) => (p.type === 'text' ? p.text : '')).join('') ?? ''
      const system = request.system ?? ''
      if (promptText.includes('Try forbidden write')) {
        yield { type: 'tool-call', id: 'tc-write', name: 'write_file', args: { path: 'secret.txt', content: 'x' } }
        yield { type: 'done', finishReason: 'tool_calls' }
        return
      }
      if (last?.role === 'tool') {
        yield { type: 'text', delta: `Tool response: ${last.content[0]?.type === 'tool-result' ? last.content[0].content : ''}` }
        yield { type: 'done', finishReason: 'stop' }
        return
      }
      if (promptText.includes('Delegate to Comunista')) {
        yield {
          type: 'tool-call',
          id: 'tc-task',
          name: 'task',
          args: { description: 'Analyze housing', prompt: 'Inspect housing policy', botId: comunista.id },
        }
        yield { type: 'done', finishReason: 'tool_calls' }
        return
      }
      if (promptText.includes('Delegate to auto bot')) {
        yield {
          type: 'tool-call',
          id: 'tc-auto',
          name: 'task',
          args: { description: 'Quick check', prompt: 'Check quick fact', name: 'AutoScout' },
        }
        yield { type: 'done', finishReason: 'tool_calls' }
        return
      }
      if (system.includes('Planned economy and housing as a social right')) {
        yield { type: 'text', delta: `Comunista view: ${promptText}` }
      } else {
        yield { type: 'text', delta: `Standard reply: ${promptText}` }
      }
      yield { type: 'done', finishReason: 'stop' }
    })

    const { crew, createRuntime } = makeRuntimeHarness({
      dir,
      provider,
      registry,
      instructionsText: 'FOLDER_RULE: Always prefer workspace-safe actions.',
    })

    const comunista = await crew.create({
      name: 'Comunista',
      handle: 'comunista',
      instructions: 'Planned economy and housing as a social right.',
    })
    const capitalista = await crew.create({
      name: 'Capitalista',
      handle: 'capitalista',
      instructions: 'Free markets, voluntary exchange, and price signals.',
    })
    expect(capitalista.assignments).toEqual([])

    const runtime1 = createRuntime()
    const webScope = { gateway: 'web', chatId: 'direct-1' }
    const directSession = await runtime1.newSession(webScope, undefined, { botId: comunista.id })
    expect(directSession.bot).toMatchObject({ id: comunista.id, name: 'Comunista', handle: 'comunista' })

    // Turn 1 in direct chat
    await collectEvents(directSession.send('What about rent control?'))

    // Shared list shows the direct Session without polluting assignments.
    const summariesAfterTurn1 = await runtime1.listSessions()
    expect(summariesAfterTurn1.find((s) => s.id === directSession.id)).toMatchObject({
      botId: comunista.id,
      bot: { id: comunista.id, name: 'Comunista', handle: 'comunista' },
      label: 'What about rent control?',
    })

    // Turn 2 in direct chat checks conversation continuity AND folder rule enforcement
    await collectEvents(directSession.send('Expand on public housing.'))

    // Direct chat did NOT touch CrewBot.assignments!
    expect(crew.get(comunista.id)?.assignments).toEqual([])

    // Tool limits / permissions still apply inside a bot conversation (denied write stops execution).
    await collectEvents(
      directSession.send('Try forbidden write', {
        ask: async () => ({ allowed: false }),
      }),
    )
    expect(executedWrites).toEqual([])

    // System prompt for direct bot includes folder rules + bot instructions + role boundary.
    expect(provider.calls[0]?.system).toContain('FOLDER_RULE: Always prefer workspace-safe actions.')
    expect(provider.calls[0]?.system).toContain('Planned economy and housing as a social right.')

    // Rename bot, reload runtime from disk, and resume the same Session by id.
    await crew.updateProfile(comunista.id, { name: 'Comunista Historico' })
    const runtime2 = createRuntime()
    const resumed = await runtime2.resumeSession({ gateway: 'cli', chatId: 'main' }, directSession.id)
    expect(resumed).not.toBeNull()
    expect(resumed!.bot).toMatchObject({ id: comunista.id, name: 'Comunista Historico', handle: 'comunista' })
    expect(resumed!.messages.filter((m) => m.role === 'assistant')[0]?.bot?.id).toBe(comunista.id)

    await collectEvents(resumed!.send('Follow up after rename.'))
    // Latest messages passed to provider carry turns 1 + 2 + 3 of this direct session.
    const lastUserTexts = provider.calls.at(-1)!.messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content.map((p) => (p.type === 'text' ? p.text : '')).join(''))
    expect(lastUserTexts).toContain('What about rent control?')
    expect(lastUserTexts).toContain('Expand on public housing.')
    expect(lastUserTexts).toContain('Follow up after rename.')

    // Task delegation applies bot instructions to `comunista`, and auto-created bots still work without instructions.
    const normalSession = await runtime2.newSession({ gateway: 'web', chatId: 'task-test' })
    await collectEvents(normalSession.send(`Delegate to Comunista ${comunista.id}`))
    const comunistaTaskCall = provider.calls.find((c) =>
      c.messages.some((m) => m.content.some((p) => p.type === 'text' && p.text.includes('Inspect housing policy'))),
    )
    expect(comunistaTaskCall?.system).toContain('Planned economy and housing as a social right.')
    expect(comunistaTaskCall?.system).toContain('FOLDER_RULE: Always prefer workspace-safe actions.')
    expect(crew.get(comunista.id)?.assignments).toHaveLength(1)

    await collectEvents(normalSession.send('Delegate to auto bot'))
    expect(crew.list().find((b) => b.name === 'AutoScout')).toBeUndefined()
    const autoBot = crew.list({ includeArchived: true }).find((b) => b.name === 'AutoScout')
    expect(autoBot).toBeDefined()
    expect(autoBot?.ephemeral).toBe(true)
    expect(autoBot?.archivedAt).toBeTypeOf('number')
    expect(autoBot?.assignments).toHaveLength(1)

    // /crew hides archived one-off bots from the active list, /crew archived lists them, /crew <id> shows reports, and /crew keep promotes them.
    const cmdCtx = buildCommandContext({
      runtime: runtime2,
      session: normalSession,
      scope: normalSession.scope,
    })
    const activeList = await handleCommand('/crew', cmdCtx)
    expect(activeList.reply).not.toContain('AutoScout')
    expect(activeList.reply).toContain('Archived task bots: 1 (/crew archived)')

    const archivedList = await handleCommand('/crew archived', cmdCtx)
    expect(archivedList.reply).toContain('AutoScout')

    const inspectArchived = await handleCommand(`/crew ${autoBot!.id}`, cmdCtx)
    expect(inspectArchived.reply).toContain('AutoScout')
    expect(inspectArchived.reply).toContain('archived')

    const kept = await handleCommand(`/crew keep ${autoBot!.id}`, cmdCtx)
    expect(kept.reply).toContain('Kept bot AutoScout')
    expect(crew.list().find((b) => b.id === autoBot!.id)).toBeDefined()
  })

  it('routes dual mentions with isolated Turn 1 context, preserves authorship across reopen, supports Turn 2 reply, and isolates single-bot failures', async () => {
    const dir = tempDir()
    let failCapitalista = false
    const provider = new ScriptedProvider(async function* (request): AsyncGenerator<StreamEvent> {
      const system = request.system ?? ''
      if (system.includes('Capitalista')) {
        if (failCapitalista) {
          throw new Error('Capitalista upstream rate limit')
        }
        yield { type: 'text', delta: 'Rent caps reduce housing supply and discourage new construction.' }
        yield { type: 'done', finishReason: 'stop' }
        return
      }
      if (system.includes('Comunista')) {
        const sawCapitalistaPrior = request.messages.some((m) =>
          m.content.some((p) => p.type === 'text' && p.text.includes('Capitalista')),
        )
        yield {
          type: 'text',
          delta: sawCapitalistaPrior
            ? 'Reply to Capitalista: housing is a basic necessity, so public supply plus rent caps protect workers.'
            : 'Rent caps prevent speculation and keep housing accessible for families.',
        }
        yield { type: 'done', finishReason: 'stop' }
        return
      }
      yield { type: 'text', delta: 'Milo default reply.' }
      yield { type: 'done', finishReason: 'stop' }
    })

    const { crew, createRuntime } = makeRuntimeHarness({ dir, provider })
    const comunista = await crew.create({
      name: 'Comunista',
      handle: 'comunista',
      instructions: 'Defend housing as a social right.',
      avatar: { shape: 'orb', eyes: 'spark', accessory: 'crown', palette: 'berry' },
    })
    const capitalista = await crew.create({
      name: 'Capitalista',
      handle: 'capitalista',
      instructions: 'Defend market rents and supply incentives.',
      avatar: { shape: 'gem', eyes: 'happy', accessory: 'glasses', palette: 'ocean' },
    })

    const runtime1 = createRuntime()
    const session = await runtime1.newSession({ gateway: 'cli', chatId: 'debate' })

    // 1. Unknown explicit mention reports missing handle without running any bot.
    const unknownEvents = await collectEvents(
      session.send('@comunista @naoexiste Qual sua opiniao?'),
    )
    expect(unknownEvents).toEqual([
      {
        type: 'error',
        message: expect.stringContaining('@naoexiste'),
      },
    ])
    expect(provider.calls).toHaveLength(0)

    // 2. Dual mention + duplicate handle (@comunista repeated) runs each bot once with identical initial context.
    const turn1Events = await collectEvents(
      session.send('@comunista @capitalista @comunista O que vocês acham do controle de aluguéis?'),
    )
    const botStarts = turn1Events.filter((e) => e.type === 'bot-start')
    const botEnds = turn1Events.filter((e) => e.type === 'bot-end')
    expect(botStarts).toHaveLength(2)
    expect(botEnds).toEqual([
      { type: 'bot-end', bot: expect.objectContaining({ id: comunista.id, name: 'Comunista', handle: 'comunista' }), status: 'done' },
      { type: 'bot-end', bot: expect.objectContaining({ id: capitalista.id, name: 'Capitalista', handle: 'capitalista' }), status: 'done' },
    ])

    // Crucial: Capitalista (call 1) did NOT receive Comunista's Turn 1 reply!
    expect(provider.calls).toHaveLength(2)
    expect(provider.calls[0]?.messages.filter((m) => m.role === 'assistant')).toEqual([])
    expect(provider.calls[1]?.messages.filter((m) => m.role === 'assistant')).toEqual([])

    // 3. Reopen the Session from disk and verify authorship persists across Core, Web, and CLI projections.
    const runtime2 = createRuntime()
    const reopened = await runtime2.resumeSession({ gateway: 'web', chatId: 'debate' }, session.id)
    expect(reopened).not.toBeNull()
    const assistantTurn1 = reopened!.messages.filter((m) => m.role === 'assistant')
    expect(assistantTurn1).toHaveLength(2)
    expect(assistantTurn1[0]?.bot).toMatchObject({ id: comunista.id, name: 'Comunista', handle: 'comunista', avatar: comunista.avatar })
    expect(assistantTurn1[1]?.bot).toMatchObject({ id: capitalista.id, name: 'Capitalista', handle: 'capitalista', avatar: capitalista.avatar })

    const webTranscript = transcriptOf(reopened!.messages, (f) => ({ id: f.path, name: f.name, mimeType: f.mimeType, size: 1, image: false }))
    expect(webTranscript.filter((m) => m.role === 'assistant').map((m) => m.bot?.id)).toEqual([comunista.id, capitalista.id])

    const cliItems = itemsFromMessages(reopened!.messages)
    expect(cliItems.filter((item) => item.kind === 'bot').map((item) => item.kind === 'bot' ? item.bot.id : null)).toEqual([comunista.id, capitalista.id])

    // 4. Turn 2 follow-up ("réplica") sees both prior attributed answers!
    await collectEvents(reopened!.send('@comunista Responda ao argumento de Capitalista.'))
    const turn2Call = provider.calls[2]!
    const turn2AssistantTexts = turn2Call.messages
      .filter((m) => m.role === 'assistant')
      .map((m) => m.content.map((p) => (p.type === 'text' ? p.text : '')).join(''))
    expect(turn2AssistantTexts[0]).toContain('[Crew bot Comunista (@comunista)]')
    expect(turn2AssistantTexts[1]).toContain('[Crew bot Capitalista (@capitalista)]')
    expect(turn2AssistantTexts[1]).toContain('discourage new construction')

    const turn2Latest = reopened!.messages.at(-1)
    expect(turn2Latest?.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('Reply to Capitalista:'),
    })

    // 5. Single-bot failure keeps the healthy bot's reply and saves the failing bot's error with authorship.
    failCapitalista = true
    const turn3Events = await collectEvents(reopened!.send('@comunista @capitalista Resumam em uma frase.'))
    expect(turn3Events.filter((e) => e.type === 'bot-end')).toEqual([
      { type: 'bot-end', bot: expect.objectContaining({ id: comunista.id }), status: 'done' },
      { type: 'bot-end', bot: expect.objectContaining({ id: capitalista.id }), status: 'error', error: 'Capitalista upstream rate limit' },
    ])

    const runtime3 = createRuntime()
    const afterFailure = await runtime3.resumeSession({ gateway: 'web', chatId: 'debate' }, session.id)
    const lastTwo = afterFailure!.messages.slice(-2)
    expect(lastTwo[0]?.bot?.id).toBe(comunista.id)
    expect(lastTwo[0]?.error).toBeUndefined()
    expect(lastTwo[1]?.bot?.id).toBe(capitalista.id)
    expect(lastTwo[1]?.error).toBe('Capitalista upstream rate limit')

    const failureWebTranscript = transcriptOf(afterFailure!.messages, (f) => ({ id: f.path, name: f.name, mimeType: f.mimeType, size: 1, image: false }))
    expect(failureWebTranscript.at(-1)).toMatchObject({
      bot: expect.objectContaining({ id: capitalista.id }),
      error: 'Capitalista upstream rate limit',
    })
    const failureCliItems = itemsFromMessages(afterFailure!.messages)
    expect(failureCliItems.slice(-2)).toEqual([
      { kind: 'bot', bot: expect.objectContaining({ id: capitalista.id }) },
      { kind: 'error', text: 'Capitalista upstream rate limit' },
    ])

    // Neither bot ran self-initiated debate rounds or mutated CrewBot.assignments.
    expect(crew.get(comunista.id)?.assignments).toEqual([])
    expect(crew.get(capitalista.id)?.assignments).toEqual([])
  })

  it('preserves native Telegram/Discord mentions, code spans, emails, file paths, and Crew exclusion rules', async () => {
    const dir = tempDir()
    const provider = new ScriptedProvider(async function* (request): AsyncGenerator<StreamEvent> {
      const system = request.system ?? ''
      yield { type: 'text', delta: `Handled by ${system.includes('Comunista') ? 'Comunista' : 'Milo'}` }
      yield { type: 'done', finishReason: 'stop' }
    })
    const { crew, createRuntime } = makeRuntimeHarness({ dir, provider })
    await crew.create({ name: 'Comunista', handle: 'comunista' })

    const parsed = parseCrewMentions(
      'Ask @milo_bot and @everyone and <@12345> plus `@comunista` in code, email a@comunista.org and @src/app.ts, then @comunista.',
      crew,
      { ignoreHandles: ['milo_bot', 'everyone', 'here'] },
    )
    expect(parsed.bots.map((b) => b.handle)).toEqual(['comunista'])
    expect(parsed.unknown).toEqual([])

    const runtime = createRuntime()
    // Shared multi-user room disables Crew routing (sessionsAllowed: false).
    const roomSession = await runtime.newSession({ gateway: 'discord', chatId: 'guild-room' })
    const roomEvents = await collectEvents(
      roomSession.send('@comunista @everyone Hello', {
        sessionsAllowed: false,
        ignoreMentions: ['everyone', 'here', 'milo'],
      }),
    )
    expect(roomEvents.some((e) => e.type === 'bot-start')).toBe(false)
    expect(roomSession.messages.at(-1)?.bot).toBeUndefined()

    // Routine runs disable Crew routing too.
    const routineSession = await runtime.newSession({ gateway: ROUTINE_GATEWAY, chatId: 'cron-1' })
    const routineEvents = await collectEvents(routineSession.send('@comunista Check status'))
    expect(routineEvents.some((e) => e.type === 'bot-start')).toBe(false)
  })

  it('supports Crew profile creation, editing, direct chat switching, and multi-bot streaming across gateway commands, runner, and WebSettings', async () => {
    const dir = tempDir()
    let failSecond = false
    const provider = new ScriptedProvider(async function* (request): AsyncGenerator<StreamEvent> {
      const system = request.system ?? ''
      if (system.includes('Capitalista')) {
        if (failSecond) throw new Error('Capitalista timed out')
        yield { type: 'text', delta: 'Capitalist summary.' }
      } else {
        yield { type: 'text', delta: 'Communist summary.' }
      }
      yield { type: 'done', finishReason: 'stop' }
    })
    const { crew, createRuntime } = makeRuntimeHarness({ dir, provider })
    const runtime = createRuntime()
    const scope = { gateway: 'telegram', chatId: '42' }
    let session = await runtime.newSession(scope)

    // Gateway /crew commands
    const ctx = buildCommandContext({ runtime, scope, session })
    const createdCmd = await handleCommand('/crew create Comunista', ctx)
    expect(createdCmd.reply).toContain('Created bot Comunista (@comunista')
    expect(createdCmd.actions?.[0]?.[0]?.id).toMatch(/^crew-chat:/)

    const createdId = crew.list()[0]!.id
    expect((await handleCommand(`/crew instructions ${createdId} Think structurally.`, ctx)).reply).toContain('Updated instructions')
    expect((await handleCommand(`/crew handle ${createdId} comunista`, ctx)).reply).toContain('@comunista')

    // Start direct chat via /crew chat
    const chatCmd = await handleCommand('/crew chat @comunista', ctx)
    expect(chatCmd.reply).toContain('Started a direct chat session with Comunista')
    session = await runtime.getSession(scope)
    expect(session.botId).toBe(createdId)

    // Create second bot via WebSettings API & start a normal Web session for dual mention via shared runner
    const crewChanged = vi.fn()
    const sessionsChanged = vi.fn()
    const webSettings = new WebSettings(runtime, dir, { crewChanged, sessionsChanged })
    const cap = (await webSettings.handle('crew-create', {
      name: 'Capitalista',
      handle: 'capitalista',
      instructions: 'Market perspective.',
      avatar: { shape: 'gem', eyes: 'visor', accessory: 'crown', palette: 'lime' },
    })) as { id: string; avatar?: { shape: string; eyes: string; accessory: string; palette: string } }
    expect(cap.avatar).toEqual({ shape: 'gem', eyes: 'visor', accessory: 'crown', palette: 'lime' })
    expect(crewChanged).toHaveBeenCalledTimes(1)

    await webSettings.handle('crew-update', { id: cap.id, name: 'Capitalista Pro' })
    expect(sessionsChanged).toHaveBeenCalled()

    const debateSession = await runtime.newSession({ gateway: 'telegram', chatId: 'debate-chat' })
    const posted: Array<{ id: string; text: string }> = []
    let seq = 0
    const surface: ChatSurface = {
      post: async (_chatId, text) => {
        seq += 1
        const id = `msg-${seq}`
        posted.push({ id, text })
        return id
      },
      edit: async (_chatId, messageId, text) => {
        const entry = posted.find((item) => item.id === messageId)
        if (entry) entry.text = text
      },
      ask: async () => ({ allowed: true }),
      files: async () => undefined,
      typing: () => () => undefined,
    }

    failSecond = true
    await runTurn({
      session: debateSession,
      chatId: 'debate-chat',
      text: '@comunista @capitalista What do you think?',
      surface,
      maxLength: 4000,
      flushMs: 0,
      ignoreMentions: ['milo_bot'],
    })

    // Posted TWO separate identified chat messages: Comunista's answer and Capitalista Pro's error.
    expect(posted).toHaveLength(2)
    expect(posted[0]?.text).toContain('**Comunista** (@comunista)')
    expect(posted[0]?.text).toContain('Communist summary.')
    expect(posted[1]?.text).toContain('**Capitalista Pro** (@capitalista)')
    expect(posted[1]?.text).toContain('Capitalista timed out')
  })

  it('ignores multi-word folder mentions like @Personal Notes without rejecting them or mistaking them for a @personal bot', async () => {
    const dir = tempDir()
    const crew = new CrewStore(path.join(dir, 'crew.json'))
    const notesFolder = path.join(dir, 'Personal Notes')
    const projects = [
      { id: 'personal-notes-1', name: 'Personal Notes', path: notesFolder, createdAt: 1 },
      { id: 'milo-1', name: 'Milo', path: dir, createdAt: 2 },
    ]

    // 1. Without any @personal bot: @Personal Notes must not fail as unknown @personal.
    expect(parseCrewMentions('Summarize @Personal Notes', crew, { projects })).toEqual({
      bots: [],
      unknown: [],
      hasExplicitMentions: false,
    })
    expect(parseCrewMentions('What is inside @Personal Notes?', crew, { projects })).toEqual({
      bots: [],
      unknown: [],
      hasExplicitMentions: false,
    })

    // 2. Even when a @personal bot exists, @Personal Notes belongs to the folder, not @personal.
    const personalBot = await crew.create({ name: 'Personal Assistant', handle: 'personal' })
    const capitalistaBot = await crew.create({ name: 'Capitalista', handle: 'capitalista' })

    expect(parseCrewMentions('Summarize @Personal Notes for me', crew, { projects })).toEqual({
      bots: [],
      unknown: [],
      hasExplicitMentions: false,
    })

    // 3. Explicit @personal or another bot alongside @Personal Notes still routes properly.
    const mixed = parseCrewMentions('@personal check @Personal Notes with @capitalista', crew, { projects })
    expect(mixed.bots.map((b) => b.id)).toEqual([personalBot.id, capitalistaBot.id])
    expect(mixed.unknown).toEqual([])
    expect(mixed.hasExplicitMentions).toBe(true)

    // 4. Single-word folder @Milo still skips when no @milo bot exists.
    expect(parseCrewMentions('Inspect @Milo repo', crew, { projects })).toEqual({
      bots: [],
      unknown: [],
      hasExplicitMentions: false,
    })
  })

  it('gives each @mention a single target and preserves explicit folder vs bot picks when a folder Scout and bot @scout collide', async () => {
    const dir = tempDir()
    const scoutFolder = path.join(dir, 'Scout')
    mkdirSync(scoutFolder, { recursive: true })
    const added = await addProject({ path: scoutFolder, name: 'Scout' })
    if (!added.ok) throw new Error('failed to add Scout project')
    const scoutProject = added.project

    try {
      const provider = new ScriptedProvider(async function* (request): AsyncGenerator<StreamEvent> {
        const system = request.system ?? ''
        const role = system.includes('ScoutBotInstructions') ? 'bot' : 'milo'
        const hasScoutFolder = system.includes(scoutFolder)
        yield { type: 'text', delta: `role=${role};folder=${hasScoutFolder}` }
        yield { type: 'done', finishReason: 'stop' }
      })
      const { crew, createRuntime } = makeRuntimeHarness({ dir, provider })
      const scoutBot = await crew.create({
        name: 'Scout',
        handle: 'scout',
        instructions: 'ScoutBotInstructions',
      })

      // 1. Explicit folder pick keeps @Scout purely as folder without calling @scout bot.
      expect(
        resolveMessageMentions('@Scout summarize', crew, {
          projects: [scoutProject],
          explicitMentions: [{ kind: 'folder', id: scoutProject.id, start: 0, end: 6 }],
        }),
      ).toMatchObject({
        bots: [],
        unknown: [],
        folders: [scoutProject],
      })

      // 2. Explicit bot pick keeps @scout purely as bot without binding Scout folder.
      expect(
        resolveMessageMentions('@scout summarize', crew, {
          projects: [scoutProject],
          explicitMentions: [{ kind: 'bot', id: scoutBot.id, start: 0, end: 6 }],
        }),
      ).toMatchObject({
        bots: [scoutBot],
        unknown: [],
        folders: [],
      })

      // 3. Picking both @scout (bot) and @Scout (folder) in the same message keeps each one distinct.
      expect(
        resolveMessageMentions('@scout look at @Scout', crew, {
          projects: [scoutProject],
          explicitMentions: [
            { kind: 'bot', id: scoutBot.id, start: 0, end: 6 },
            { kind: 'folder', id: scoutProject.id, start: 15, end: 21 },
          ],
        }),
      ).toMatchObject({
        bots: [scoutBot],
        unknown: [],
        folders: [scoutProject],
      })

      // 4. Manual unannotated @Scout in a normal Session has a single target (bot wins, folder does not trigger too).
      expect(resolveMessageMentions('@Scout summarize', crew, { projects: [scoutProject] })).toMatchObject({
        bots: [scoutBot],
        unknown: [],
        folders: [],
      })

      // 5. End-to-end Session.send honoring explicit folder pick vs explicit bot pick.
      const runtime = createRuntime()
      const session = await runtime.newSession({ gateway: 'web', chatId: 'collision' })

      const folderTurnEvents = await collectEvents(
        session.send('@Scout inspect directory', {
          mentions: [{ kind: 'folder', id: scoutProject.id, start: 0, end: 6 }],
        }),
      )
      expect(folderTurnEvents.some((e) => e.type === 'bot-start')).toBe(false)
      expect(provider.calls.at(-1)?.system).not.toContain('ScoutBotInstructions')
      expect(provider.calls.at(-1)?.system).toContain(scoutFolder)

      const botTurnEvents = await collectEvents(
        session.send('@scout give your view', {
          mentions: [{ kind: 'bot', id: scoutBot.id, start: 0, end: 6 }],
        }),
      )
      expect(botTurnEvents.filter((e) => e.type === 'bot-start')).toHaveLength(1)
      expect(provider.calls.at(-1)?.system).toContain('ScoutBotInstructions')
      expect(provider.calls.at(-1)?.system).not.toContain(scoutFolder)

      // 6. Inline/fenced code spans before `@Scout` must preserve character offsets so explicit picks still resolve.
      const withInlineCode = 'Leia `README` com @Scout'
      const inlineAt = withInlineCode.indexOf('@Scout')
      expect(
        resolveMessageMentions(withInlineCode, crew, {
          projects: [scoutProject],
          explicitMentions: [{ kind: 'folder', id: scoutProject.id, start: inlineAt, end: inlineAt + 6 }],
        }),
      ).toMatchObject({
        bots: [],
        unknown: [],
        folders: [scoutProject],
      })

      const codeTurnEvents = await collectEvents(
        session.send(withInlineCode, {
          mentions: [{ kind: 'folder', id: scoutProject.id, start: inlineAt, end: inlineAt + 6 }],
        }),
      )
      expect(codeTurnEvents.some((e) => e.type === 'bot-start')).toBe(false)
      expect(provider.calls.at(-1)?.system).not.toContain('ScoutBotInstructions')
      expect(provider.calls.at(-1)?.system).toContain(scoutFolder)

      const withFencedCode = '```\n@fakebot\n```\nCheck @Scout now'
      const fencedAt = withFencedCode.indexOf('@Scout')
      expect(
        resolveMessageMentions(withFencedCode, crew, {
          projects: [scoutProject],
          explicitMentions: [{ kind: 'folder', id: scoutProject.id, start: fencedAt, end: fencedAt + 6 }],
        }),
      ).toMatchObject({
        bots: [],
        unknown: [],
        folders: [scoutProject],
      })
    } finally {
      await removeProject(scoutProject.id)
    }
  })
})
