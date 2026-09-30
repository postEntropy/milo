import { describe, expect, it } from 'vitest'
import type { DisplayConfig } from '../src/core/config/schema.js'
import type { ReasoningEffort } from '../src/core/providers/types.js'
import { DefaultPermissionPolicy } from '../src/core/tools/permission.js'
import {
  compactReply,
  decodePermission,
  displayLockMessage,
  effortLockMessage,
  encodePermission,
  handleCommand,
  handleTurnControl,
  memoryLockMessage,
  modeLockMessage,
  parseTurnControl,
  sessionLockMessage,
  turnOf,
  type TurnControlTarget,
} from '../src/gateways/commands.js'
import { PendingDecisions } from '../src/gateways/pending.js'
import { TurnQueue } from '../src/gateways/turns.js'
import type { MemoryItem } from '../src/core/memory/index.js'

describe('/memory', () => {
  const notes: MemoryItem[] = [
    {
      id: 'aaaa1111-2222-3333-4444-555566667777',
      text: 'Renato prefere bullet points',
      createdAt: Date.parse('2026-07-15T12:00:00Z'),
    },
    {
      id: 'bbbb2222-3333-4444-5555-666677778888',
      text: 'o deploy sai na sexta',
      createdAt: Date.parse('2026-07-14T12:00:00Z'),
    },
  ]

  it('lists what is kept, with an id short enough to type', async () => {
    const result = await handleCommand('/memory', { memories: async () => notes })

    expect(result.handled).toBe(true)
    expect(result.reply).toContain('Renato prefere bullet points')
    expect(result.reply).toContain('aaaa1111')
    expect(result.reply).not.toContain('aaaa1111-2222')
    // When it was said, so a stale note is tellable from a fresh one. The day
    // itself is left out: which one it lands on depends on the machine's zone.
    expect(result.reply).toMatch(/2026-07-\d{2}/)
  })

  it('says so plainly when nothing was kept', async () => {
    const result = await handleCommand('/memory', { memories: async () => [] })
    expect(result.reply).toContain('Nothing is remembered yet')
  })

  it('drops the note it was given', async () => {
    const forgotten: string[] = []
    const result = await handleCommand('/memory forget aaaa1111', {
      memories: async () => notes,
      forgetMemory: async (id) => {
        forgotten.push(id)
        return true
      },
    })

    expect(forgotten).toEqual(['aaaa1111'])
    expect(result.reply).toContain('Forgotten')
  })

  it('does not pretend a note that matches nothing was dropped', async () => {
    const result = await handleCommand('/memory forget zzzz', {
      memories: async () => notes,
      forgetMemory: async () => false,
    })
    expect(result.reply).toContain('Nothing matches')
  })

  it('asks for an id when the argument is bare', async () => {
    const result = await handleCommand('/memory forget', { memories: async () => notes })
    expect(result.reply).toContain('Usage: /memory forget <id>')
  })

  it('is locked on a bot that answers more than one person', async () => {
    const result = await handleCommand('/memory', {
      memories: async () => notes,
      memoryLocked: memoryLockMessage(['1', '2']),
    })
    expect(result.reply).toContain('locked')
  })

  it('says it is unavailable on a surface that never wired it', async () => {
    const result = await handleCommand('/memory', {})
    expect(result.reply).toBe('Memory is not available on this surface.')
  })
})

