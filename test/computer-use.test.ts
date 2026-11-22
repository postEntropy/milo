import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { runAgent } from '../src/core/agent/loop.js'
import { runSubagent } from '../src/core/agent/subagent.js'
import { buildSystemPrompt } from '../src/core/agent/system.js'
import {
  COMPUTER_SETUP_HELP_LABEL,
  ComputerManager,
  ComputerPreviewStore,
  computerSetupHelp,
  computerSetupUnavailableReply,
  CuaDriverAdapter,
  hyprlandPluginLimitation,
  hyprlandPluginSummaryTag,
  OMARCHY_ACTIVATION_GUIDE,
  PREVIEW_MAX_BYTES,
  PREVIEW_MAX_LONG_EDGE,
  probeHyprlandPluginStatus,
  withComputerSetupHelp,
  type ComputerActionOutcome,
  type ComputerCapabilityStatus,
  type ComputerDriverAdapter,
  type DiscoveredApp,
  type DiscoveredWindow,
  type HyprlandPluginState,
  type RawWindowState,
} from '../src/core/computer/index.js'
import { DEFAULT_COMPUTER } from '../src/core/config/schema.js'
import { renderExportMarkdown } from '../src/core/export.js'
import type { HistoryEntry } from '../src/core/history.js'
import { toolImages } from '../src/core/images.js'
import type { ChatRequest, Message, Provider, StreamEvent } from '../src/core/providers/types.js'
import { AgentRuntime } from '../src/core/runtime.js'
import { Session } from '../src/core/session.js'
import { FileSessionStore, MemorySessionStore } from '../src/core/sessions/index.js'
import {
  approvalKey,
  createToolRegistry,
  DefaultPermissionPolicy,
  isPlanTool,
  withDelegatedGrants,
  withPlan,
} from '../src/core/tools/index.js'
import { TracedProvider, type TraceEvent, type TraceWriter } from '../src/core/traces.js'
import { toolApprovalTitle, toolDetail, toolDisplayName } from '../src/gateways/tool-line.js'

const FAKE_PNG_B64 = Buffer.from('fake-png-bytes').toString('base64')

function readyStatus(overrides: Partial<ComputerCapabilityStatus> = {}): ComputerCapabilityStatus {
  return {
    available: true,
    platform: 'linux',
    sdkVersion: '0.56.4',
    displayServer: 'wayland+xwayland',
    waylandEnabled: true,
    atspiAvailable: true,
    screenCaptureAvailable: true,
    inputModes: {
      accessibility: true,
      windowScopedPointer: true,
      xsendEvent: true,
      hyprlandPlugin: false,
    },
    limitations: [],
    summary: 'Ready (SDK 0.56.4 · wayland+xwayland · AT-SPI ready · capture ready)',
    ...overrides,
  }
}

function sampleWindow(overrides: Partial<DiscoveredWindow> = {}): DiscoveredWindow {
  return {
    windowId: '94321041156240',
    pid: 4242,
    appName: 'org.gnome.Calculator',
    title: 'Calculator',
    bounds: { x: 100, y: 100, width: 400, height: 500 },
    isOnScreen: true,
    ...overrides,
  }
}

function makeFakeAdapter(options: {
  status?: ComputerCapabilityStatus
  probe?: ComputerDriverAdapter['probe']
  windows?: () => DiscoveredWindow[]
  listWindows?: () => Promise<DiscoveredWindow[]>
  apps?: () => DiscoveredApp[]
  launchApp?: ComputerDriverAdapter['launchApp']
  getWindowState?: ComputerDriverAdapter['getWindowState']
  clickElement?: ComputerDriverAdapter['clickElement']
  clickCoordinates?: ComputerDriverAdapter['clickCoordinates']
  setElementValue?: ComputerDriverAdapter['setElementValue']
  focusElement?: ComputerDriverAdapter['focusElement']
  typeText?: ComputerDriverAdapter['typeText']
  pressKey?: ComputerDriverAdapter['pressKey']
  scroll?: ComputerDriverAdapter['scroll']
} = {}): ComputerDriverAdapter {
  let snapSeq = 0
  return {
    probe: vi.fn(options.probe ?? (async () => options.status ?? readyStatus())),
    listApps: vi.fn(async () =>
      options.apps ? options.apps() : [{ pid: 4242, name: 'org.gnome.Calculator', running: true, active: true }],
    ),
    listWindows: vi.fn(
      options.listWindows ?? (async () => (options.windows ? options.windows() : [sampleWindow()])),
    ),
    launchApp: vi.fn(
      options.launchApp ?? (async () => ({ ok: true as const, text: 'Launched.' })),
    ),
    getWindowState: vi.fn(
      options.getWindowState ??
        (async (win, opts): Promise<RawWindowState> => {
          snapSeq += 1
          return {
            snapshotId: `s${snapSeq}`,
            pid: win.pid,
            windowId: win.windowId,
            appName: win.appName,
            windowTitle: win.title,
            elements: [
              {
                elementIndex: 0n,
                role: 'button',
                depth: 1,
                elementToken: `tok-btn-${snapSeq}`,
                label: 'Seven',
                enabled: true,
                actions: ['click'],
                frame: { x: 10, y: 20, width: 40, height: 30 },
              },
              {
                elementIndex: 1n,
                role: 'password text',
                depth: 1,
                elementToken: `tok-pw-${snapSeq}`,
                label: 'Password',
                isPassword: true,
                enabled: true,
              },
              {
                elementIndex: 2n,
                role: 'text box',
                depth: 1,
                elementToken: `tok-input-${snapSeq}`,
                label: 'Expression',
                enabled: true,
                actions: ['activate'],
                frame: { x: 10, y: 60, width: 200, height: 30 },
              },
            ],
            observationsText: 'label "SECRET_RAW_A11Y_MARKER_42"',
            degraded: false,
            truncated: false,
            ...(opts.includeScreenshot
              ? {
                  screenshot: {
                    mimeType: 'image/png',
                    data: FAKE_PNG_B64,
                    width: 400,
                    height: 500,
                    frameValid: true,
                  },
                }
              : {}),
          }
        }),
    ),
    clickElement: vi.fn(
      options.clickElement ??
        (async (): Promise<ComputerActionOutcome> => ({
          effect: 'confirmed',
          completion: 'completed',
          route: 'accessibility',
          summary: 'Clicked button "Seven".',
          uncertain: false,
        })),
    ),
    clickCoordinates: vi.fn(
      options.clickCoordinates ??
        (async (): Promise<ComputerActionOutcome> => ({
          effect: 'confirmed',
          completion: 'completed',
          route: 'synthetic_events',
          summary: 'Clicked at window coordinates.',
          uncertain: false,
        })),
    ),
    setElementValue: vi.fn(
      options.setElementValue ??
        (async (): Promise<ComputerActionOutcome> => ({
          effect: 'confirmed',
          completion: 'completed',
          route: 'accessibility',
          summary: 'Set element value via accessibility.',
          uncertain: false,
        })),
    ),
    ...(options.focusElement ? { focusElement: vi.fn(options.focusElement) } : {}),
    typeText: vi.fn(
      options.typeText ??
        (async (): Promise<ComputerActionOutcome> => ({
          effect: 'confirmed',
          completion: 'completed',
          route: 'synthetic_events',
          summary: 'Typed text.',
          uncertain: false,
        })),
    ),
    pressKey: vi.fn(
      options.pressKey ??
        (async (): Promise<ComputerActionOutcome> => ({
          effect: 'confirmed',
          completion: 'completed',
          route: 'synthetic_events',
          summary: 'Pressed key.',
          uncertain: false,
        })),
    ),
    scroll: vi.fn(
      options.scroll ??
        (async (): Promise<ComputerActionOutcome> => ({
          effect: 'confirmed',
          completion: 'completed',
          route: 'synthetic_events',
          summary: 'Scrolled window.',
          uncertain: false,
        })),
    ),
    close: vi.fn(async () => undefined),
  }
}

function scriptedProvider(steps: Array<(req: ChatRequest) => StreamEvent[]>): Provider {
  let index = 0
  return {
    id: 'test',
    async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
      const step = steps[index++]
      if (!step) {
        yield { type: 'text', delta: 'Done.' }
        yield { type: 'done', finishReason: 'stop' }
        return
      }
      for (const event of step(req)) yield event
    },
  }
}

