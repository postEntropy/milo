import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'
import {
  ComputerManager,
  type ComputerCapabilityStatus,
  type ComputerDriverAdapter,
  type DiscoveredWindow,
  type RawWindowState,
} from '../src/core/computer/index.js'
import { AgentRuntime } from '../src/core/runtime.js'
import { MemorySessionStore } from '../src/core/sessions/index.js'
import { createToolRegistry, DefaultPermissionPolicy } from '../src/core/tools/index.js'
import type { Provider, StreamEvent } from '../src/core/providers/types.js'
import { PROTOCOL_VERSION, type ServerFrame } from '../src/gateways/web/protocol.js'

const home = mkdtempSync(path.join(tmpdir(), 'milo-web-preview-'))
process.env.MILO_HOME = home

const { addDevice, revokeDevice } = await import('../src/gateways/web/devices.js')
const { startWebServer } = await import('../src/gateways/web/http.js')

const running: Array<{ stop(): Promise<void> }> = []

// Valid 1x1 PNG so ffmpeg/thumbnailing and HTTP responses carry real PNG bytes.
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2dIAAAAASUVORK5CYII='

function readyStatus(): ComputerCapabilityStatus {
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
      xsendEvent: false,
      hyprlandPlugin: false,
    },
    limitations: [],
    summary: 'Ready',
  }
}

function sampleWindow(): DiscoveredWindow {
  return {
    pid: 404,
    windowId: '808',
    appName: 'Zenity',
    title: 'Preview Test',
    bounds: { x: 0, y: 0, width: 320, height: 200 },
    isOnScreen: true,
  }
}

function fakeAdapter(): ComputerDriverAdapter {
  const win = sampleWindow()
  let count = 0
  return {
    probe: async () => readyStatus(),
    listApps: async () => [{ name: 'Zenity', pid: win.pid, running: true, active: true }],
    listWindows: async () => [win],
    launchApp: async () => ({ ok: true as const, text: 'Launched.' }),
    getWindowState: async (target): Promise<RawWindowState> => {
      count += 1
      return {
        snapshotId: `snap-${count}`,
        pid: target.pid,
        windowId: target.windowId,
        appName: target.appName,
        windowTitle: target.title,
        elements: [{
          elementIndex: 0n,
          role: 'text box',
          depth: 1,
          elementToken: `tok-${count}`,
          label: 'Field',
          value: 'hello',
          enabled: true,
          actions: ['click'],
          frame: { x: 10, y: 10, width: 120, height: 30 },
        }],
        degraded: false,
        truncated: false,
        screenshot: { mimeType: 'image/png', data: TINY_PNG_B64, width: 1, height: 1, frameValid: true },
      }
    },
    setElementValue: async () => ({ effect: 'confirmed', completion: 'completed', route: 'accessibility', summary: 'set', uncertain: false }),
    clickElement: async () => ({ effect: 'confirmed', completion: 'completed', route: 'accessibility', summary: 'clicked', uncertain: false }),
    clickCoordinates: async () => ({ effect: 'confirmed', completion: 'completed', route: 'window-pointer', summary: 'clicked', uncertain: false }),
    typeText: async () => ({ effect: 'confirmed', completion: 'completed', route: 'accessibility', summary: 'typed', uncertain: false }),
    pressKey: async () => ({ effect: 'confirmed', completion: 'completed', route: 'accessibility', summary: 'pressed', uncertain: false }),
    scroll: async () => ({ effect: 'confirmed', completion: 'completed', route: 'window-pointer', summary: 'scrolled', uncertain: false }),
    close: async () => {},
  }
}

function portOf(url: string): string {
  return new URL(url).port
}

function openSocket(url: string, token: string): Promise<{ ws: WebSocket; frames: ServerFrame[]; waitFor(pred: (f: ServerFrame) => boolean): Promise<ServerFrame> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } })
    const frames: ServerFrame[] = []
    const waiters: Array<{ pred: (f: ServerFrame) => boolean; resolve: (f: ServerFrame) => void }> = []
    ws.on('message', (raw) => {
      const frame = JSON.parse(String(raw)) as ServerFrame
      frames.push(frame)
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i]!.pred(frame)) {
          const [w] = waiters.splice(i, 1)
          w!.resolve(frame)
        }
      }
    })
    ws.on('open', () => {
      resolve({
        ws,
        frames,
        waitFor(pred) {
          const existing = frames.find(pred)
          if (existing) return Promise.resolve(existing)
          return new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error('Timed out waiting for WebSocket frame')), 5000)
            waiters.push({
              pred,
              resolve: (frame) => {
                clearTimeout(timer)
                res(frame)
              },
            })
          })
        },
      })
    })
    ws.on('error', reject)
  })
}