describe('the commands that steer the turn itself', () => {
  /**
   * A turn that stays running until `release`, so there is something to steer,
   * queue behind and stop. Returns what it was handed, which is where `steer`
   * puts a message.
   */
  async function stuckTurn(): Promise<{
    turns: TurnQueue
    handed: () => string[]
    release: () => void
  }> {
    const turns = new TurnQueue()
    let inbox: string[] = []
    let release = (): void => undefined
    const until = new Promise<void>((resolve) => {
      release = resolve
    })
    turns.run('chat-1', async (steering) => {
      inbox = steering
      await until
    })
    // The turn is registered on a microtask, so a command arriving in this same
    // tick would otherwise find nothing running.
    await tick(0)
    return { turns, handed: () => [...inbox], release }
  }

  /**
   * `start` as a gateway implements it: the text goes through the same queue a
   * plain message would, which is what makes a command-asked turn countable.
   */
  function starter(turns: TurnQueue): { start: (text: string) => void; started: string[] } {
    const started: string[] = []
    return {
      start: (text) => {
        started.push(text)
        turns.run('chat-1', async () => undefined)
      },
      started,
    }
  }

  it('only claims the four commands it owns', () => {
    expect(parseTurnControl('/mode ask')).toBeNull()
    expect(parseTurnControl('hello')).toBeNull()
    expect(parseTurnControl('/stop')).toEqual({ action: 'stop' })
    expect(parseTurnControl('/queue read b.txt')).toEqual({ action: 'queue', text: 'read b.txt' })
    expect(parseTurnControl('/steer read b.txt')).toEqual({ action: 'steer', text: 'read b.txt' })
  })

  it('hands /steer to the turn running now', async () => {
    const { turns, handed, release } = await stuckTurn()
    const { start, started } = starter(turns)
    const result = handleTurnControl('/steer read b.txt', { turn: turnOf(turns, 'chat-1'), start })

    expect(result.reply).toContain('running now')
    expect(turns.busy('chat-1')).toBe(true)
    // Handed in, not started: a second turn here is the race steering exists to
    // avoid. The text reaches the model at the turn's next step boundary.
    expect(started).toEqual([])
    expect(handed()).toEqual(['read b.txt'])
    release()
  })

  it('runs /steer as its own turn when nothing is running', () => {
    const turns = new TurnQueue()
    const { start, started } = starter(turns)
    const result = handleTurnControl('/steer hello', { turn: turnOf(turns, 'chat-1'), start })

    expect(result.reply).toContain('Nothing was running')
    expect(started).toEqual(['hello'])
  })

  it('queues /queue behind the turn running now', async () => {
    const { turns, release } = await stuckTurn()
    const { start, started } = starter(turns)
    const result = handleTurnControl('/queue read b.txt', { turn: turnOf(turns, 'chat-1'), start })

    expect(result.reply).toContain('Queued behind')
    expect(started).toEqual(['read b.txt'])
    expect(turns.queued('chat-1')).toBe(1)
    release()
  })

  it('says a command without its text is missing its text', () => {
    const turns = new TurnQueue()
    const context = { turn: turnOf(turns, 'chat-1'), start: (): void => undefined }
    expect(handleTurnControl('/steer', context).reply).toContain('Usage: /steer')
    expect(handleTurnControl('/queue', context).reply).toContain('Usage: /queue')
  })

  it('stops the running turn, and says what it dropped with it', async () => {
    const { turns, release } = await stuckTurn()
    // A second turn is waiting behind the one being stopped.
    let ran = false
    turns.run('chat-1', async () => {
      ran = true
    })
    const result = handleTurnControl('/stop', {
      turn: turnOf(turns, 'chat-1'),
      start: (): void => undefined,
    })

    expect(result.reply).toBe('🛑 Stopped — and dropped 1 message that was waiting behind it.')
    // Dropped, not started once the turn it waited for is gone.
    await tick(20)
    expect(ran).toBe(false)
    release()
  })

  it('stops without dropping anything when nothing was waiting', async () => {
    const { turns, release } = await stuckTurn()
    const result = handleTurnControl('/stop', {
      turn: turnOf(turns, 'chat-1'),
      start: (): void => undefined,
    })

    expect(result.reply).toBe('🛑 Stopped.')
    release()
  })

  it('says so when there is nothing running to stop', () => {
    const turns = new TurnQueue()
    const result = handleTurnControl('/stop', {
      turn: turnOf(turns, 'chat-1'),
      start: (): void => undefined,
    })
    expect(result.reply).toBe('Nothing is running to stop.')
  })

  it('reports a compaction', async () => {
    const result = await handleCommand('/compact', {
      compactSession: async () => ({ folded: 3, tokens: 4200, ms: 1500, summarized: true }),
    })
    expect(result.reply).toContain('3 turns')
    expect(result.reply).toContain('~4200 tokens')
    expect(result.reply).toContain('1.5s')
  })

  it('does not claim a compaction that wrote no summary', async () => {
    const result = await handleCommand('/compact', {
      compactSession: async () => ({ folded: 2, tokens: 900, ms: 12, summarized: false }),
    })
    expect(result.reply).toContain('summary call failed')
  })

  it('reports why there was nothing to compact', async () => {
    const result = await handleCommand('/compact', {
      compactSession: async () => ({
        folded: 0,
        tokens: 0,
        ms: 0,
        summarized: false,
        reason: 'nothing is old enough to fold — the last 6 turns stay',
      }),
    })
    expect(result.reply).toContain('Nothing to compact')
    expect(result.reply).toContain('6 turns stay')
  })
})

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('handleCommand', () => {
  it('ignores normal messages', async () => {
    expect((await handleCommand('hello there', {})).handled).toBe(false)
  })

  it('lists the commands', async () => {
    const result = await handleCommand('/help', {})
    expect(result.handled).toBe(true)
    expect(result.reply).toContain('/mode')
    expect(result.reply).toContain('/sessions')
  })

  it('treats /start as help (Telegram suggests it)', async () => {
    expect((await handleCommand('/start', {})).reply).toContain('/mode')
  })

  it('sets the permission mode and writes it down', async () => {
    const policy = new DefaultPermissionPolicy()
    const saved: string[] = []
    const result = await handleCommand('/mode auto', {
      policy,
      persistMode: (mode) => saved.push(mode),
    })

    expect(result.reply).toContain('auto')
    expect(policy.mode).toBe('auto')
    expect(saved).toEqual(['auto'])
  })

  it('reports the current mode for a bad argument', async () => {
    const policy = new DefaultPermissionPolicy({ mode: 'yolo' })
    const result = await handleCommand('/mode nonsense', { policy })
    expect(result.reply).toContain('yolo')
    expect(policy.mode).toBe('yolo')
  })

  it('toggles yolo and writes it down', async () => {
    const policy = new DefaultPermissionPolicy()
    const saved: string[] = []

    await handleCommand('/yolo', { policy, persistMode: (mode) => saved.push(mode) })
    expect(policy.mode).toBe('yolo')

    await handleCommand('/yolo', { policy, persistMode: (mode) => saved.push(mode) })
    expect(policy.mode).toBe('ask')
    expect(saved).toEqual(['yolo', 'ask'])
  })

  it('refuses to change the mode when the surface is locked', async () => {
    const policy = new DefaultPermissionPolicy()
    const saved: string[] = []
    const context = { policy, persistMode: (mode: string) => saved.push(mode), modeLocked: '🔒 locked' }

    expect((await handleCommand('/mode yolo', context)).reply).toBe('🔒 locked')
    expect((await handleCommand('/yolo', context)).reply).toBe('🔒 locked')
    expect(policy.mode).toBe('ask')
    expect(saved).toEqual([])
  })

  it('clears the session', async () => {
    let cleared = false
    const result = await handleCommand('/clear', {
      resetSession: () => {
        cleared = true
      },
    })
    expect(cleared).toBe(true)
    expect(result.reply).toContain('cleared')
  })

  it('starts a new session with an optional title', async () => {
    const titles: (string | undefined)[] = []
    const result = await handleCommand('/new my project', {
      newSession: async (title) => {
        titles.push(title)
        return { id: 'calm-otter-7' }
      },
    })

    expect(titles).toEqual(['my project'])
    expect(result.reply).toContain('calm-otter-7')
  })

  it('lists saved sessions', async () => {
    const session = {
      id: 'calm-otter-7',
      createdAt: 0,
      updatedAt: 0,
      messageCount: 2,
      preview: 'hi',
    }
    const result = await handleCommand('/sessions', { listSessions: async () => [session] })
    expect(result.reply).toContain('calm-otter-7')
  })

  it('offers a Markdown rendering of the session list', async () => {
    const result = await handleCommand('/sessions', {
      listSessions: async () => [
        {
          id: 'calm-otter-7',
          title: 'my project',
          createdAt: 0,
          updatedAt: 0,
          messageCount: 2,
          preview: 'hi',
        },
      ],
    })

    expect(result.markdown).toContain('**calm-otter-7 — my project**')
    // The plain rendering stays free of Markdown for the CLI.
    expect(result.reply).not.toContain('**')
  })

  it('keeps the session list compact by showing only the first bullet of a recap', async () => {
    const session = {
      id: 'calm-otter-7',
      createdAt: 0,
      updatedAt: 0,
      messageCount: 5,
      preview: 'initial prompt',
      recap: [
        '- Discussed setting up a bot deployment pipeline.',
        '- Decided to use docker-compose.',
        '- Paths: /opt/milo/docker-compose.yml.',
        '- Left open: backup script configuration.',
      ].join('\n'),
    }
    const result = await handleCommand('/sessions', { listSessions: async () => [session] })
    expect(result.reply).toContain('Discussed setting up a bot deployment pipeline.')
    expect(result.reply).not.toContain('docker-compose')
    expect(result.reply).not.toContain('backup script configuration')
    expect(result.markdown).toContain('> Discussed setting up a bot deployment pipeline.')
    expect(result.markdown).not.toContain('docker-compose')
  })

  it('paginates the session list with 5 sessions per page', async () => {
    const sessions = Array.from({ length: 12 }, (_, i) => ({
      id: `session-${i + 1}`,
      createdAt: i * 1000,
      updatedAt: i * 1000,
      messageCount: 2,
      preview: `hello ${i + 1}`,
    }))

    const page1 = await handleCommand('/sessions', { listSessions: async () => sessions })
    expect(page1.pagination).toEqual({
      page: 1,
      totalPages: 3,
      totalItems: 12,
      pageSize: 5,
    })
    expect(page1.reply).toContain('session-1')
    expect(page1.reply).toContain('session-5')
    expect(page1.reply).not.toContain('session-6')
    expect(page1.reply).toContain('page 1/3')
    expect(page1.reply).toContain('Next: /sessions 2')

    const page2 = await handleCommand('/sessions 2', { listSessions: async () => sessions })
    expect(page2.pagination?.page).toBe(2)
    expect(page2.reply).toContain('session-6')
    expect(page2.reply).toContain('session-10')
    expect(page2.reply).not.toContain('session-1\n')
    expect(page2.reply).toContain('page 2/3')
    expect(page2.reply).toContain('Next: /sessions 3')

    const page3 = await handleCommand('/sessions 3', { listSessions: async () => sessions })
    expect(page3.pagination?.page).toBe(3)
    expect(page3.reply).toContain('session-11')
    expect(page3.reply).toContain('session-12')
    expect(page3.reply).not.toContain('Next: /sessions')
  })

  it('reports error on invalid page argument for /sessions', async () => {
    const sessions = Array.from({ length: 12 }, (_, i) => ({
      id: `session-${i + 1}`,
      createdAt: i * 1000,
      updatedAt: i * 1000,
      messageCount: 2,
      preview: `hello ${i + 1}`,
    }))

    const invalid = await handleCommand('/sessions abc', { listSessions: async () => sessions })
    expect(invalid.reply).toBe('Invalid page: "abc". Use /sessions 1..3')
  })

  it('resumes a session and reports unknown ids', async () => {
    let used = ''
    const ok = await handleCommand('/resume calm-otter-7', {
      resumeSession: async (id) => {
        used = id
        return true
      },
    })
    expect(used).toBe('calm-otter-7')
    expect(ok.reply).toContain('Switched to session calm-otter-7')

    const missing = await handleCommand('/resume nope-nope-1', {
      resumeSession: async () => false,
    })
    expect(missing.reply).toContain('No session')

    const noArg = await handleCommand('/resume', { resumeSession: async () => true })
    expect(noArg.reply).toContain('Usage: /resume')
  })

  it('forks a session into a new one and handles missing targets', async () => {
    let forkedId: string | undefined
    let forkedOptions: { upToTurn?: number } | undefined
    const ok = await handleCommand('/fork calm-otter-7 2', {
      forkSession: async (id, options) => {
        forkedId = id
        forkedOptions = options
        return { id: 'swift-falcon-3' }
      },
    })
    expect(forkedId).toBe('calm-otter-7')
    expect(forkedOptions?.upToTurn).toBe(2)
    expect(ok.reply).toContain('Branched into new session: swift-falcon-3')

    const failed = await handleCommand('/fork nope-1', {
      forkSession: async () => null,
    })
    expect(failed.reply).toContain('No session "nope-1"')
  })

  it('shows the current session stats', async () => {
    const result = await handleCommand('/stats', {
      sessionStats: () => ({
        id: 'calm-otter-7',
        createdAt: 0,
        updatedAt: 0,
        messages: 4,
        turns: 2,
        tokens: 100,
        systemTokens: 20,
        // The ceiling the compaction is measured against, resolved from the
        // model's window: the count is only worth reading beside it.
        maxInputTokens: 70_000,
        compacted: false,
      }),
    })
    expect(result.reply).toContain('calm-otter-7')
    expect(result.reply).toContain('2 turns')
    expect(result.reply).toContain('~120 of 70000 tokens')
    expect(result.reply).not.toContain('compacted')
  })

  it('lists the skills installed, and where a skill goes when there are none', async () => {
    const listed = await handleCommand('/skills', {
      skills: () => [{ name: 'deploy', description: 'How to deploy' }],
    })
    expect(listed.reply).toContain('deploy — How to deploy')

    // A surface with none still says where one goes: the answer to `/skills` on
    // a fresh install is the instruction, not an empty list.
    const none = await handleCommand('/skills', { skills: () => [] })
    expect(none.reply).toContain('No skills found')
    expect(none.reply).toContain('SKILL.md')
  })

  it('names /skills in help', async () => {
    expect((await handleCommand('/help', {})).reply).toContain('/skills')
  })

  it('locks session commands on a shared or open bot', async () => {
    const context = { sessionLocked: '🔒 locked' }
    expect((await handleCommand('/new', context)).reply).toBe('🔒 locked')
    expect((await handleCommand('/sessions', context)).reply).toBe('🔒 locked')
    expect((await handleCommand('/resume x-y-1', context)).reply).toBe('🔒 locked')
  })

  it('points /setup and /model at the terminal', async () => {
    expect((await handleCommand('/setup', {})).reply).toContain('milo setup')
    expect((await handleCommand('/model', {})).reply).toContain('milo setup')
  })

  it('lists the display commands in help', async () => {
    const reply = (await handleCommand('/help', {})).reply ?? ''
    expect(reply).toContain('/tools full|name|off')
    expect(reply).toContain('/thinking on|off')
  })

  it('sets how much of a tool call to show, and writes it down', async () => {
    const saved: Partial<DisplayConfig>[] = []
    const result = await handleCommand('/tools name', {
      display: { tools: 'full', thinking: 'on' },
      persistDisplay: (patch) => saved.push(patch),
    })

    expect(result.reply).toContain('Tools: name')
    expect(saved).toEqual([{ tools: 'name' }])
  })

  it('says a failure is still reported when tools are off', async () => {
    const result = await handleCommand('/tools off', {
      display: { tools: 'full', thinking: 'on' },
      persistDisplay: () => {},
    })

    expect(result.reply).toContain('still reported')
  })

  it('reports the current level for a bad argument', async () => {
    const saved: Partial<DisplayConfig>[] = []
    const result = await handleCommand('/tools nonsense', {
      display: { tools: 'name', thinking: 'off' },
      persistDisplay: (patch) => saved.push(patch),
    })

    expect(result.reply).toContain('Tools: name')
    expect(result.reply).toContain('/tools full|name|off')
    expect(saved).toEqual([])
  })

  it('shows and hides the reasoning, and reports it when asked for nothing', async () => {
    const saved: Partial<DisplayConfig>[] = []
    const context = {
      display: { tools: 'full' as const, thinking: 'on' as const },
      persistDisplay: (patch: Partial<DisplayConfig>) => saved.push(patch),
    }

    // No argument reports the state — and says what the command controls: the
    // showing of the reasoning, not the reasoning itself.
    const reply = (await handleCommand('/thinking', context)).reply ?? ''
    expect(reply).toContain('Thinking display: on')
    expect(reply).toContain('the model thinks either way')
    expect(saved).toEqual([])

    await handleCommand('/thinking off', context)
    await handleCommand('/thinking on', context)
    // `brief` and `full` are what this command used to take: both showed it.
    await handleCommand('/thinking full', context)

    expect(saved).toEqual([{ thinking: 'off' }, { thinking: 'on' }, { thinking: 'on' }])
  })

  it('takes the reasoning-effort levels, and reports them when asked for nothing', async () => {
    const saved: ReasoningEffort[] = []
    const context = {
      effort: 'low' as const,
      persistEffort: (effort: ReasoningEffort) => saved.push(effort),
    }

    expect((await handleCommand('/effort', context)).reply).toContain('Reasoning effort: low')
    expect(saved).toEqual([])

    // A surface that reports no effort still names Milo's own, which is medium.
    expect(
      (await handleCommand('/effort', { persistEffort: () => {} })).reply,
    ).toContain('Reasoning effort: medium')

    await handleCommand('/effort high', context)
    // `default` and `off` are both ways of saying "back to Milo's value".
    await handleCommand('/effort default', context)
    await handleCommand('/effort off', context)

    expect(saved).toEqual(['high', 'medium', 'medium'])
  })

  it('refuses an effort change on a bot that answers several people', async () => {
    const saved: ReasoningEffort[] = []
    const locked = effortLockMessage(['1', '2'])!
    const context = {
      effort: 'low' as const,
      persistEffort: (effort: ReasoningEffort) => saved.push(effort),
      effortLocked: locked,
    }

    // What an answer costs is not one person's to change for everyone.
    expect((await handleCommand('/effort high', context)).reply).toBe(locked)
    expect(saved).toEqual([])
  })

  it('refuses display changes on a surface without them', async () => {
    expect((await handleCommand('/tools off', {})).reply).toContain('not available')
    expect((await handleCommand('/thinking off', {})).reply).toContain('not available')
  })

  it('refuses them on a bot that answers several people', async () => {
    const saved: Partial<DisplayConfig>[] = []
    const locked = displayLockMessage(['1', '2'])!
    const context = {
      display: { tools: 'full' as const, thinking: 'on' as const },
      persistDisplay: (patch: Partial<DisplayConfig>) => saved.push(patch),
      displayLocked: locked,
    }

    expect((await handleCommand('/tools off', context)).reply).toBe(locked)
    expect((await handleCommand('/thinking off', context)).reply).toBe(locked)
    expect(saved).toEqual([])
  })

  it('leaves them open for a single allowed id, and for the terminal', () => {
    expect(displayLockMessage(['1'])).toBeUndefined()
    expect(displayLockMessage(undefined)).toBeDefined()
    expect(displayLockMessage([])).toContain('answers anyone')
    expect(displayLockMessage(['1', '2'])).toContain('answers 2 ids')
  })

  it('reports display settings in /status', async () => {
    const reply = (await handleCommand('/status', { display: { tools: 'off', thinking: 'off' } }))
      .reply
    expect(reply).toContain('Tools: off')
    expect(reply).toContain('thinking display: off')
    expect(reply).toContain('effort: medium')
  })

  it('rejects unknown commands', async () => {
    expect((await handleCommand('/nope', {})).reply).toContain('Unknown command')
  })
})