describe('Computer Use capability', () => {
  it('defaults to off and omits computer tools when disabled', () => {
    expect(DEFAULT_COMPUTER.enabled).toBe(false)
    const registry = createToolRegistry()
    const names = registry.specs().map((t) => t.name)
    expect(names).not.toContain('computer_list')
    expect(names).not.toContain('computer_open')
    expect(names).not.toContain('computer_snapshot')
    expect(names).not.toContain('computer_act')
  })

  it('refuses stale element references and stale capture ids after a snapshot or action', async () => {
    const adapter = makeFakeAdapter()
    const manager = new ComputerManager(adapter)

    const opened = await manager.openWindow({
      turnId: 'turn-1',
      expectedWindow: sampleWindow(),
      visionConfirmed: true,
    })
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    const firstRef = opened.observation.snapshot.elementList[0]!.ref
    const firstCaptureId = opened.observation.snapshot.captureId
    expect(firstRef).toBe('c1')

    // Acting on the first ref succeeds and expires c1.
    const acted = await manager.act({
      turnId: 'turn-1',
      input: { action: 'click', ref: firstRef },
      visionConfirmed: true,
    })
    expect(acted.ok).toBe(true)

    // Reusing c1 is now refused as stale.
    const staleAct = await manager.act({
      turnId: 'turn-1',
      input: { action: 'click', ref: firstRef },
      visionConfirmed: true,
    })
    expect(staleAct.ok).toBe(false)
    if (!staleAct.ok) expect(staleAct.error).toContain('stale')

    // Stale captureId for pixel click is also refused.
    const staleCapture = await manager.act({
      turnId: 'turn-1',
      input: { action: 'click', x: 20, y: 20, captureId: firstCaptureId },
      visionConfirmed: true,
    })
    expect(staleCapture.ok).toBe(false)
    if (!staleCapture.ok) expect(staleCapture.error).toContain('stale')

    // Out-of-bounds pixel click is refused (requires current captureId too).
    const missingCapture = await manager.act({
      turnId: 'turn-1',
      input: { action: 'click', x: 20, y: 20 },
      visionConfirmed: true,
    })
    expect(missingCapture.ok).toBe(false)
    if (!missingCapture.ok) expect(missingCapture.error).toContain('capture_id')

    const snapForBounds = await manager.snapshot({ turnId: 'turn-1', visionConfirmed: true })
    expect(snapForBounds.ok).toBe(true)
    if (!snapForBounds.ok) return
    const outOfBounds = await manager.act({
      turnId: 'turn-1',
      input: { action: 'click', x: 999, y: 999, captureId: snapForBounds.observation.snapshot.captureId },
      visionConfirmed: true,
    })
    expect(outOfBounds.ok).toBe(false)
    if (!outOfBounds.ok) expect(outOfBounds.error).toContain('outside')

    // Password element is refused.
    const snap = await manager.snapshot({ turnId: 'turn-1', visionConfirmed: true })
    expect(snap.ok).toBe(true)
    if (!snap.ok) return
    const pwRef = snap.observation.snapshot.elementList.find((e) => e.isPassword)!.ref
    const pwAct = await manager.act({
      turnId: 'turn-1',
      input: { action: 'click', ref: pwRef },
      visionConfirmed: true,
    })
    expect(pwAct.ok).toBe(false)
    if (!pwAct.ok) expect(pwAct.error).toContain('password')
  })

  it('refuses when a window closes or changes while approval is pending', async () => {
    let liveWindows: DiscoveredWindow[] = [sampleWindow({ title: 'Calculator' })]
    const adapter = makeFakeAdapter({ windows: () => liveWindows })
    const manager = new ComputerManager(adapter)
    const registry = createToolRegistry({ computer: manager })

    // Case 1: window changes title while approval is pending.
    const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'open calculator' }] }]
    const provider = scriptedProvider([
      () => [
        { type: 'tool-call', id: 'call-1', name: 'computer_open', args: { windowId: '94321041156240' } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      () => [
        { type: 'text', delta: 'Saw refusal.' },
        { type: 'done', finishReason: 'stop' },
      ],
    ])

    const ask = vi.fn(async () => {
      liveWindows = [sampleWindow({ title: 'Different Window Title' })]
      return { allowed: true }
    })

    const results: string[] = []
    for await (const ev of runAgent({
      provider,
      model: 'test-model',
      tools: registry.specs(),
      registry,
      messages,
      context: {
        cwd: process.cwd(),
        signal: new AbortController().signal,
        turnId: 'turn-change',
        visionConfirmed: true,
        computerAllowed: true,
        computer: manager,
      },
      permission: { policy: new DefaultPermissionPolicy({ mode: 'ask' }), ask },
    })) {
      if (ev.type === 'tool-end') results.push(ev.result)
    }

    expect(ask).toHaveBeenCalledTimes(1)
    expect(results[0]).toContain('changed while approval was pending')
    expect(manager.boundWindow('turn-change')).toBeNull()

    // Case 2: window closes while approval is pending.
    liveWindows = [sampleWindow({ title: 'Calculator' })]
    const closeAsk = vi.fn(async () => {
      liveWindows = []
      return { allowed: true }
    })
    const closeResults: string[] = []
    for await (const ev of runAgent({
      provider: scriptedProvider([
        () => [
          { type: 'tool-call', id: 'call-2', name: 'computer_open', args: { windowId: '94321041156240' } },
          { type: 'done', finishReason: 'tool_calls' },
        ],
        () => [
          { type: 'text', delta: 'Closed.' },
          { type: 'done', finishReason: 'stop' },
        ],
      ]),
      model: 'test-model',
      tools: registry.specs(),
      registry,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'open calculator' }] }],
      context: {
        cwd: process.cwd(),
        signal: new AbortController().signal,
        turnId: 'turn-close',
        visionConfirmed: true,
        computerAllowed: true,
        computer: manager,
      },
      permission: { policy: new DefaultPermissionPolicy({ mode: 'ask' }), ask: closeAsk },
    })) {
      if (ev.type === 'tool-end') closeResults.push(ev.result)
    }

    expect(closeAsk).toHaveBeenCalledTimes(1)
    expect(closeResults[0]).toContain('closed or disappeared while approval was pending')
  })

  it('runs computer_open and computer_act without prompting in Unrestricted mode while still asking in Ask and Auto modes', async () => {
    const adapter = makeFakeAdapter()
    const manager = new ComputerManager(adapter)
    const registry = createToolRegistry({ computer: manager })

    // No "Always" key is ever produced for computer_open or computer_act.
    expect(approvalKey('computer_open', { windowId: '1' }, process.cwd())).toBeNull()
    expect(approvalKey('computer_act', { action: 'click', ref: 'c1' }, process.cwd())).toBeNull()

    const runOpenAndAct = async (
      turnId: string,
      permission: { policy: DefaultPermissionPolicy; ask?: (req: unknown) => Promise<{ allowed: boolean }> },
    ) => {
      const toolEnds: Array<{ name: string; result: string; isError: boolean }> = []
      for await (const ev of runAgent({
        provider: scriptedProvider([
          () => [
            { type: 'tool-call', id: `${turnId}-open`, name: 'computer_open', args: { windowId: '94321041156240' } },
            { type: 'done', finishReason: 'tool_calls' },
          ],
          () => [
            { type: 'tool-call', id: `${turnId}-act`, name: 'computer_act', args: { action: 'click', ref: 'c1' } },
            { type: 'done', finishReason: 'tool_calls' },
          ],
          () => [
            { type: 'text', delta: 'Done.' },
            { type: 'done', finishReason: 'stop' },
          ],
        ]),
        model: 'test-model',
        tools: registry.specs(),
        registry,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'open and click' }] }],
        context: {
          cwd: process.cwd(),
          signal: new AbortController().signal,
          turnId,
          visionConfirmed: true,
          computerAllowed: true,
          computer: manager,
        },
        permission,
      })) {
        if (ev.type === 'tool-end') toolEnds.push({ name: ev.name, result: ev.result, isError: ev.isError })
      }
      manager.releaseTurn(turnId)
      return toolEnds
    }

    // Unrestricted (yolo) mode: both desktop calls run without invoking the approver.
    const yoloAsk = vi.fn(async () => ({ allowed: true }))
    const yoloEnds = await runOpenAndAct('turn-yolo', {
      policy: new DefaultPermissionPolicy({ mode: 'yolo' }),
      ask: yoloAsk,
    })
    expect(yoloAsk).toHaveBeenCalledTimes(0)
    expect(yoloEnds).toHaveLength(2)
    expect(yoloEnds[0]?.isError).toBe(false)
    expect(yoloEnds[1]?.isError).toBe(false)

    // Unrestricted (yolo) mode without an interactive approver fails closed rather than bypassing.
    const yoloNoAskEnds = await runOpenAndAct('turn-yolo-no-ask', {
      policy: new DefaultPermissionPolicy({ mode: 'yolo' }),
    })
    expect(yoloNoAskEnds[0]?.isError).toBe(true)
    expect(yoloNoAskEnds[0]?.result).toContain('requires confirmation')

    // Ask mode: fails closed without an approver, and prompts for both calls when one is present.
    const askNoAskerEnds = await runOpenAndAct('turn-ask-no-asker', {
      policy: new DefaultPermissionPolicy({ mode: 'ask' }),
    })
    expect(askNoAskerEnds[0]?.isError).toBe(true)
    expect(askNoAskerEnds[0]?.result).toContain('requires confirmation')

    const askSpy = vi.fn(async () => ({ allowed: true }))
    const askEnds = await runOpenAndAct('turn-ask', {
      policy: new DefaultPermissionPolicy({ mode: 'ask' }),
      ask: askSpy,
    })
    expect(askSpy).toHaveBeenCalledTimes(2)
    expect(askEnds[0]?.isError).toBe(false)
    expect(askEnds[1]?.isError).toBe(false)

    // Auto mode: still prompts for both calls even when allow-listed and given a permissive reviewer.
    const autoPolicy = new DefaultPermissionPolicy({
      mode: 'auto',
      allow: ['computer_open', 'computer_act'],
      reviewer: { review: async () => 0 },
    })
    const autoNoAskerEnds = await runOpenAndAct('turn-auto-no-asker', { policy: autoPolicy })
    expect(autoNoAskerEnds[0]?.isError).toBe(true)
    expect(autoNoAskerEnds[0]?.result).toContain('requires confirmation')

    const autoSpy = vi.fn(async () => ({ allowed: true }))
    const autoEnds = await runOpenAndAct('turn-auto', { policy: autoPolicy, ask: autoSpy })
    expect(autoSpy).toHaveBeenCalledTimes(2)
    expect(autoEnds[0]?.isError).toBe(false)
    expect(autoEnds[1]?.isError).toBe(false)
  })

  it('excludes computer_* tools and blocks desktop dispatch in headless milo run even in Unrestricted mode', async () => {
    const adapter = makeFakeAdapter()
    const probeSpy = vi.spyOn(adapter, 'probe')
    const listWindowsSpy = vi.spyOn(adapter, 'listWindows')
    const listAppsSpy = vi.spyOn(adapter, 'listApps')
    const launchAppSpy = vi.spyOn(adapter, 'launchApp')
    const getStateSpy = vi.spyOn(adapter, 'getWindowState')
    const clickElSpy = vi.spyOn(adapter, 'clickElement')
    const setValSpy = vi.spyOn(adapter, 'setElementValue')
    const clickCoordsSpy = vi.spyOn(adapter, 'clickCoordinates')
    const typeTextSpy = vi.spyOn(adapter, 'typeText')
    const pressKeySpy = vi.spyOn(adapter, 'pressKey')
    const scrollSpy = vi.spyOn(adapter, 'scroll')

    const manager = new ComputerManager(adapter)
    const registry = createToolRegistry({ computer: manager })
    const seenToolLists: string[][] = []

    const provider = scriptedProvider([
      (req) => {
        seenToolLists.push((req.tools ?? []).map((t) => t.name))
        // Even if the model attempts computer_* tool calls anyway, headless execution must reject them.
        return [
          { type: 'tool-call', id: 'headless-list', name: 'computer_list', args: {} },
          { type: 'tool-call', id: 'headless-open', name: 'computer_open', args: { windowId: '94321041156240' } },
          { type: 'tool-call', id: 'headless-snap', name: 'computer_snapshot', args: {} },
          { type: 'tool-call', id: 'headless-act', name: 'computer_act', args: { action: 'click', ref: 'c1' } },
          { type: 'done', finishReason: 'tool_calls' },
        ]
      },
      (req) => {
        seenToolLists.push((req.tools ?? []).map((t) => t.name))
        return [
          { type: 'text', delta: 'Headless done.' },
          { type: 'done', finishReason: 'stop' },
        ]
      },
    ])

    const runtime = new AgentRuntime({
      provider,
      model: 'test-model',
      system: 'Base',
      registry,
      computer: manager,
      store: new MemorySessionStore(),
      // Same permission setup as `milo run --mode yolo --allow computer_*`.
      permissionPolicy: new DefaultPermissionPolicy({
        mode: 'yolo',
        allow: ['computer_list', 'computer_open', 'computer_snapshot', 'computer_act'],
      }),
      memory: {
        recall: async () => [],
        remember: async () => ({ processed: 0, duplicates: 0 }),
        list: async () => [],
        update: async () => ({ ok: true }),
        forget: async () => false,
      } as never,
      cwd: process.cwd(),
    })

    // Same scope and Session.send(prompt) call as `milo run`.
    const session = await runtime.newSession({ gateway: 'cli', chatId: 'main' })
    const toolEnds: Array<{ name: string; result: string; isError: boolean }> = []
    for await (const ev of session.send('List windows and click a button')) {
      if (ev.type === 'tool-end') toolEnds.push({ name: ev.name, result: ev.result, isError: ev.isError })
    }

    // Catalog construction excluded all computer_* tools.
    expect(seenToolLists.length).toBeGreaterThan(0)
    for (const toolNames of seenToolLists) {
      expect(toolNames.filter((name) => name.startsWith('computer_'))).toEqual([])
    }

    // Every computer_* call that reached execution was rejected.
    expect(toolEnds).toHaveLength(4)
    for (const end of toolEnds) {
      expect(end.isError).toBe(true)
      expect(end.result).toContain('Computer Use is unavailable')
    }

    // Zero desktop operations were dispatched to the adapter.
    expect(probeSpy).not.toHaveBeenCalled()
    expect(listWindowsSpy).not.toHaveBeenCalled()
    expect(listAppsSpy).not.toHaveBeenCalled()
    expect(launchAppSpy).not.toHaveBeenCalled()
    expect(getStateSpy).not.toHaveBeenCalled()
    expect(clickElSpy).not.toHaveBeenCalled()
    expect(setValSpy).not.toHaveBeenCalled()
    expect(clickCoordsSpy).not.toHaveBeenCalled()
    expect(typeTextSpy).not.toHaveBeenCalled()
    expect(pressKeySpy).not.toHaveBeenCalled()
    expect(scrollSpy).not.toHaveBeenCalled()
  })

  it('keeps desktop access unavailable in Plan mode, routines, delegated work, subagents, and shared chats', async () => {
    const adapter = makeFakeAdapter()
    const manager = new ComputerManager(adapter)
    const registry = createToolRegistry({ computer: manager })

    // Plan mode excludes all computer_* tools.
    for (const name of ['computer_list', 'computer_open', 'computer_snapshot', 'computer_act']) {
      expect(isPlanTool(registry.get(name))).toBe(false)
    }
    const planPolicy = withPlan(new DefaultPermissionPolicy({ mode: 'yolo' }))
    expect(await planPolicy.decide(registry.get('computer_list')!, {})).toBe('deny')
    expect(await planPolicy.decide(registry.get('computer_open')!, {})).toBe('deny')

    // Delegated work refuses computer_* tools even if named in grants.
    const delegatedPolicy = withDelegatedGrants(
      new DefaultPermissionPolicy({ mode: 'yolo' }),
      ['computer_list', 'computer_open', 'computer_snapshot', 'computer_act'],
      process.cwd(),
    )
    expect(await delegatedPolicy.decide(registry.get('computer_list')!, {})).toBe('deny')
    expect(await delegatedPolicy.decide(registry.get('computer_act')!, {})).toBe('deny')

    // Subagents never receive computer_* tools in their catalog.
    let subagentTools: string[] = []
    await runSubagent({
      provider: scriptedProvider([
        (req) => {
          subagentTools = (req.tools ?? []).map((t) => t.name)
          return [
            { type: 'text', delta: 'Subagent done.' },
            { type: 'done', finishReason: 'stop' },
          ]
        },
      ]),
      model: 'test-model',
      registry,
      cwd: process.cwd(),
      signal: new AbortController().signal,
      input: { description: 'check', prompt: 'check' },
      context: {},
    })
    expect(subagentTools.some((n) => n.startsWith('computer_'))).toBe(false)

    // Shared chats (`sessionsAllowed: false`) withhold computer_* tools in Session.turn.
    let sharedTools: string[] = []
    const session = new Session({
      record: { version: 1, id: 'shared-1', createdAt: Date.now(), updatedAt: Date.now(), messages: [] },
      scope: { gateway: 'telegram', chatId: 'group-1' },
      provider: scriptedProvider([
        (req) => {
          sharedTools = (req.tools ?? []).map((t) => t.name)
          return [
            { type: 'text', delta: 'Hi.' },
            { type: 'done', finishReason: 'stop' },
          ]
        },
      ]),
      model: 'test-model',
      system: 'Base prompt',
      registry,
      computer: manager,
      memory: { recall: async () => [], remember: async () => ({ processed: 0, duplicates: 0 }), list: async () => [], update: async () => ({ ok: true }), forget: async () => false } as never,
      store: new MemorySessionStore(),
      cwd: process.cwd(),
    })
    for await (const _ of session.send('hello', { sessionsAllowed: false })) {
      // drain
    }
    expect(sharedTools.some((n) => n.startsWith('computer_'))).toBe(false)
  })

  it('serializes desktop operations across concurrent Sessions', async () => {
    const events: string[] = []
    let inFlight = 0
    let maxInFlight = 0

    const adapter = makeFakeAdapter({
      listWindows: async () => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        events.push(`start-${events.length}`)
        await new Promise((r) => setTimeout(r, 25))
        events.push(`end-${events.length}`)
        inFlight -= 1
        return [sampleWindow()]
      },
    })
    const manager = new ComputerManager(adapter)

    await Promise.all([
      manager.list(undefined),
      manager.list(undefined),
      manager.list(undefined),
    ])

    expect(maxInFlight).toBe(1)
    expect(events).toEqual(['start-0', 'end-1', 'start-2', 'end-3', 'start-4', 'end-5'])
  })

  it('invalidates desktop access on cancellation and turn end', async () => {
    const adapter = makeFakeAdapter()
    const manager = new ComputerManager(adapter)

    const opened = await manager.openWindow({
      turnId: 'turn-cancel',
      expectedWindow: sampleWindow(),
      visionConfirmed: true,
    })
    expect(opened.ok).toBe(true)

    const ac = new AbortController()
    ac.abort()
    const abortedSnap = await manager.snapshot({
      turnId: 'turn-cancel',
      visionConfirmed: true,
      signal: ac.signal,
    }).catch((err: Error) => ({ ok: false as const, error: err.message }))
    expect(abortedSnap.ok).toBe(false)

    manager.releaseTurn('turn-cancel')
    const afterRelease = await manager.snapshot({ turnId: 'turn-cancel', visionConfirmed: true })
    expect(afterRelease.ok).toBe(false)
    if (!afterRelease.ok) expect(afterRelease.error).toContain('computer_open')
  })

  it('re-inspects state when delivery is uncertain and reports unavailable backends', async () => {
    const adapter = makeFakeAdapter({
      clickElement: async () => ({
        effect: 'unverifiable',
        completion: 'unknown',
        route: 'accessibility',
        summary: 'Click dispatched but effect could not be confirmed.',
        uncertain: true,
      }),
    })
    const manager = new ComputerManager(adapter)

    await manager.openWindow({ turnId: 'turn-uncertain', expectedWindow: sampleWindow(), visionConfirmed: false })
    const acted = await manager.act({
      turnId: 'turn-uncertain',
      input: { action: 'click', ref: 'c1' },
      visionConfirmed: false,
    })
    expect(acted.ok).toBe(true)
    if (!acted.ok) return
    expect(acted.result.outcome.uncertain).toBe(true)
    expect(acted.result.snapshot).not.toBeNull()
    expect(adapter.getWindowState).toHaveBeenCalledTimes(2)

    const unavailable = new ComputerManager(
      makeFakeAdapter({
        status: readyStatus({
          available: false,
          displayServer: 'none',
          reason: 'No active desktop display found (WAYLAND_DISPLAY and DISPLAY are both unset).',
          summary: 'Unavailable (no display server)',
        }),
      }),
    )
    const listed = await unavailable.list(undefined)
    expect(listed.ok).toBe(false)
    if (!listed.ok) expect(listed.error).toContain('WAYLAND_DISPLAY')
  })

  it('reports ambiguity when launching an app opens several candidate windows', async () => {
    let windows: DiscoveredWindow[] = []
    const adapter = makeFakeAdapter({
      windows: () => windows,
      launchApp: async () => {
        windows = [
          sampleWindow({ windowId: '1001', appName: 'editor', title: 'Document 1' }),
          sampleWindow({ windowId: '1002', appName: 'editor', title: 'Document 2' }),
        ]
        return { ok: true, text: 'Launched.' }
      },
    })
    const manager = new ComputerManager(adapter)

    const opened = await manager.openWindow({
      turnId: 'turn-ambig',
      launchApp: { name: 'editor' },
      visionConfirmed: false,
    })
    expect(opened.ok).toBe(false)
    if (!opened.ok) {
      expect(opened.candidates).toHaveLength(2)
      expect(opened.error).toContain('2 candidate windows')
    }
    expect(manager.boundWindow('turn-ambig')).toBeNull()
  })

  it('refuses to bind an unrelated app window that opens first after launching the approved app', async () => {
    let windows: DiscoveredWindow[] = []
    const adapter = makeFakeAdapter({
      windows: () => windows,
      launchApp: async () => {
        windows = [sampleWindow({ windowId: '8888', pid: 9999, appName: 'firefox', title: 'Browser' })]
        return { ok: true, text: 'Launched.', pid: 4242 }
      },
    })
    const manager = new ComputerManager(adapter)

    const opened = await manager.openWindow({
      turnId: 'turn-unrelated',
      launchApp: { name: 'zenity' },
      visionConfirmed: false,
    })
    expect(opened.ok).toBe(false)
    if (!opened.ok) {
      expect(opened.error).toContain('could not associate')
      expect(opened.candidates?.map((c) => c.appName)).toEqual(['firefox'])
    }
    expect(manager.boundWindow('turn-unrelated')).toBeNull()
  })

  it('routes typing to the approved accessibility element via set_value before keyboard fallback', async () => {
    const setElementValue = vi.fn(async (): Promise<ComputerActionOutcome> => ({
      effect: 'confirmed',
      completion: 'completed',
      route: 'accessibility',
      summary: 'Set element value via AT-SPI.',
      uncertain: false,
    }))
    const adapter = makeFakeAdapter({ setElementValue })
    const manager = new ComputerManager(adapter)

    await manager.openWindow({ turnId: 'turn-type', expectedWindow: sampleWindow(), visionConfirmed: false })
    const res = await manager.act({
      turnId: 'turn-type',
      input: { action: 'type', ref: 'c3', text: 'hello' },
      visionConfirmed: false,
    })
    expect(res.ok).toBe(true)
    expect(setElementValue).toHaveBeenCalledTimes(1)
    expect(adapter.typeText).not.toHaveBeenCalled()
  })

  it('sanitizes mid-turn Session writes on disk with FileSessionStore while preserving live model context and approval details', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milo-cu-persist-'))
    try {
      const store = new FileSessionStore({ dir })
      const created = await store.create()
      const adapter = makeFakeAdapter()
      const manager = new ComputerManager(adapter)
      const registry = createToolRegistry({ computer: manager })
      const steering: string[] = []
      const approvalSummaries: string[] = []
      let midTurnDiskJson = ''
      let sawLiveImageOnStep2 = false
      let sawLiveA11yOnStep2 = false

      const provider = scriptedProvider([
        () => [
          { type: 'tool-call', id: 'call-open', name: 'computer_open', args: { windowId: '94321041156240' } },
          { type: 'done', finishReason: 'tool_calls' },
        ],
        (req) => {
          // Verify live model context still sees the raw a11y tree and in-turn screenshot.
          const toolMsg = req.messages.find((m) => m.role === 'tool')
          const part = toolMsg?.content[0]
          if (part && part.type === 'tool-result') {
            const resolved = toolImages(part)
            sawLiveImageOnStep2 = resolved.images.length === 1 && resolved.images[0]?.data === FAKE_PNG_B64
            sawLiveA11yOnStep2 = resolved.text.includes('SECRET_RAW_A11Y_MARKER_42')
          }
          // Queue a steer message so Session.turn triggers a mid-turn `this.persist()` BEFORE the turn ends.
          steering.push('also type secret-phrase')
          return [
            { type: 'tool-call', id: 'call-type', name: 'computer_act', args: { action: 'type', ref: 'c3', text: 'TOP_SECRET_TYPED_99' } },
            { type: 'done', finishReason: 'tool_calls' },
          ]
        },
        () => {
          // Inspect the Session JSON file on disk WHILE the turn is still running (after mid-turn steer persist).
          midTurnDiskJson = readFileSync(path.join(dir, `${created.id}.json`), 'utf8')
          return [
            { type: 'text', delta: 'All done.' },
            { type: 'done', finishReason: 'stop' },
          ]
        },
      ])

      const session = new Session({
        record: created,
        scope: { gateway: 'cli', chatId: 'local' },
        provider,
        model: 'vision-model',
        modelProfile: async () => ({ id: 'vision-model', vision: true }),
        system: 'Base',
        registry,
        computer: manager,
        permissionPolicy: new DefaultPermissionPolicy({ mode: 'ask' }),
        memory: { recall: async () => [], remember: async () => ({ processed: 0, duplicates: 0 }), list: async () => [], update: async () => ({ ok: true }), forget: async () => false } as never,
        store,
        cwd: process.cwd(),
      })

      for await (const _ of session.send('open and type', {
        steering,
        ask: async (req) => {
          approvalSummaries.push(req.summary)
          return { allowed: true }
        },
      })) {
        // drain
      }

      // Live approval prompt showed the real unredacted typed text.
      expect(approvalSummaries.some((s) => s.includes('TOP_SECRET_TYPED_99'))).toBe(true)
      // Live model context saw the raw a11y tree and screenshot during the turn.
      expect(sawLiveImageOnStep2).toBe(true)
      expect(sawLiveA11yOnStep2).toBe(true)

      // Mid-turn Session JSON on disk NEVER contained raw screenshots, raw a11y trees, or raw typed text.
      expect(midTurnDiskJson.length).toBeGreaterThan(0)
      expect(midTurnDiskJson).not.toContain('SECRET_RAW_A11Y_MARKER_42')
      expect(midTurnDiskJson).not.toContain(FAKE_PNG_B64)
      expect(midTurnDiskJson).not.toContain('TOP_SECRET_TYPED_99')

      // Final Session JSON on disk also stays sanitized.
      const finalDiskJson = readFileSync(path.join(dir, `${created.id}.json`), 'utf8')
      expect(finalDiskJson).not.toContain('SECRET_RAW_A11Y_MARKER_42')
      expect(finalDiskJson).not.toContain(FAKE_PNG_B64)
      expect(finalDiskJson).not.toContain('TOP_SECRET_TYPED_99')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('enforces size, expiry, session access, and client authorization on ephemeral tool previews', async () => {
    let clock = 1_000_000
    const previews = new ComputerPreviewStore({ now: () => clock, ttlMs: 10 * 60 * 1000, maxEntries: 2 })

    const ref = await previews.put({
      callId: 'call-1',
      sessionId: 'sess-1',
      ownerPrincipal: 'device:iphone-1',
      mimeType: 'image/png',
      data: FAKE_PNG_B64,
      width: 400,
      height: 300,
    })
    expect(ref).not.toBeNull()
    expect(Math.max(ref!.width, ref!.height)).toBeLessThanOrEqual(PREVIEW_MAX_LONG_EDGE)

    // Originating authorized client with matching callId and accessible session succeeds.
    const ok = previews.get(ref!.id, {
      principal: 'device:iphone-1',
      callId: 'call-1',
      sessionId: 'sess-1',
      canAccessSession: (sid) => sid === 'sess-1',
    })
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.entry.bytes.length).toBeLessThanOrEqual(PREVIEW_MAX_BYTES)

    // Missing callId or sessionId is rejected with 400.
    const missingCall = previews.get(ref!.id, {
      principal: 'device:iphone-1',
      callId: null,
      sessionId: 'sess-1',
      canAccessSession: () => true,
    })
    expect(missingCall).toEqual({ ok: false, status: 400, reason: 'bad_request' })

    const missingSession = previews.get(ref!.id, {
      principal: 'device:iphone-1',
      callId: 'call-1',
      sessionId: null,
      canAccessSession: () => true,
    })
    expect(missingSession).toEqual({ ok: false, status: 400, reason: 'bad_request' })

    // Unrelated client is rejected with 403.
    const otherClient = previews.get(ref!.id, {
      principal: 'device:iphone-2',
      callId: 'call-1',
      sessionId: 'sess-1',
      canAccessSession: () => true,
    })
    expect(otherClient).toEqual({ ok: false, status: 403, reason: 'forbidden' })

    // Mismatched tool call id is rejected with 403.
    const wrongCall = previews.get(ref!.id, {
      principal: 'device:iphone-1',
      callId: 'call-other',
      sessionId: 'sess-1',
      canAccessSession: () => true,
    })
    expect(wrongCall).toEqual({ ok: false, status: 403, reason: 'forbidden' })

    // Wrong sessionId is rejected with 403.
    const wrongSession = previews.get(ref!.id, {
      principal: 'device:iphone-1',
      callId: 'call-1',
      sessionId: 'sess-other',
      canAccessSession: () => true,
    })
    expect(wrongSession).toEqual({ ok: false, status: 403, reason: 'forbidden' })

    // Inaccessible Session is rejected with 403.
    const noSession = previews.get(ref!.id, {
      principal: 'device:iphone-1',
      callId: 'call-1',
      sessionId: 'sess-1',
      canAccessSession: () => false,
    })
    expect(noSession).toEqual({ ok: false, status: 403, reason: 'forbidden' })

    // After 10-minute TTL expires, returns 410 expired.
    clock += 10 * 60 * 1000 + 1
    const expired = previews.get(ref!.id, {
      principal: 'device:iphone-1',
      callId: 'call-1',
      sessionId: 'sess-1',
      canAccessSession: () => true,
    })
    expect(expired).toEqual({ ok: false, status: 410, reason: 'expired' })

    // Revoking a principal immediately invalidates its previews.
    const ref2 = await previews.put({
      callId: 'call-2',
      sessionId: 'sess-1',
      ownerPrincipal: 'device:iphone-1',
      mimeType: 'image/png',
      data: FAKE_PNG_B64,
      width: 300,
      height: 200,
    })
    previews.revokePrincipal('device:iphone-1')
    const revoked = previews.get(ref2!.id, {
      principal: 'device:iphone-1',
      callId: 'call-2',
      sessionId: 'sess-1',
      canAccessSession: () => true,
    })
    expect(revoked).toEqual({ ok: false, status: 410, reason: 'expired' })
  })

  it('sends screenshots only to vision-confirmed models and strips raw desktop content from persisted records and traces', async () => {
    const adapter = makeFakeAdapter()
    const manager = new ComputerManager(adapter)
    const registry = createToolRegistry({ computer: manager })

    const traceEvents: TraceEvent[] = []
    const traces: TraceWriter = { record: (entry) => traceEvents.push(entry) }

    let sawInTurnImage = false
    let sawInTurnRawA11y = false
    const innerProvider = scriptedProvider([
      () => [
        { type: 'tool-call', id: 'open-1', name: 'computer_open', args: { windowId: '94321041156240' } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      (req) => {
        const toolMsg = req.messages.find((m) => m.role === 'tool')
        const part = toolMsg?.content[0]
        if (part && part.type === 'tool-result') {
          const resolved = toolImages(part)
          sawInTurnImage = resolved.images.length === 1 && resolved.images[0]?.data === FAKE_PNG_B64
          sawInTurnRawA11y = resolved.text.includes('SECRET_RAW_A11Y_MARKER_42')
        }
        return [
          { type: 'text', delta: 'Observed Calculator.' },
          { type: 'done', finishReason: 'stop' },
        ]
      },
    ])
    const provider = new TracedProvider(innerProvider, traces)
    const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'inspect calculator' }] }]
    const historyEntries: HistoryEntry[] = []

    for await (const ev of runAgent({
      provider,
      model: 'vision-model',
      tools: registry.specs(),
      registry,
      messages,
      context: {
        cwd: process.cwd(),
        signal: new AbortController().signal,
        turnId: 'turn-vision',
        visionConfirmed: true,
        computerAllowed: true,
        computer: manager,
      },
      permission: { policy: new DefaultPermissionPolicy({ mode: 'ask' }), ask: async () => ({ allowed: true }) },
      trace: { traces, surface: 'cli', session: 's1', turn: 'turn-vision' },
    })) {
      if (ev.type === 'tool-end') {
        historyEntries.push({
          at: new Date().toISOString(),
          session: 's1',
          scope: 'cli:local',
          kind: 'tool',
          tool: { name: ev.name, args: {}, result: ev.result, isError: ev.isError },
        })
      }
    }

    // Active turn received both the screenshot (via shared toolImages path) and raw a11y tree.
    expect(sawInTurnImage).toBe(true)
    expect(sawInTurnRawA11y).toBe(true)

    // After turn end, persisted messages, traces, and exports have ZERO raw screenshots or a11y trees.
    const serializedMessages = JSON.stringify(messages)
    expect(serializedMessages).not.toContain('SECRET_RAW_A11Y_MARKER_42')
    expect(serializedMessages).not.toContain(FAKE_PNG_B64)
    expect(serializedMessages).toContain('Authorized and bound')

    const serializedTraces = JSON.stringify(traceEvents)
    expect(serializedTraces).not.toContain('SECRET_RAW_A11Y_MARKER_42')
    expect(serializedTraces).not.toContain(FAKE_PNG_B64)

    const exported = renderExportMarkdown({ id: 's1', exportedAt: Date.now() }, historyEntries)
    expect(exported).not.toContain('SECRET_RAW_A11Y_MARKER_42')
    expect(exported).not.toContain(FAKE_PNG_B64)

    // Non-vision model with degraded tree reports insufficient evidence.
    const degradedManager = new ComputerManager(
      makeFakeAdapter({
        getWindowState: async (win): Promise<RawWindowState> => ({
          snapshotId: 's-deg',
          pid: win.pid,
          windowId: win.windowId,
          appName: win.appName,
          windowTitle: win.title,
          elements: [],
          degraded: true,
          degradedReason: 'AT-SPI unavailable',
          truncated: false,
        }),
      }),
    )
    const openedNoVision = await degradedManager.openWindow({
      turnId: 'turn-no-vision',
      expectedWindow: sampleWindow(),
      visionConfirmed: false,
    })
    expect(openedNoVision.ok).toBe(true)
    if (openedNoVision.ok) {
      expect(openedNoVision.observation.snapshot.screenshot).toBeUndefined()
      expect(openedNoVision.observation.insufficientEvidence).toContain('confirmed vision support')
    }
  })

  it('exposes shared tool labels and keeps browser tools preferred for webpages in the system prompt', () => {
    expect(toolDisplayName('computer_list')).toBe('Listed windows')
    expect(toolDisplayName('computer_open')).toBe('Opened window')
    expect(toolDisplayName('computer_snapshot')).toBe('Observed window')
    expect(toolDisplayName('computer_act')).toBe('Desktop')
    expect(toolApprovalTitle('computer_open')).toBe('Allow window access')
    expect(toolApprovalTitle('computer_act')).toBe('Allow desktop action')
    expect(toolDetail({ action: 'click', ref: 'c4' })).toBe('click c4')

    const manager = new ComputerManager(makeFakeAdapter())
    const registry = createToolRegistry({ computer: manager })
    const prompt = buildSystemPrompt({
      base: 'Base',
      cwd: process.cwd(),
      provider: 'test',
      model: 'test-model',
      tools: registry.specs(),
      memories: [],
      computer: manager.facts(),
    })
    expect(prompt).toContain('## Computer Use')
    expect(prompt).toContain('first choice for webpages')
    expect(prompt).toContain('untrusted data')
  })

  it('keeps typed desktop text available for live approval while stripping it from model.request.output, model.request.input, tool.call traces, and history', async () => {
    const marker = 'UNIQUE_APPROVAL_MARKER_7391'
    const adapter = makeFakeAdapter()
    const manager = new ComputerManager(adapter)
    const registry = createToolRegistry({ computer: manager })
    const traceEvents: TraceEvent[] = []
    const traces: TraceWriter = { record: (entry) => traceEvents.push(entry) }

    let step = 0
    const innerProvider: Provider = {
      id: 'test',
      stream: async function* (): AsyncIterable<StreamEvent> {
        step += 1
        if (step === 1) {
          yield { type: 'tool-call', id: 'tc-open', name: 'computer_open', args: { windowId: '94321041156240' } }
          yield { type: 'done', finishReason: 'tool_calls' }
          return
        }
        if (step === 2) {
          yield {
            type: 'tool-call',
            id: 'tc-type',
            name: 'computer_act',
            args: { action: 'type', ref: 'c3', text: marker },
          }
          yield { type: 'done', finishReason: 'tool_calls' }
          return
        }
        yield { type: 'text', delta: 'Typed into the field.' }
        yield { type: 'done', finishReason: 'stop' }
      },
    }

    const tracedProvider = new TracedProvider(innerProvider, traces)
    const approvalPrompts: string[] = []
    const dir = mkdtempSync(path.join(tmpdir(), 'milo-cu-trace-'))
    try {
      const store = new FileSessionStore({ dir })
      const created = await store.create()
      const session = new Session({
        record: created,
        scope: { gateway: 'cli', chatId: 'local' },
        provider: tracedProvider,
        model: 'test-model',
        modelProfile: async () => ({ id: 'test-model', vision: true }),
        system: 'Base',
        registry,
        computer: manager,
        permissionPolicy: new DefaultPermissionPolicy({ mode: 'ask' }),
        memory: { recall: async () => [], remember: async () => ({ processed: 0, duplicates: 0 }), list: async () => [], update: async () => ({ ok: true }), forget: async () => false } as never,
        store,
        traces,
        cwd: process.cwd(),
      })

      for await (const _ of session.send('Type into Notes', {
        ask: async (request) => {
          approvalPrompts.push(request.summary)
          return { allowed: true }
        },
      })) {
        // drain
      }

      // Live approval prompt received the actual text so the person could review it.
      expect(approvalPrompts.some((line) => line.includes(marker))).toBe(true)

      // Traces must have recorded model.request (with output tool-calls) and tool.call,
      // and NONE of them may contain the unique typed marker.
      const modelRequests = traceEvents.filter((event) => event.event === 'model.request')
      const toolCalls = traceEvents.filter((event) => event.event === 'tool.call')
      expect(modelRequests.length).toBeGreaterThanOrEqual(2)
      expect(toolCalls.length).toBeGreaterThanOrEqual(2)
      expect(JSON.stringify(traceEvents)).not.toContain(marker)

      // Persisted Session JSON (messages & transcript) must also omit the typed marker.
      const savedJson = readFileSync(path.join(dir, `${created.id}.json`), 'utf8')
      const savedRecord = JSON.parse(savedJson) as { messages?: unknown[] }
      expect(savedRecord.messages?.length ?? 0).toBeGreaterThan(0)
      expect(savedJson).not.toContain(marker)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('stops and re-observes without dispatching fallback typing when set_value or focus click is uncertain', async () => {
    // Case A: setElementValue returns uncertain (completion: 'unknown') -> must NOT call clickElement or typeText.
    const clickSpyA = vi.fn(async (): Promise<ComputerActionOutcome> => ({
      effect: 'confirmed',
      completion: 'completed',
      route: 'accessibility',
      summary: 'clicked',
      uncertain: false,
    }))
    const typeSpyA = vi.fn(async (): Promise<ComputerActionOutcome> => ({
      effect: 'confirmed',
      completion: 'completed',
      route: 'xsendevent',
      summary: 'typed',
      uncertain: false,
    }))
    const stateSpyA = vi.fn(async (win: DiscoveredWindow): Promise<RawWindowState> => ({
      snapshotId: `snap-a-${stateSpyA.mock.calls.length}`,
      pid: win.pid,
      windowId: win.windowId,
      appName: win.appName,
      windowTitle: win.title,
      elements: [{
        elementIndex: 0n,
        role: 'text box',
        depth: 1,
        elementToken: `tok-a-${stateSpyA.mock.calls.length}`,
        label: 'Note',
        value: 'before',
        enabled: true,
        actions: ['click'],
        frame: { x: 10, y: 10, width: 120, height: 30 },
      }],
      degraded: false,
      truncated: false,
    }))
    const managerA = new ComputerManager(
      makeFakeAdapter({
        getWindowState: stateSpyA,
        setElementValue: async (): Promise<ComputerActionOutcome> => ({
          effect: 'unverifiable',
          completion: 'unknown',
          route: 'accessibility',
          summary: 'AT-SPI SetTextValue timed out; delivery is uncertain.',
          uncertain: true,
        }),
        clickElement: clickSpyA,
        typeText: typeSpyA,
      }),
    )

    const openedA = await managerA.openWindow({ turnId: 'turn-a', expectedWindow: sampleWindow(), visionConfirmed: false })
    expect(openedA.ok).toBe(true)
    const actedA = await managerA.act({
      turnId: 'turn-a',
      input: { action: 'type', ref: 'c1', text: 'hello' },
      visionConfirmed: false,
    })
    expect(actedA.ok).toBe(true)
    if (actedA.ok) {
      expect(actedA.result.outcome.completion).toBe('unknown')
      expect(actedA.result.outcome.uncertain).toBe(true)
      expect(actedA.result.snapshot).not.toBeNull()
    }
    expect(clickSpyA).not.toHaveBeenCalled()
    expect(typeSpyA).not.toHaveBeenCalled()
    expect(stateSpyA.mock.calls.length).toBeGreaterThanOrEqual(2)

    // Case B: setElementValue positively reports not_started -> tries non-activating focusElement -> focus is uncertain -> must NOT call typeText or clickElement.
    const clickSpyB = vi.fn(async (): Promise<ComputerActionOutcome> => ({
      effect: 'confirmed',
      completion: 'completed',
      route: 'accessibility',
      summary: 'clicked',
      uncertain: false,
    }))
    const typeSpyB = vi.fn(async (): Promise<ComputerActionOutcome> => ({
      effect: 'confirmed',
      completion: 'completed',
      route: 'xsendevent',
      summary: 'typed',
      uncertain: false,
    }))
    const stateSpyB = vi.fn(async (win: DiscoveredWindow): Promise<RawWindowState> => ({
      snapshotId: `snap-b-${stateSpyB.mock.calls.length}`,
      pid: win.pid,
      windowId: win.windowId,
      appName: win.appName,
      windowTitle: win.title,
      elements: [{
        elementIndex: 0n,
        role: 'text box',
        depth: 1,
        elementToken: `tok-b-${stateSpyB.mock.calls.length}`,
        label: 'Note',
        value: 'before',
        enabled: true,
        actions: ['activate'],
        frame: { x: 10, y: 10, width: 120, height: 30 },
      }],
      degraded: false,
      truncated: false,
    }))
    const managerB = new ComputerManager(
      makeFakeAdapter({
        getWindowState: stateSpyB,
        setElementValue: async (): Promise<ComputerActionOutcome> => ({
          effect: 'refused',
          completion: 'not_started',
          route: 'accessibility',
          summary: 'EditableText interface unavailable.',
          uncertain: false,
        }),
        focusElement: async (): Promise<ComputerActionOutcome> => ({
          effect: 'unverifiable',
          completion: 'unknown',
          route: 'accessibility',
          summary: 'Non-activating focus could not be verified.',
          uncertain: true,
        }),
        clickElement: clickSpyB,
        typeText: typeSpyB,
      }),
    )

    const openedB = await managerB.openWindow({ turnId: 'turn-b', expectedWindow: sampleWindow(), visionConfirmed: false })
    expect(openedB.ok).toBe(true)
    const actedB = await managerB.act({
      turnId: 'turn-b',
      input: { action: 'type', ref: 'c1', text: 'hello' },
      visionConfirmed: false,
    })
    expect(actedB.ok).toBe(true)
    if (actedB.ok) {
      expect(actedB.result.outcome.completion).toBe('unknown')
      expect(actedB.result.outcome.uncertain).toBe(true)
      expect(actedB.result.snapshot).not.toBeNull()
    }
    expect(clickSpyB).not.toHaveBeenCalled()
    expect(typeSpyB).not.toHaveBeenCalled()
    expect(stateSpyB.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('rejects non-editable targets before prompting and never falls back to clicking or typing when set_value refuses a Send button', async () => {
    const clickSpy = vi.fn(async (): Promise<ComputerActionOutcome> => ({
      effect: 'confirmed',
      completion: 'completed',
      route: 'accessibility',
      summary: 'Clicked Send',
      uncertain: false,
    }))
    const typeSpy = vi.fn(async (): Promise<ComputerActionOutcome> => ({
      effect: 'confirmed',
      completion: 'completed',
      route: 'xsendevent',
      summary: 'Typed',
      uncertain: false,
    }))
    const setValSpy = vi.fn(async (): Promise<ComputerActionOutcome> => ({
      effect: 'refused',
      completion: 'not_started',
      route: 'accessibility',
      summary: 'Element "Send" does not support EditableText.',
      uncertain: false,
    }))

    const adapter = makeFakeAdapter({
      getWindowState: async (win): Promise<RawWindowState> => ({
        snapshotId: 'snap-send',
        pid: win.pid,
        windowId: win.windowId,
        appName: win.appName,
        windowTitle: win.title,
        elements: [
          {
            elementIndex: 0n,
            role: 'button',
            depth: 1,
            elementToken: 'tok-send-btn',
            label: 'Send',
            enabled: true,
            actions: ['click'],
          },
          {
            elementIndex: 1n,
            role: 'text box',
            depth: 1,
            elementToken: 'tok-send-misreported',
            label: 'Send',
            enabled: true,
            actions: ['click'],
          },
        ],
        degraded: false,
        truncated: false,
      }),
      setElementValue: setValSpy,
      clickElement: clickSpy,
      typeText: typeSpy,
    })

    const manager = new ComputerManager(adapter)
    const registry = createToolRegistry({ computer: manager })
    const askSpy = vi.fn(async () => ({ allowed: true }))

    let step = 0
    const provider: Provider = {
      id: 'test',
      stream: async function* (): AsyncIterable<StreamEvent> {
        step += 1
        if (step === 1) {
          yield { type: 'tool-call', id: 'tc-open', name: 'computer_open', args: { windowId: '94321041156240' } }
          yield { type: 'done', finishReason: 'tool_calls' }
          return
        }
        if (step === 2) {
          // 1. Attempt to type into non-editable button "Send" (c1) -> rejected BEFORE prompting!
          yield { type: 'tool-call', id: 'tc-type-btn', name: 'computer_act', args: { action: 'type', ref: 'c1', text: 'hello' } }
          yield { type: 'done', finishReason: 'tool_calls' }
          return
        }
        if (step === 3) {
          // 2. Attempt to type into misreported "Send" (c2) -> approved for typing, set_value refuses -> NO click, NO typeText!
          yield { type: 'tool-call', id: 'tc-type-refused', name: 'computer_act', args: { action: 'type', ref: 'c2', text: 'hello' } }
          yield { type: 'done', finishReason: 'tool_calls' }
          return
        }
        yield { type: 'text', delta: 'Done.' }
        yield { type: 'done', finishReason: 'stop' }
      },
    }

    const toolResults: Array<{ id: string; content: string; isError?: boolean }> = []
    for await (const event of runAgent({
      provider,
      model: 'test-model',
      system: 'Base',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Type into Send' }] }],
      tools: registry.specs(),
      registry,
      context: {
        cwd: process.cwd(),
        signal: new AbortController().signal,
        turnId: 'turn-send',
        sessionId: 'sess-send',
        visionConfirmed: false,
        computerAllowed: true,
        computer: manager,
      },
      permission: { policy: new DefaultPermissionPolicy({ mode: 'ask' }), ask: askSpy },
    })) {
      if (event.type === 'tool-end') {
        toolResults.push({ id: event.id, content: event.result, isError: event.isError })
      }
    }

    // askSpy was called ONLY twice: once for computer_open and once for c2 (NEVER for non-editable button c1!).
    expect(askSpy).toHaveBeenCalledTimes(2)
    const btnResult = toolResults.find((r) => r.id === 'tc-type-btn')
    expect(btnResult?.isError).toBe(true)
    expect(btnResult?.content).toContain('non-editable')

    const refusedResult = toolResults.find((r) => r.id === 'tc-type-refused')
    expect(refusedResult?.isError).toBe(true)
    expect(refusedResult?.content).toContain('refused')
    expect(setValSpy).toHaveBeenCalledTimes(1)
    expect(clickSpy).not.toHaveBeenCalled()
    expect(typeSpy).not.toHaveBeenCalled()
  })

  it('evicts preview bytes at the 10-minute deadline while idle and releases its timer on shutdown', async () => {
    vi.useFakeTimers()
    try {
      const previews = new ComputerPreviewStore({ ttlMs: 10 * 60 * 1000 })
      const ref = await previews.put({
        callId: 'call-idle',
        sessionId: 'sess-idle',
        ownerPrincipal: 'owner',
        mimeType: 'image/png',
        data: FAKE_PNG_B64,
        width: 400,
        height: 300,
      })
      expect(ref).not.toBeNull()
      expect(previews.size).toBe(1)
      expect(previews.bytes).toBeGreaterThan(0)
      expect(vi.getTimerCount()).toBe(1)

      // Advance to the 10-minute deadline without calling any cache method.
      vi.advanceTimersByTime(10 * 60 * 1000)

      // Bytes and entries were proactively released while idle.
      expect(previews.bytes).toBe(0)
      expect(previews.size).toBe(0)
      expect(vi.getTimerCount()).toBe(0)

      // Shutdown releases cached bytes and cancels any scheduled sweep timer immediately.
      const ref2 = await previews.put({
        callId: 'call-shutdown',
        sessionId: 'sess-idle',
        ownerPrincipal: 'owner',
        mimeType: 'image/png',
        data: FAKE_PNG_B64,
        width: 400,
        height: 300,
      })
      expect(ref2).not.toBeNull()
      expect(previews.bytes).toBeGreaterThan(0)
      expect(vi.getTimerCount()).toBe(1)

      previews.close()
      expect(previews.bytes).toBe(0)
      expect(previews.size).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses missing and blank refs for type before prompting and dispatches no keyboard input', async () => {
    const setValSpy = vi.fn(async (): Promise<ComputerActionOutcome> => ({
      effect: 'confirmed',
      completion: 'completed',
      route: 'accessibility',
      summary: 'Set value',
      uncertain: false,
    }))
    const typeSpy = vi.fn(async (): Promise<ComputerActionOutcome> => ({
      effect: 'confirmed',
      completion: 'completed',
      route: 'xsendevent',
      summary: 'Typed',
      uncertain: false,
    }))
    const clickSpy = vi.fn(async (): Promise<ComputerActionOutcome> => ({
      effect: 'confirmed',
      completion: 'completed',
      route: 'accessibility',
      summary: 'Clicked',
      uncertain: false,
    }))

    const manager = new ComputerManager(
      makeFakeAdapter({
        setElementValue: setValSpy,
        typeText: typeSpy,
        clickElement: clickSpy,
      }),
    )
    const registry = createToolRegistry({ computer: manager })
    const askSpy = vi.fn(async () => ({ allowed: true }))

    let step = 0
    const provider: Provider = {
      id: 'test',
      stream: async function* (): AsyncIterable<StreamEvent> {
        step += 1
        if (step === 1) {
          yield { type: 'tool-call', id: 'tc-open', name: 'computer_open', args: { windowId: '94321041156240' } }
          yield { type: 'done', finishReason: 'tool_calls' }
          return
        }
        if (step === 2) {
          // Missing ref
          yield { type: 'tool-call', id: 'tc-missing', name: 'computer_act', args: { action: 'type', text: 'hello' } }
          yield { type: 'done', finishReason: 'tool_calls' }
          return
        }
        if (step === 3) {
          // Empty ref
          yield { type: 'tool-call', id: 'tc-empty', name: 'computer_act', args: { action: 'type', ref: '', text: 'hello' } }
          yield { type: 'done', finishReason: 'tool_calls' }
          return
        }
        if (step === 4) {
          // Whitespace-only ref
          yield { type: 'tool-call', id: 'tc-blank', name: 'computer_act', args: { action: 'type', ref: '   ', text: 'hello' } }
          yield { type: 'done', finishReason: 'tool_calls' }
          return
        }
        yield { type: 'text', delta: 'Done.' }
        yield { type: 'done', finishReason: 'stop' }
      },
    }

    const toolResults: Array<{ id: string; content: string; isError?: boolean }> = []
    for await (const event of runAgent({
      provider,
      model: 'test-model',
      system: 'Base',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Type without ref' }] }],
      tools: registry.specs(),
      registry,
      context: {
        cwd: process.cwd(),
        signal: new AbortController().signal,
        turnId: 'turn-missing-ref',
        sessionId: 'sess-missing-ref',
        visionConfirmed: false,
        computerAllowed: true,
        computer: manager,
      },
      permission: { policy: new DefaultPermissionPolicy({ mode: 'ask' }), ask: askSpy },
    })) {
      if (event.type === 'tool-end') {
        toolResults.push({ id: event.id, content: event.result, isError: event.isError })
      }
    }

    // Only computer_open prompted; missing, empty, and blank refs never triggered approval.
    expect(askSpy).toHaveBeenCalledTimes(1)
    for (const callId of ['tc-missing', 'tc-empty', 'tc-blank']) {
      const res = toolResults.find((r) => r.id === callId)
      expect(res?.isError).toBe(true)
      expect(res?.content).toContain('requires a current editable element ref')
    }
    expect(setValSpy).not.toHaveBeenCalled()
    expect(typeSpy).not.toHaveBeenCalled()
    expect(clickSpy).not.toHaveBeenCalled()
  })

  it('distinguishes every Hyprland plugin state via hyprctl -j cua:status and package presence, including failed probes', async () => {
    const hyprEnv: NodeJS.ProcessEnv = { HYPRLAND_INSTANCE_SIGNATURE: 'sig-123' }
    const calls: Array<{ file: string; args: string[] }> = []

    const probeWith = (
      runCommand: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>,
      fileExists: (p: string) => boolean = () => false,
    ) =>
      probeHyprlandPluginStatus({
        platform: 'linux',
        env: hyprEnv,
        fileExists,
        runCommand: async (file, args) => {
          calls.push({ file, args })
          return runCommand(file, args)
        },
      })

    // 1. Not installed: hyprctl -j cua:status returns "unknown request", pacman reports package not found.
    const notInstalled = await probeWith(async (file) => {
      if (file === 'hyprctl') return { stdout: 'unknown request\n', stderr: '' }
      const err = Object.assign(new Error('exit 1'), { code: 1, stderr: "error: package 'cua-hyprland-plugin' was not found\n", stdout: '' })
      throw err
    })
    expect(notInstalled).toBe('not_installed')
    expect(hyprlandPluginSummaryTag(notInstalled)).toBe('Hyprland plugin not installed')
    expect(hyprlandPluginLimitation(notInstalled)).toContain(OMARCHY_ACTIVATION_GUIDE)

    // 2. Installed, not loaded: hyprctl returns "unknown request", pacman -Q succeeds.
    const installedNotLoaded = await probeWith(async (file) => {
      if (file === 'hyprctl') return { stdout: 'unknown request\n', stderr: '' }
      return { stdout: 'cua-hyprland-plugin 0.47.5-1\n', stderr: '' }
    })
    expect(installedNotLoaded).toBe('installed_not_loaded')
    expect(hyprlandPluginSummaryTag(installedNotLoaded)).toBe('Hyprland plugin installed, not loaded')
    expect(hyprlandPluginLimitation(installedNotLoaded)).toContain(OMARCHY_ACTIVATION_GUIDE)

    const readyPayload = {
      configured: true,
      abi: { compiled_hash: 'aaa111', runtime_hash: 'aaa111', match: true },
      transport: { ready: true, state: 'ready' },
      input: {
        test_only: false,
        protocol: 3,
        transport_ready: true,
      },
    }

    const kindBison67Status = {
      name: 'cua-hyprland-plugin',
      plugin_version: '0.1.0',
      state: 'discovery_only',
      protocol: { major: 2, minor: 0, max_frame_bytes: 4120 },
      compositor_epoch: 0,
      abi: {
        compiled_hash: 'efb50993780079460b0cbed1363e2166a2de1d9f_aq_0.15_hu_0.14_hg_0.5_hc_0.1_hlg_0.6',
        runtime_hash: 'efb50993780079460b0cbed1363e2166a2de1d9f_aq_0.15_hu_0.14_hg_0.5_hc_0.1_hlg_0.6',
        match: true,
      },
      configured: false,
      transport: { ready: false, socket: '', mode: '0600', peer_policy: 'same_uid', last_error: '' },
      capabilities: {
        supported: ['discovery'],
        enabled: [],
        mutation: 'disabled_pending_rfc_and_agent_seat',
      },
      connections: {
        accepted: 0,
        rejected_peers: 0,
        rejected_busy: 0,
        timed_out_handshakes: 0,
        timed_out_idle: 0,
        malformed_frames: 0,
      },
      keyboard_layout_independent: true,
      foreground_numlock_compatible: true,
      ime_popup_guard: true,
    }

    // 3a. Discovery-only module (real kind-bison-67 payload and legacy mode: 'discovery-only'):
    // Never classify discovery-only modules as loaded_disabled even when configured/transport are false.
    const kindBisonDiscoveryOnly = await probeWith(async () => ({
      stdout: JSON.stringify(kindBison67Status),
      stderr: '',
    }))
    expect(kindBisonDiscoveryOnly).toBe('loaded_discovery_only')
    expect(hyprlandPluginSummaryTag(kindBisonDiscoveryOnly)).toBe('Hyprland plugin loaded. Background input unavailable.')
    expect(hyprlandPluginLimitation(kindBisonDiscoveryOnly)).toContain('Hyprland plugin loaded. Background input unavailable.')
    expect(hyprlandPluginLimitation(kindBisonDiscoveryOnly)).not.toContain('plugin:cua:enabled')

    const discoveryOnly = await probeWith(async () => ({
      stdout: JSON.stringify({
        ...readyPayload,
        mode: 'discovery-only',
        input: {
          test_only: true,
          protocol: 3,
          transport_ready: false,
        },
      }),
      stderr: '',
    }))
    expect(discoveryOnly).toBe('loaded_discovery_only')
    expect(hyprlandPluginSummaryTag(discoveryOnly)).toBe('Hyprland plugin loaded. Background input unavailable.')
    expect(hyprlandPluginLimitation(discoveryOnly)).toContain(OMARCHY_ACTIVATION_GUIDE)

    const discoveryOnlyNoInput = await probeWith(async () => ({
      stdout: JSON.stringify({
        configured: true,
        abi: { compiled_hash: 'aaa111', runtime_hash: 'aaa111', match: true },
        transport: { ready: true, state: 'ready' },
        mode: 'discovery-only',
      }),
      stderr: '',
    }))
    expect(discoveryOnlyNoInput).toBe('loaded_discovery_only')

    // 3b. Compatible input explicitly turned off -> loaded_disabled (only case recommending plugin:cua:enabled & reload).
    const configuredOnly = await probeWith(async () => ({
      stdout: JSON.stringify({ configured: true }),
      stderr: '',
    }))
    expect(configuredOnly).toBe('unverified')

    const unverifiedAbiDisabled = await probeWith(async () => ({
      stdout: JSON.stringify({
        configured: false,
        capabilities: { supported: ['discovery', 'input'], enabled: ['discovery'] },
        input: { test_only: false, protocol: 3, transport_ready: false },
      }),
      stderr: '',
    }))
    expect(unverifiedAbiDisabled).toBe('unverified')

    const supportedButDisabled = await probeWith(async () => ({
      stdout: JSON.stringify({
        ...kindBison67Status,
        state: 'ready',
        capabilities: { supported: ['discovery', 'input'], enabled: ['discovery'] },
        input: { test_only: false, protocol: 3, transport_ready: false },
      }),
      stderr: '',
    }))
    expect(supportedButDisabled).toBe('loaded_disabled')
    expect(hyprlandPluginSummaryTag(supportedButDisabled)).toBe('Hyprland plugin loaded, input disabled')
    expect(hyprlandPluginLimitation(supportedButDisabled)).toContain('plugin:cua:enabled')
    expect(hyprlandPluginLimitation(supportedButDisabled)).toContain('reload')

    const supportedButDisabledNoInputBlock = await probeWith(async () => ({
      stdout: JSON.stringify({
        abi: { match: true },
        configured: false,
        capabilities: { supported: ['discovery', 'input'] },
      }),
      stderr: '',
    }))
    expect(supportedButDisabledNoInputBlock).toBe('unverified')
    expect(hyprlandPluginSummaryTag(supportedButDisabledNoInputBlock)).toBe('Hyprland plugin status unverified')
    expect(hyprlandPluginLimitation(supportedButDisabledNoInputBlock)).not.toContain('plugin:cua:enabled')
    expect(hyprlandPluginLimitation(supportedButDisabledNoInputBlock)).not.toContain('reload')

    const kindBisonInputCapableNoInputBlock = await probeWith(async () => ({
      stdout: JSON.stringify({
        ...kindBison67Status,
        state: 'ready',
        capabilities: { supported: ['discovery', 'input'], enabled: ['discovery'] },
      }),
      stderr: '',
    }))
    expect(kindBisonInputCapableNoInputBlock).toBe('unverified')

    // 3c. Stopped transport (input enabled/configured, but transport unready/stopped) -> never recommends plugin:cua:enabled.
    const stoppedInputTransport = await probeWith(async () => ({
      stdout: JSON.stringify({
        ...readyPayload,
        capabilities: { supported: ['discovery', 'input'], enabled: ['discovery', 'input'] },
        input: {
          ...readyPayload.input,
          transport_ready: false,
        },
      }),
      stderr: '',
    }))
    expect(stoppedInputTransport).toBe('loaded_transport_stopped')
    expect(hyprlandPluginSummaryTag(stoppedInputTransport)).toBe('Hyprland input transport stopped')
    expect(hyprlandPluginLimitation(stoppedInputTransport)).toContain('transport is stopped')
    expect(hyprlandPluginLimitation(stoppedInputTransport)).not.toContain('plugin:cua:enabled')
    expect(hyprlandPluginLimitation(stoppedInputTransport)).not.toContain('reload')

    const stoppedOuterTransport = await probeWith(async () => ({
      stdout: JSON.stringify({
        ...readyPayload,
        capabilities: { supported: ['discovery', 'input'], enabled: ['discovery', 'input'] },
        transport: { ready: false, state: 'stopped' },
      }),
      stderr: '',
    }))
    expect(stoppedOuterTransport).toBe('loaded_transport_stopped')

    // 3d. ABI mismatch (even when configured: false) -> never recommends plugin:cua:enabled.
    const abiMismatch = await probeWith(async () => ({
      stdout: JSON.stringify({
        ...readyPayload,
        capabilities: { supported: ['discovery', 'input'], enabled: ['discovery', 'input'] },
        abi: { compiled_hash: 'aaa111', runtime_hash: 'bbb222', match: false },
      }),
      stderr: '',
    }))
    expect(abiMismatch).toBe('loaded_abi_mismatch')
    expect(hyprlandPluginSummaryTag(abiMismatch)).toBe('Hyprland plugin ABI mismatch')
    expect(hyprlandPluginLimitation(abiMismatch)).toContain('ABI does not match')
    expect(hyprlandPluginLimitation(abiMismatch)).not.toContain('plugin:cua:enabled')
    expect(hyprlandPluginLimitation(abiMismatch)).not.toContain('reload')

    const abiMismatchWhileDisabled = await probeWith(async () => ({
      stdout: JSON.stringify({
        ...kindBison67Status,
        state: 'ready',
        abi: { compiled_hash: 'aaa111', runtime_hash: 'bbb222', match: false },
        capabilities: { supported: ['discovery', 'input'], enabled: ['discovery'] },
        input: { test_only: false, protocol: 3, transport_ready: false },
      }),
      stderr: '',
    }))
    expect(abiMismatchWhileDisabled).toBe('loaded_abi_mismatch')

    // 3e. Input protocol other than v3 (even when disabled) -> never recommends plugin:cua:enabled.
    const unknownProtocol = await probeWith(async () => ({
      stdout: JSON.stringify({
        ...readyPayload,
        protocol: { major: 3, minor: 0 },
        input: {
          ...readyPayload.input,
          protocol: 4,
        },
      }),
      stderr: '',
    }))
    expect(unknownProtocol).toBe('loaded_unsupported_protocol')
    expect(hyprlandPluginSummaryTag(unknownProtocol)).toBe('Hyprland input protocol unsupported')
    expect(hyprlandPluginLimitation(unknownProtocol)).toContain('protocol other than v3')
    expect(hyprlandPluginLimitation(unknownProtocol)).not.toContain('plugin:cua:enabled')
    expect(hyprlandPluginLimitation(unknownProtocol)).not.toContain('reload')

    const v2ProtocolWhileDisabled = await probeWith(async () => ({
      stdout: JSON.stringify({
        ...readyPayload,
        configured: false,
        enabled: false,
        capabilities: { supported: ['discovery', 'input'], enabled: ['discovery'] },
        input: {
          enabled: false,
          test_only: false,
          protocol: 2,
          transport_ready: false,
        },
      }),
      stderr: '',
    }))
    expect(v2ProtocolWhileDisabled).toBe('loaded_unsupported_protocol')

    // Top-level protocol.major: 3 does not substitute for missing input.protocol.
    const topLevelMajorOnly = await probeWith(async () => ({
      stdout: JSON.stringify({
        ...readyPayload,
        protocol: { major: 3, minor: 0 },
        capabilities: { supported: ['discovery', 'input'], enabled: ['discovery', 'input'] },
        input: {
          test_only: false,
          transport_ready: true,
        },
      }),
      stderr: '',
    }))
    expect(topLevelMajorOnly).toBe('unverified')

    // 4. Active production input: matching ABI, ready outer transport, test_only: false, input.protocol === 3, and input.transport_ready === true
    // even when top-level status protocol.major is 2.
    const inputAvailable = await probeWith(async () => ({
      stdout: JSON.stringify({
        ...readyPayload,
        protocol: { major: 2, minor: 0 },
        capabilities: { supported: ['discovery', 'input'], enabled: ['discovery', 'input'] },
      }),
      stderr: '',
    }))
    expect(inputAvailable).toBe('input_available')
    expect(hyprlandPluginSummaryTag(inputAvailable)).toBe('Hyprland input ready')
    expect(hyprlandPluginLimitation(inputAvailable)).toBeNull()
    expect(OMARCHY_ACTIVATION_GUIDE).toBe('https://github.com/omacom/omarchy-pkgs/blob/master/pkgbuilds/cua-hyprland-plugin/README.md')

    // 5. Failed probe (socket error / timeout / invalid JSON): status could not be verified.
    const socketFailed = await probeWith(async () => {
      throw new Error("Couldn't connect to Hyprland socket")
    })
    expect(socketFailed).toBe('unverified')
    expect(hyprlandPluginSummaryTag(socketFailed)).toBe('Hyprland plugin status unverified')
    expect(hyprlandPluginLimitation(socketFailed)).toContain('could not be verified')

    const malformedJson = await probeWith(async () => ({ stdout: 'not-json', stderr: '' }))
    expect(malformedJson).toBe('unverified')

    // Never invokes the old `hyprctl plugin list` text heuristic.
    expect(calls.some((c) => c.file === 'hyprctl' && c.args.includes('plugin'))).toBe(false)
    expect(calls.some((c) => c.file === 'hyprctl' && c.args[0] === '-j' && c.args[1] === 'cua:status')).toBe(true)
  })

  it('refreshes Hyprland status after a relevant refusal, preserves structured refusal codes once, and distinguishes Chromium shortcut refusal with plugin active', async () => {
    let pluginState: HyprlandPluginState = 'loaded_disabled'
    const chromiumWindow = sampleWindow({
      windowId: '555001',
      pid: 7771,
      appName: 'chromium',
      title: 'Docs - Chromium',
    })
    const probeSpy = vi.fn(async () =>
      readyStatus({
        hyprlandPluginState: pluginState,
        inputModes: {
          accessibility: true,
          windowScopedPointer: pluginState === 'input_available',
          xsendEvent: false,
          hyprlandPlugin: pluginState === 'input_available',
        },
        limitations: hyprlandPluginLimitation(pluginState) ? [hyprlandPluginLimitation(pluginState)!] : [],
        summary: `Ready (SDK 0.56.4 · wayland+xwayland · AT-SPI ready · capture ready · ${hyprlandPluginSummaryTag(pluginState)})`,
      }),
    )

    const adapter = makeFakeAdapter({
      probe: probeSpy,
      listWindows: async () => [chromiumWindow],
      pressKey: async () => ({
        effect: 'refused',
        completion: 'not_started',
        route: 'synthetic_events',
        errorCode: 'background_shortcut_unsupported',
        summary: 'Background shortcut ctrl+l is not supported for Chromium windows.',
        error: 'Background shortcut ctrl+l is not supported for Chromium windows.',
        uncertain: false,
      }),
    })

    const manager = new ComputerManager(adapter)
    const registry = createToolRegistry({ computer: manager })
    const computerOpen = registry.get('computer_open')!
    const computerAct = registry.get('computer_act')!

    const ctx = {
      cwd: process.cwd(),
      signal: new AbortController().signal,
      turnId: 'turn-chromium-refusal',
      sessionId: 'sess-chromium-refusal',
      visionConfirmed: true,
      computerAllowed: true,
      computer: manager,
    }

    // Open and capture Chromium window while plugin is initially loaded_disabled.
    const opened = await computerOpen.execute({ windowId: chromiumWindow.windowId }, ctx)
    expect(opened.isError).toBeFalsy()
    expect(manager.facts('turn-chromium-refusal').status.hyprlandPluginState).toBe('loaded_disabled')
    const probesAfterOpen = probeSpy.mock.calls.length

    // First refusal while plugin is disabled -> explains reason once and points to Omarchy activation guide.
    const refusedDisabled = await computerAct.execute({ action: 'press', key: 'l', modifiers: ['ctrl'] }, ctx)
    expect(refusedDisabled.isError).toBe(true)
    expect(refusedDisabled.content).toContain('[background_shortcut_unsupported]')
    expect(refusedDisabled.content).toContain(OMARCHY_ACTIVATION_GUIDE)
    expect(refusedDisabled.content.match(/Background shortcut ctrl\+l is not supported for Chromium windows\./g)?.length).toBe(1)
    // Short, sanitized guidance appears in persistedContent (shown to the user) without raw window observations.
    expect(refusedDisabled.persistedContent).toContain('[background_shortcut_unsupported]')
    expect(refusedDisabled.persistedContent).toContain(OMARCHY_ACTIVATION_GUIDE)
    expect(refusedDisabled.persistedContent).not.toContain('Elements:')
    expect(refusedDisabled.persistedContent).not.toContain('Readable text:')
    expect(probeSpy.mock.calls.length).toBeGreaterThan(probesAfterOpen)

    // User activates the Hyprland plugin without restarting Milo.
    pluginState = 'input_available'
    const probesBeforeSecond = probeSpy.mock.calls.length

    // Second refusal on Chromium shortcut refreshes status automatically and sees plugin is active,
    // explaining that the plugin is active but Chromium/press lacks a background input route (no install/enable nag).
    const refusedActive = await computerAct.execute({ action: 'press', key: 'l', modifiers: ['ctrl'] }, ctx)
    expect(refusedActive.isError).toBe(true)
    expect(probeSpy.mock.calls.length).toBeGreaterThan(probesBeforeSecond)
    expect(manager.facts('turn-chromium-refusal').status.hyprlandPluginState).toBe('input_available')
    expect(refusedActive.content).toContain('[background_shortcut_unsupported]')
    expect(refusedActive.content).toContain('Hyprland Cua plugin is active')
    expect(refusedActive.content).toContain('"chromium"')
    expect(refusedActive.content).toContain('lacks a supported background input route')
    expect(refusedActive.content).not.toContain(OMARCHY_ACTIVATION_GUIDE)
    expect(refusedActive.content.match(/Background shortcut ctrl\+l is not supported for Chromium windows\./g)?.length).toBe(1)
    expect(refusedActive.persistedContent).toContain('Hyprland Cua plugin is active')
    expect(refusedActive.persistedContent).not.toContain(OMARCHY_ACTIVATION_GUIDE)
    expect(refusedActive.persistedContent).not.toContain('Elements:')
    // Window capture and AT-SPI snapshot remain available in live model context after the refusal.
    expect(refusedActive.content).toContain('Capture: s')
    expect(refusedActive.content).toContain('button "Seven"')
  })

  it('refreshes cached status before rejecting a pointer action so a newly activated plugin succeeds on the next attempt', async () => {
    let pluginState: HyprlandPluginState = 'loaded_disabled'
    const clickCoordsSpy = vi.fn(async () => ({
      effect: 'confirmed' as const,
      completion: 'completed' as const,
      route: 'synthetic_events',
      summary: 'Clicked (25, 30).',
      uncertain: false,
    }))
    const probeSpy = vi.fn(async () =>
      readyStatus({
        hyprlandPluginState: pluginState,
        inputModes: {
          accessibility: true,
          windowScopedPointer: pluginState === 'input_available',
          xsendEvent: false,
          hyprlandPlugin: pluginState === 'input_available',
        },
      }),
    )

    const adapter = makeFakeAdapter({
      probe: probeSpy,
      clickCoordinates: clickCoordsSpy,
    })
    const manager = new ComputerManager(adapter)
    const opened = await manager.openWindow({
      turnId: 'turn-pointer-refresh',
      expectedWindow: sampleWindow(),
      visionConfirmed: true,
    })
    expect(opened.ok).toBe(true)
    const captureId = opened.ok ? opened.observation.snapshot.captureId : ''

    // While plugin is disabled, planning a pixel click refreshes and rejects with the Omarchy activation guide.
    const rejectedPlan = await manager.planAction('turn-pointer-refresh', {
      action: 'click',
      x: 25,
      y: 30,
      captureId,
    })
    expect(rejectedPlan.ok).toBe(false)
    if (!rejectedPlan.ok) {
      expect(rejectedPlan.error).toContain(OMARCHY_ACTIVATION_GUIDE)
    }

    // Plugin is activated since the last check; next pointer action refreshes cached status and succeeds.
    pluginState = 'input_available'
    const acceptedPlan = await manager.planAction('turn-pointer-refresh', {
      action: 'click',
      x: 25,
      y: 30,
      captureId,
    })
    expect(acceptedPlan.ok).toBe(true)
    expect(manager.facts('turn-pointer-refresh').status.hyprlandPluginState).toBe('input_available')

    const acted = await manager.act({
      turnId: 'turn-pointer-refresh',
      input: { action: 'click', x: 25, y: 30, captureId },
      visionConfirmed: true,
    })
    expect(acted.ok).toBe(true)
    expect(clickCoordsSpy).toHaveBeenCalledTimes(1)
  })

  it('preserves Ready, capture, and AT-SPI availability during CuaDriverAdapter.probe() for kind-bison-67 discovery-only status', async () => {
    const prevWayland = process.env.WAYLAND_DISPLAY
    const prevDisplay = process.env.DISPLAY
    process.env.WAYLAND_DISPLAY = 'wayland-1'
    process.env.DISPLAY = ':0'
    try {
      const adapter = new CuaDriverAdapter({
        platform: 'linux',
        env: { HYPRLAND_INSTANCE_SIGNATURE: 'sig-kind-bison-67' },
        runCommand: async () => ({
          stdout: JSON.stringify({
            name: 'cua-hyprland-plugin',
            plugin_version: '0.1.0',
            state: 'discovery_only',
            protocol: { major: 2, minor: 0, max_frame_bytes: 4120 },
            compositor_epoch: 0,
            abi: {
              compiled_hash: 'efb50993780079460b0cbed1363e2166a2de1d9f_aq_0.15_hu_0.14_hg_0.5_hc_0.1_hlg_0.6',
              runtime_hash: 'efb50993780079460b0cbed1363e2166a2de1d9f_aq_0.15_hu_0.14_hg_0.5_hc_0.1_hlg_0.6',
              match: true,
            },
            configured: false,
            transport: { ready: false, socket: '', mode: '0600', peer_policy: 'same_uid', last_error: '' },
            capabilities: {
              supported: ['discovery'],
              enabled: [],
              mutation: 'disabled_pending_rfc_and_agent_seat',
            },
          }),
          stderr: '',
        }),
      })
      const fakeDriver = {
        isAvailable: () => true,
        metadata: async () => ({ driverVersion: '0.56.4' }),
        callTool: async (name: string) => {
          if (name === 'check_permissions') {
            return {
              structuredJson: JSON.stringify({
                atspi: true,
                wayland_enabled: true,
                xsend_event: false,
              }),
            }
          }
          if (name === 'health_report') {
            return {
              structuredJson: JSON.stringify({
                checks: [
                  { name: 'ax_capability', status: 'pass' },
                  { name: 'screen_capture_capability', status: 'pass' },
                  { name: 'wayland_backend', status: 'pass', message: 'virtual-pointer=false' },
                ],
              }),
            }
          }
          return { structuredJson: '{}' }
        },
      }
      Object.assign(adapter as unknown as Record<string, unknown>, {
        sdk: { CuaDriver: { create: () => fakeDriver } },
        driver: fakeDriver,
      })

      const status = await adapter.probe()
      expect(status.available).toBe(true)
      expect(status.screenCaptureAvailable).toBe(true)
      expect(status.atspiAvailable).toBe(true)
      expect(status.inputModes.hyprlandPlugin).toBe(false)
      expect(status.hyprlandPluginState).toBe('loaded_discovery_only')
      expect(status.summary).toBe(
        'Ready (SDK 0.56.4 · wayland+xwayland · AT-SPI ready · capture ready · Hyprland plugin loaded. Background input unavailable.)',
      )
      expect(status.limitations.some((line) => line.includes('Hyprland plugin loaded. Background input unavailable.'))).toBe(true)
      expect(status.limitations.some((line) => line.includes('plugin:cua:enabled'))).toBe(false)

      const help = computerSetupHelp(status)
      expect(help?.label).toBe(COMPUTER_SETUP_HELP_LABEL)
      expect(help?.state).toBe('loaded_discovery_only')
      expect(help?.prompt).toContain('current Omarchy channel')
      expect(help?.prompt).toContain('compatible')
      expect(help?.prompt).not.toContain('plugin:cua:enabled')
    } finally {
      if (prevWayland === undefined) delete process.env.WAYLAND_DISPLAY
      else process.env.WAYLAND_DISPLAY = prevWayland
      if (prevDisplay === undefined) delete process.env.DISPLAY
      else process.env.DISPLAY = prevDisplay
    }
  })

  it('offers guided setup help for installed-not-loaded, discovery-only, and loaded-disabled states only', () => {
    const installedNotLoaded = readyStatus({
      available: true,
      hyprlandPluginState: 'installed_not_loaded',
      limitations: [hyprlandPluginLimitation('installed_not_loaded')!],
      summary: 'Ready (SDK 0.56.4 · wayland+xwayland · AT-SPI ready · capture ready · Hyprland plugin installed, not loaded)',
    })
    const helpNotLoaded = computerSetupHelp(installedNotLoaded)
    expect(helpNotLoaded).not.toBeNull()
    expect(helpNotLoaded?.label).toBe(COMPUTER_SETUP_HELP_LABEL)
    expect(helpNotLoaded?.state).toBe('installed_not_loaded')
    expect(helpNotLoaded?.prompt).toContain('installed_not_loaded')
    expect(helpNotLoaded?.prompt).toContain(installedNotLoaded.summary)
    expect(helpNotLoaded?.prompt).toContain(OMARCHY_ACTIVATION_GUIDE)
    expect(helpNotLoaded?.prompt).toContain('Check the current state on this host')
    expect(helpNotLoaded?.prompt).toContain('Ask for my confirmation before applying')
    expect(helpNotLoaded?.prompt).toContain('verify the Computer Use / Hyprland plugin status again')

    const discoveryOnlyStatus = readyStatus({
      available: true,
      hyprlandPluginState: 'loaded_discovery_only',
      limitations: [hyprlandPluginLimitation('loaded_discovery_only')!],
      summary: 'Ready (SDK 0.56.4 · wayland+xwayland · AT-SPI ready · capture ready · Hyprland plugin loaded. Background input unavailable.)',
    })
    const helpDiscovery = computerSetupHelp(discoveryOnlyStatus)
    expect(helpDiscovery).not.toBeNull()
    expect(helpDiscovery?.label).toBe('Ask Milo for help')
    expect(helpDiscovery?.state).toBe('loaded_discovery_only')
    expect(helpDiscovery?.prompt).toContain('loaded_discovery_only')
    expect(helpDiscovery?.prompt).toContain('Hyprland plugin loaded. Background input unavailable.')
    expect(helpDiscovery?.prompt).toContain('current Omarchy channel')
    expect(helpDiscovery?.prompt).not.toContain('plugin:cua:enabled')
    expect(withComputerSetupHelp(discoveryOnlyStatus).setupHelp).toEqual(helpDiscovery)

    const loadedDisabled = readyStatus({
      available: true,
      hyprlandPluginState: 'loaded_disabled',
      limitations: [hyprlandPluginLimitation('loaded_disabled')!],
      summary: 'Ready (SDK 0.56.4 · wayland+xwayland · AT-SPI ready · capture ready · Hyprland plugin loaded, input disabled)',
    })
    const helpDisabled = computerSetupHelp(loadedDisabled)
    expect(helpDisabled).not.toBeNull()
    expect(helpDisabled?.label).toBe('Ask Milo for help')
    expect(helpDisabled?.state).toBe('loaded_disabled')
    expect(helpDisabled?.prompt).toContain('loaded_disabled')
    expect(helpDisabled?.prompt).toContain('plugin:cua:enabled')
    expect(helpDisabled?.prompt).toContain(OMARCHY_ACTIVATION_GUIDE)
    expect(withComputerSetupHelp(loadedDisabled).setupHelp).toEqual(helpDisabled)

    const ready = readyStatus({
      hyprlandPluginState: 'input_available',
      inputModes: { accessibility: true, windowScopedPointer: true, xsendEvent: false, hyprlandPlugin: true },
      summary: 'Ready (SDK 0.56.4 · wayland+xwayland · AT-SPI ready · capture ready · Hyprland input ready)',
    })
    expect(computerSetupHelp(ready)).toBeNull()
    expect(withComputerSetupHelp(ready).setupHelp).toBeNull()
    expect(computerSetupUnavailableReply(ready)).toContain('already ready')

    const nonHyprland = readyStatus({ hyprlandPluginState: 'not_applicable' })
    expect(computerSetupHelp(nonHyprland)).toBeNull()
    expect(computerSetupUnavailableReply(nonHyprland)).toContain('Hyprland Linux host')

    expect(computerSetupHelp(readyStatus({ hyprlandPluginState: undefined }))).toBeNull()
    expect(computerSetupHelp(readyStatus({ hyprlandPluginState: 'not_installed' }))).toBeNull()
    expect(computerSetupHelp(readyStatus({ hyprlandPluginState: 'unverified' }))).toBeNull()
    expect(computerSetupHelp(null)).toBeNull()

    // Incompatible ABI, unsupported input protocol, and stopped transport must never suggest enabling plugin:cua:enabled.
    for (const [state, expectedSnippet] of [
      ['loaded_abi_mismatch', 'ABI does not match'],
      ['loaded_unsupported_protocol', 'protocol'],
      ['loaded_transport_stopped', 'transport is stopped'],
      ['unverified', 'could not be verified'],
    ] as const) {
      const limitation = hyprlandPluginLimitation(state)!
      const st = readyStatus({
        hyprlandPluginState: state,
        limitations: [limitation],
        summary: `Ready (SDK 0.56.4 · wayland+xwayland · AT-SPI ready · capture ready · ${hyprlandPluginSummaryTag(state)})`,
      })
      expect(computerSetupHelp(st)).toBeNull()
      expect(limitation).toContain(expectedSnippet)
      expect(limitation).not.toContain('plugin:cua:enabled')
      expect(limitation).not.toContain('reload')
      const reply = computerSetupUnavailableReply(st)
      expect(reply).toContain(expectedSnippet)
      expect(reply).not.toContain('plugin:cua:enabled')
      expect(reply).not.toContain('reload')
    }
  })

  it('delivers specific user-facing refusal guidance without plugin:cua:enabled for ABI mismatch, protocol mismatch, and stopped transport', async () => {
    for (const [state, expectedSnippet] of [
      ['loaded_abi_mismatch', 'ABI does not match'],
      ['loaded_unsupported_protocol', 'protocol other than v3'],
      ['loaded_transport_stopped', 'transport is stopped'],
      ['unverified', 'could not be verified'],
    ] as const) {
      const manager = new ComputerManager(
        makeFakeAdapter({
          probe: async () =>
            readyStatus({
              hyprlandPluginState: state,
              inputModes: {
                accessibility: true,
                windowScopedPointer: false,
                xsendEvent: false,
                hyprlandPlugin: false,
              },
              limitations: [hyprlandPluginLimitation(state)!],
              summary: `Ready (SDK 0.56.4 · wayland+xwayland · AT-SPI ready · capture ready · ${hyprlandPluginSummaryTag(state)})`,
            }),
        }),
      )
      const opened = await manager.openWindow({
        turnId: `turn-${state}`,
        expectedWindow: sampleWindow(),
        visionConfirmed: true,
      })
      expect(opened.ok).toBe(true)
      const captureId = opened.ok ? opened.observation.snapshot.captureId : ''
      const plan = await manager.planAction(`turn-${state}`, {
        action: 'click',
        x: 10,
        y: 10,
        captureId,
      })
      expect(plan.ok).toBe(false)
      if (!plan.ok) {
        expect(plan.error).toContain(expectedSnippet)
        expect(plan.error).not.toContain('plugin:cua:enabled')
        expect(plan.error).not.toContain('reload')
      }
    }
  })
})