beforeEach(() => {
  rmSync(path.join(home, 'devices.json'), { force: true })
  rmSync(path.join(home, 'pairing.json'), { force: true })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(running.splice(0).map((server) => server.stop()))
})

describe('web computer preview scope and CSP', () => {
  it('enforces callId, sessionId, client ownership, live replay isolation, revocation, expiry, and img-src blob CSP', async () => {
    const manager = new ComputerManager(fakeAdapter())
    const registry = createToolRegistry({ computer: manager })
    let step = 0
    const provider: Provider = {
      id: 'test',
      stream: async function* (): AsyncIterable<StreamEvent> {
        step += 1
        if (step === 1) {
          yield { type: 'tool-call', id: 'tc-open-1', name: 'computer_open', args: { windowId: '808' } }
          yield { type: 'done', finishReason: 'tool_calls' }
          return
        }
        if (step === 2) {
          yield { type: 'tool-call', id: 'tc-act-2', name: 'computer_act', args: { action: 'type', ref: 'c1', text: 'updated' } }
          yield { type: 'done', finishReason: 'tool_calls' }
          return
        }
        yield { type: 'text', delta: 'Done.' }
        yield { type: 'done', finishReason: 'stop' }
      },
    }

    const runtime = new AgentRuntime({
      provider,
      model: 'test-model',
      modelProfile: async () => ({ id: 'test-model', vision: true }),
      system: 'Base',
      registry,
      computer: manager,
      memory: {
        recall: async () => [],
        remember: async () => ({ processed: 0, duplicates: 0 }),
        list: async () => [],
        update: async () => ({ ok: true }),
        forget: async () => false,
      } as never,
      store: new MemorySessionStore(),
      cwd: process.cwd(),
      permissionPolicy: new DefaultPermissionPolicy({ mode: 'ask' }),
    })

    const ownerToken = 'owner-secret-token'
    const deviceA = addDevice({ name: 'iPhone A', platform: 'ios' })
    const deviceB = addDevice({ name: 'iPhone B', platform: 'ios' })

    const server = await startWebServer({
      runtime,
      cwd: process.cwd(),
      host: '127.0.0.1',
      port: 0,
      token: ownerToken,
    })
    running.push(server)

    const base = `http://127.0.0.1:${portOf(server.url)}`
    const wsUrl = `ws://127.0.0.1:${portOf(server.url)}/ws`

    // Production CSP permits blob: for img-src only.
    const indexRes = await fetch(`${base}/?t=${ownerToken}`)
    const csp = indexRes.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("img-src 'self' data: blob:")
    expect(csp).not.toMatch(/script-src[^;]*blob:/)

    const chatId = '11111111-1111-4111-8111-111111111111'
    const clientA = await openSocket(wsUrl, deviceA.token)
    const clientB = await openSocket(wsUrl, deviceB.token)

    clientA.ws.send(JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, chatId }))
    clientB.ws.send(JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, chatId }))
    const readyA = await clientA.waitFor((f) => f.type === 'ready')
    await clientB.waitFor((f) => f.type === 'ready')
    const sessionId = readyA.type === 'ready' ? readyA.sessionId : ''
    expect(sessionId).toBeTruthy()

    // Device A starts a turn that opens a window (producing a preview) and then asks to type.
    clientA.ws.send(JSON.stringify({ type: 'send', text: 'Open and type' }))

    // Approve computer_open from Device A.
    const permOpen = await clientA.waitFor((f) => f.type === 'permission')
    expect(permOpen.type).toBe('permission')
    if (permOpen.type === 'permission') {
      clientA.ws.send(JSON.stringify({ type: 'control', action: 'allow', id: permOpen.id }))
    }

    // Device A receives tool-end WITH preview; Device B receives tool-end WITHOUT preview.
    const isOpenEnd = (f: ServerFrame): boolean => f.type === 'event' && f.event.type === 'tool-end' && f.event.id === 'tc-open-1'
    const openEndA = await clientA.waitFor(isOpenEnd)
    const openEndB = await clientB.waitFor(isOpenEnd)
    expect(openEndA.type === 'event' && openEndA.event.type === 'tool-end' && openEndA.event.preview?.id).toBeTruthy()
    expect(openEndB.type === 'event' && openEndB.event.type === 'tool-end' && openEndB.event.preview).toBeUndefined()
    const previewId = openEndA.type === 'event' && openEndA.event.type === 'tool-end' ? openEndA.event.preview!.id : ''

    // Wait until computer_act pauses on its permission prompt so the turn is actively running.
    const permAct = await clientA.waitFor((f) => f.type === 'permission' && f.id !== (permOpen.type === 'permission' ? permOpen.id : ''))

    // Live replay: another socket for Device B joining mid-turn MUST NOT receive the preview reference.
    const clientBReplay = await openSocket(wsUrl, deviceB.token)
    clientBReplay.ws.send(JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, chatId }))
    const replayEndB = await clientBReplay.waitFor(isOpenEnd)
    expect(replayEndB.type === 'event' && replayEndB.event.type === 'tool-end' && replayEndB.event.preview).toBeUndefined()

    // Live replay: a second socket for the authorized Device A DOES receive the preview reference.
    const clientAReplay = await openSocket(wsUrl, deviceA.token)
    clientAReplay.ws.send(JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, chatId }))
    const replayEndA = await clientAReplay.waitFor(isOpenEnd)
    expect(replayEndA.type === 'event' && replayEndA.event.type === 'tool-end' && replayEndA.event.preview?.id).toBe(previewId)

    // Approve computer_act and let the turn complete.
    if (permAct.type === 'permission') {
      clientA.ws.send(JSON.stringify({ type: 'control', action: 'allow', id: permAct.id }))
    }
    await clientA.waitFor((f) => f.type === 'turn-end')

    const previewUrl = (query: string): string => `${base}/api/tool-preview/${encodeURIComponent(previewId)}${query}`

    // Missing callId -> 400.
    const missingCall = await fetch(previewUrl(`?sessionId=${encodeURIComponent(sessionId)}`), {
      headers: { authorization: `Bearer ${deviceA.token}` },
    })
    expect(missingCall.status).toBe(400)

    // Missing sessionId -> 400.
    const missingSession = await fetch(previewUrl('?callId=tc-open-1'), {
      headers: { authorization: `Bearer ${deviceA.token}` },
    })
    expect(missingSession.status).toBe(400)

    // Wrong sessionId -> 403.
    const wrongSession = await fetch(previewUrl('?callId=tc-open-1&sessionId=wrong-session'), {
      headers: { authorization: `Bearer ${deviceA.token}` },
    })
    expect(wrongSession.status).toBe(403)

    // Wrong callId -> 403.
    const wrongCall = await fetch(previewUrl(`?callId=wrong-call&sessionId=${encodeURIComponent(sessionId)}`), {
      headers: { authorization: `Bearer ${deviceA.token}` },
    })
    expect(wrongCall.status).toBe(403)

    // Another paired device (Device B) -> 403.
    const otherDevice = await fetch(previewUrl(`?callId=tc-open-1&sessionId=${encodeURIComponent(sessionId)}`), {
      headers: { authorization: `Bearer ${deviceB.token}` },
    })
    expect(otherDevice.status).toBe(403)

    // Authorized originating client (Device A) -> 200 with Cache-Control: no-store.
    const okRes = await fetch(previewUrl(`?callId=tc-open-1&sessionId=${encodeURIComponent(sessionId)}`), {
      headers: { authorization: `Bearer ${deviceA.token}` },
    })
    expect(okRes.status).toBe(200)
    expect(okRes.headers.get('cache-control')).toBe('no-store')
    expect(okRes.headers.get('content-type')).toMatch(/^image\//)
    expect((await okRes.arrayBuffer()).byteLength).toBeGreaterThan(0)

    // Expiry: advancing clock past the 10-minute TTL -> 410 expired.
    const realNow = Date.now()
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(realNow + 10 * 60 * 1000 + 1000)
    const expiredRes = await fetch(previewUrl(`?callId=tc-open-1&sessionId=${encodeURIComponent(sessionId)}`), {
      headers: { authorization: `Bearer ${deviceA.token}` },
    })
    expect(expiredRes.status).toBe(410)
    nowSpy.mockRestore()

    // Revocation: revoking Device A rejects its preview fetch with 401 immediately.
    expect(revokeDevice(deviceA.device.id)).toBe(true)
    const revokedRes = await fetch(previewUrl(`?callId=tc-open-1&sessionId=${encodeURIComponent(sessionId)}`), {
      headers: { authorization: `Bearer ${deviceA.token}` },
    })
    expect(revokedRes.status).toBe(401)

    clientA.ws.close()
    clientB.ws.close()
    clientAReplay.ws.close()
    clientBReplay.ws.close()
  })

  it('skips permission frames in Unrestricted mode and keeps the web approval card in the composer dock outside collapsed tool details', async () => {
    const adapter = fakeAdapter()
    const computer = new ComputerManager(adapter)
    const registry = createToolRegistry({ computer })
    let step = 0
    const provider: Provider = {
      id: 'test',
      async *stream(): AsyncGenerator<StreamEvent> {
        step += 1
        if (step === 1) {
          yield { type: 'tool-call', id: 'tc-open-yolo', name: 'computer_open', args: { windowId: '94321041156240' } }
          yield { type: 'done', finishReason: 'tool_calls' }
          return
        }
        if (step === 2) {
          yield { type: 'tool-call', id: 'tc-act-yolo', name: 'computer_act', args: { action: 'type', ref: 'c1', text: 'yolo-ok' } }
          yield { type: 'done', finishReason: 'tool_calls' }
          return
        }
        yield { type: 'text', delta: 'Completed in Unrestricted mode.' }
        yield { type: 'done', finishReason: 'stop' }
      },
    }

    const runtime = new AgentRuntime({
      provider,
      model: 'vision-model',
      modelProfile: async () => ({ id: 'vision-model', vision: true }),
      system: 'Base',
      registry,
      computer,
      store: new MemorySessionStore(),
      permissionPolicy: new DefaultPermissionPolicy({ mode: 'yolo' }),
      memory: {
        recall: async () => [],
        remember: async () => ({ processed: 0, duplicates: 0 }),
        list: async () => [],
        update: async () => ({ ok: true }),
        forget: async () => false,
      } as never,
      cwd: process.cwd(),
    })

    const server = await startWebServer({
      runtime,
      cwd: process.cwd(),
      host: '127.0.0.1',
      port: 0,
      token: 'yolo-owner-token',
    })
    running.push(server)

    const wsUrl = `ws://127.0.0.1:${portOf(server.url)}/ws`
    const client = await openSocket(wsUrl, 'yolo-owner-token')
    client.ws.send(JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, chatId: '22222222-2222-4222-8222-222222222222' }))
    await client.waitFor((f) => f.type === 'ready')

    client.ws.send(JSON.stringify({ type: 'send', text: 'Run without prompting' }))
    await client.waitFor((f) => f.type === 'turn-end')

    expect(client.frames.filter((f) => f.type === 'permission')).toHaveLength(0)
    const toolEnds = client.frames.filter((f) => f.type === 'event' && f.event.type === 'tool-end')
    expect(toolEnds).toHaveLength(2)
    client.ws.close()

    // Structural regression: pending approval card lives in .composer-dock outside .messages and uses pending-action wording.
    const appSource = readFileSync(path.join(process.cwd(), 'web/src/App.tsx'), 'utf8')
    const permissionsSource = readFileSync(path.join(process.cwd(), 'web/src/chat/Permissions.tsx'), 'utf8')
    const dockIdx = appSource.indexOf('className="composer-dock"')
    const approvalIdx = appSource.indexOf('<Permissions ')
    expect(dockIdx).toBeGreaterThan(-1)
    expect(approvalIdx).toBeGreaterThan(dockIdx)
    expect(appSource).not.toContain('<article className="message assistant"><Permissions')
    expect(permissionsSource).toContain('toolApprovalTitle')
    expect(permissionsSource).not.toContain('Milo wants to run')

    // Computer Use preview thumbnails open full-size on click/tap in both Web and iOS.
    const messageListSource = readFileSync(path.join(process.cwd(), 'web/src/chat/MessageList.tsx'), 'utf8')
    expect(messageListSource).toContain('className="tool-preview-btn"')
    expect(messageListSource).toContain('<ImageViewer src={state.url} name="Desktop window preview"')

    const iosRowSource = readFileSync(path.join(process.cwd(), 'ios/Sources/Milo/Support/MessageRow.swift'), 'utf8')
    const iosViewerSource = readFileSync(path.join(process.cwd(), 'ios/Sources/Milo/Support/PictureViewer.swift'), 'utf8')
    expect(iosRowSource).toContain('PictureViewer(image: image, alt: "Desktop window preview")')
    expect(iosViewerSource).toContain('init(image: UIImage, alt: String = "")')
  })
})