describe('modeLockMessage', () => {
  it('leaves a single-person bot alone', () => {
    expect(modeLockMessage(['42'])).toBeUndefined()
  })

  it('locks a bot that answers anyone', () => {
    expect(modeLockMessage([])).toContain('anyone')
    expect(modeLockMessage(undefined)).toContain('anyone')
  })

  it('locks a shared bot and says how many', () => {
    expect(modeLockMessage(['42', '43'])).toContain('2 ids')
  })
})

describe('sessionLockMessage', () => {
  it('leaves a single-person bot alone', () => {
    expect(sessionLockMessage(['42'])).toBeUndefined()
  })

  it('locks a bot that answers anyone', () => {
    expect(sessionLockMessage([])).toContain('anyone')
    expect(sessionLockMessage(undefined)).toContain('anyone')
  })

  it('locks a shared bot and says how many', () => {
    expect(sessionLockMessage(['42', '43'])).toContain('2 ids')
  })
})

describe('permission callback payloads', () => {
  it('round-trips', () => {
    expect(decodePermission(encodePermission('abc', true))).toEqual({ id: 'abc', allowed: true })
    expect(decodePermission(encodePermission('abc', false))).toEqual({ id: 'abc', allowed: false })
  })

  it('rejects malformed data', () => {
    expect(decodePermission('nonsense')).toBeNull()
    expect(decodePermission('perm:abc:maybe')).toBeNull()
    expect(decodePermission('perm::allow')).toBeNull()
  })
})

