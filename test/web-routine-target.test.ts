import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import type { MemoryScope } from '../src/core/memory/types.js'
import type { ChatRequest, Provider, StreamEvent } from '../src/core/providers/types.js'
import { ToolRegistry } from '../src/core/tools/registry.js'
import type { Tool } from '../src/core/tools/types.js'
import type { ServerFrame } from '../src/gateways/web/protocol.js'

const home = mkdtempSync(path.join(os.tmpdir(), 'milo-web-routine-target-'))
process.env.MILO_HOME = home

const { WebHub } = await import('../src/gateways/web/hub.js')
const { AgentRuntime } = await import('../src/core/runtime.js')

const CONVERSATION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

/** Emits one `probe` call and then the answer, so the turn has a tool to look through. */
class ProbeProvider implements Provider {
  readonly id = 'probe'
  private calls = 0

  async *stream(_request: ChatRequest): AsyncGenerator<StreamEvent> {
    this.calls += 1
    if (this.calls === 1) {
      yield { type: 'tool-call', id: 'c1', name: 'probe', args: {} }
      yield { type: 'done', finishReason: 'tool_calls' }
      return
    }
    yield { type: 'text', delta: 'made' }
    yield { type: 'done', finishReason: 'stop' }
  }
}

/** The addresses the turn handed the tool. */
const seen: Array<MemoryScope | undefined> = []

const probeSchema = z.object({})
const probe: Tool<z.infer<typeof probeSchema>> = {
  name: 'probe',
  description: 'Records the address of the turn it runs in.',
  schema: probeSchema,
  async execute(_args, ctx) {
    seen.push(ctx.origin)
    return { content: 'seen' }
  },
}

function build(): InstanceType<typeof AgentRuntime> {
  return new AgentRuntime({
    provider: new ProbeProvider(),
    model: 'test-model',
    system: '',
    registry: new ToolRegistry([probe]),
    memory: {
      remember: async () => undefined,
      recall: async () => [],
      list: async () => [],
      forget: async () => false,
    } as never,
    cwd: home,
  })
}

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
})

describe('a routine asked for from the routines screen', () => {
  /**
   * The whole path the screen uses: the destination it picked rides the frame, so
   * the tool sees "the chat this request came from" as the chat that was chosen,
   * not the web conversation the turn happens to be running in. Without it a
   * routine named for Telegram would be quietly made for the browser chat.
   */
  it('pins the destination that rode the frame onto the turn', async () => {
    seen.length = 0
    const hub = new WebHub(build(), { provider: 'test', model: 'test-model' })
    const frames: ServerFrame[] = []
    const client = { send: (frame: ServerFrame) => frames.push(frame) }

    await hub.connect(client, CONVERSATION)
    hub.handle(
      client,
      { type: 'send', text: 'every day at 8, tell me what moved', target: { gateway: 'telegram', conversationId: '123' } },
      CONVERSATION,
    )
    await vi.waitFor(() => expect(frames.some((frame) => frame.type === 'turn-end')).toBe(true))

    expect(seen).toEqual([{ gateway: 'telegram', conversationId: '123' }])
    hub.close()
  })

  it('stays in the chat the turn came from when the screen named none', async () => {
    seen.length = 0
    const hub = new WebHub(build(), { provider: 'test', model: 'test-model' })
    const frames: ServerFrame[] = []
    const client = { send: (frame: ServerFrame) => frames.push(frame) }

    await hub.connect(client, CONVERSATION)
    hub.handle(client, { type: 'send', text: 'every day at 8, tell me what moved' }, CONVERSATION)
    await vi.waitFor(() => expect(frames.some((frame) => frame.type === 'turn-end')).toBe(true))

    expect(seen).toEqual([{ gateway: 'web', conversationId: CONVERSATION }])
    hub.close()
  })
})