describe('PendingDecisions', () => {
  it('resolves a waiting decision', async () => {
    const pending = new PendingDecisions()
    const waiting = pending.wait('id1', 1000)
    expect(pending.resolve('id1', true)).toBe(true)
    expect(await waiting).toBe(true)
    expect(pending.size).toBe(0)
  })

  it('returns false for unknown ids', () => {
    const pending = new PendingDecisions()
    expect(pending.resolve('nope', true)).toBe(false)
  })

  it('resolves false on expiry', async () => {
    const pending = new PendingDecisions()
    const waiting = pending.wait('id2', 20)
    expect(await waiting).toBe(false)
    expect(pending.size).toBe(0)
  })

  it('denies the tool when the turn is stopped', async () => {
    const pending = new PendingDecisions()
    const controller = new AbortController()
    const waiting = pending.wait('id3', 60_000, controller.signal)

    controller.abort()

    // Denied rather than left standing: waiting out the five minutes would keep
    // the turn parked with a ✅ still able to allow the tool afterwards.
    expect(await waiting).toBe(false)
    expect(pending.size).toBe(0)
    expect(pending.resolve('id3', true)).toBe(false)
  })

  it('takes the answer that came before the stop', async () => {
    const pending = new PendingDecisions()
    const controller = new AbortController()
    const waiting = pending.wait('id4', 60_000, controller.signal)

    expect(pending.resolve('id4', true)).toBe(true)
    controller.abort()

    expect(await waiting).toBe(true)
  })

  it('denies at once for a turn stopped before it asked', async () => {
    const pending = new PendingDecisions()
    const controller = new AbortController()
    controller.abort()

    expect(await pending.wait('id5', 60_000, controller.signal)).toBe(false)
    expect(pending.size).toBe(0)
  })
})

describe('a surface that steers with its own machinery', () => {
  it('gets the same commands and the same answers as a bot', () => {
    // The CLI's shape: refs instead of a TurnQueue. What is shared is the
    // vocabulary, so the same commands have to answer the same way there.
    let inbox: string[] | null = ['held']
    const target: TurnControlTarget = {
      steer: (text) => {
        if (!inbox) return false
        inbox.push(text)
        return true
      },
      busy: () => inbox !== null,
      queued: () => 0,
      stop: () => {
        const stopped = inbox !== null
        inbox = null
        return { stopped, dropped: 1 }
      },
    }
    const context = { turn: target, start: (): void => undefined }

    expect(handleTurnControl('/steer go', context).reply).toContain('running now')
    expect(inbox).toEqual(['held', 'go'])

    expect(handleTurnControl('/stop', context).reply).toBe(
      '🛑 Stopped — and dropped 1 message that was waiting behind it.',
    )
    expect(inbox).toBeNull()
    expect(handleTurnControl('/stop', context).reply).toBe('Nothing is running to stop.')
  })

  it('says the same thing about a compaction on every surface', () => {
    expect(compactReply({ folded: 3, tokens: 4200, ms: 1500, summarized: true })).toContain(
      '3 turns (~4200 tokens)',
    )
    expect(
      compactReply({ folded: 2, tokens: 900, ms: 12, summarized: false }),
    ).toContain('summary call failed')
    expect(
      compactReply({ folded: 0, tokens: 0, ms: 0, summarized: false, reason: 'nothing old' }),
    ).toContain('Nothing to compact: nothing old.')
  })
})

describe('/export', () => {
  it('answers an argument it does not know, rather than picking a format', async () => {
    const result = await handleCommand('/export xml', {
      sessionStats: async () => ({
        id: 'x',
        createdAt: 0,
        updatedAt: 0,
        messages: 2,
        turns: 1,
        tokens: 0,
        compacted: false,
      }),
    })
    expect(result.handled).toBe(true)
    expect(result.reply).toContain('/export json')
  })

  it('says so on a surface that has nothing to export from', async () => {
    const result = await handleCommand('/export', {})
    expect(result.reply).toContain('cannot export')
  })
})
