import { randomUUID } from 'node:crypto'

import { errorMessage } from '../../util/errors.js'
import { logDebug } from '../../util/log.js'
import { browserProfileDir } from '../config/paths.js'
import { CdpConnection } from './cdp.js'
import { attachUrl, findChrome, launchChrome } from './chrome.js'
import {
  isPageGoneError,
  mergeObservations,
  observeExpression,
  pageReplaced,
  refExpression,
  refFromEarlierLook,
  refGone,
  type FrameObservation,
  type Observation,
  type RawElement,
} from './observer.js'

/**
 * The browser as a body: open a page, look at it, act on it.
 *
 * One Chrome and one socket per process. Starting a browser per call would put
 * a cold start in front of every click, and a cold start is the kind of seconds
 * that make a feature not worth using — the whole reason this is a class with a
 * lifetime rather than a set of functions.
 */

/** A navigation is a page load, and a page is allowed to be slow. */
export const OPEN_TIMEOUT_MS = 20_000
/** An action is a click, not a query: if it has not landed, something is wrong. */
export const ACT_TIMEOUT_MS = 5_000
/** Reading the page back is a script run, and a big page takes a moment. */
export const SNAPSHOT_TIMEOUT_MS = 10_000

const CONNECT_TIMEOUT_MS = 5_000
const HANDSHAKE_TIMEOUT_MS = 8_000
/** A page repaints after a click; looking instantly shows the frame before it. */
const SETTLE_MS = 150
/** How long nothing may be in flight before a load counts as settled. */
const NETWORK_IDLE_MS = 500
const VIEWPORT = { width: 1280, height: 800 }
/**
 * The live view's JPEG quality. Below the screenshot's 72 on purpose: the frames
 * are watched, not kept, and a smaller frame is what keeps the stream cheap.
 */
const SCREENCAST_QUALITY = 60

export type Wait = 'load' | 'domcontentloaded' | 'networkidle'

export type ActRequest =
  | { action: 'click' | 'double_click'; ref: string }
  | { action: 'type'; ref: string; text: string; replace?: boolean }
  | { action: 'press'; ref?: string; key: string }
  | { action: 'hover'; ref: string }
  | { action: 'scroll'; ref?: string; direction: ScrollDirection }
  | { action: 'select'; ref: string; text: string }
  | { action: 'upload'; ref: string; path: string }

export type ScrollDirection = 'up' | 'down' | 'top' | 'bottom'

export interface BrowserSessionOptions {
  /** An explicit binary; otherwise `MILO_BROWSER_CHROME`, then the usual places. */
  chromePath?: string | null
  /** Where cookies and sign-ins live, so they outlive a restart. */
  profileDir: string
  headless?: boolean
  /** Attach to a browser already running, instead of starting one of our own. */
  cdpUrl?: string | null
}

export interface BrowserStatus {
  running: boolean
  mode: 'owned' | 'attached' | null
  version: string | null
  url: string | null
}

/**
 * What the model is told about the browser it has.
 *
 * It asked, out loud, in a session: the model needed to know which browser it
 * was driving and went looking — `ps`, `ss`, reading `DevToolsActivePort` — and
 * got it wrong, because a note it had *remembered* from an earlier session said
 * Helium while the config had moved to Chromium. The live answer belongs in the
 * prompt, where it costs a line and needs no verification.
 */
export interface BrowserFacts {
  /** The binary, as configured or as actually started. */
  binary: string
  headless: boolean
  /** `its own` or the path of a copied profile. */
  profile: string
  running: boolean
  /** The debugging port, which is only known once it is up. */
  port: number | null
}

/** Which realm minted a ref, so the element can be found again to act on it. */
interface RefOwner {
  nonce: string
  sessionId: string
  contextId: number
}

interface TargetState {
  targetId: string
  sessionId: string | null
  type: string
  url: string
  /** Every default realm of this target: execution context → its frame. */
  contexts: Map<number, string>
  mainFrameId: string | null
  /** Attached because a page we drive contains it (an iframe). */
  nested: boolean
}

/** A frame's own words, read in full when `mode: 'text'` asks for them. */
export interface PageText {
  url: string
  title: string
  text: string
  truncated: boolean
}

const TEXT_LIMIT = 40_000

export class BrowserSession {
  private readonly options: BrowserSessionOptions
  private connection: CdpConnection | null = null
  private stopChrome: (() => void) | null = null
  private starting: Promise<void> | null = null
  private mode: 'owned' | 'attached' | null = null
  private version: string | null = null
  private binary: string | null = null
  private endpoint: string | null = null
  private pageTargetId: string | null = null
  private readonly targets = new Map<string, TargetState>()
  private readonly loadWaiters = new Map<string, Set<() => void>>()
  private readonly domWaiters = new Map<string, Set<() => void>>()
  private readonly inflight = new Map<string, number>()
  private readonly lastNetworkActivity = new Map<string, number>()
  /** The realms behind the refs the model was last shown. */
  private refs = new Map<string, RefOwner>()
  /** What each of those refs actually is, so a field can be recognised as one. */
  private elements = new Map<string, RawElement>()
  private nonce = ''
  /**
   * Where the next observation's ref numbers start, counting up across the
   * whole session rather than restarting at one.
   *
   * This is what makes an old ref fail instead of lying. Numbering from one each
   * time means `r2` is always *some* element — the second one on whatever page is
   * up now — so a ref held from two looks ago would quietly click something else.
   * Counting on, an old ref is simply not in the new list, and saying so is the
   * only honest answer.
   */
  private refCounter = 0
  /** The live view a surface is watching, when one is: the page and its off switch. */
  private screencast: { off: () => void; sessionId: string } | null = null

  constructor(options: BrowserSessionOptions) {
    this.options = options
  }

  /** True when the browser has been started and not yet closed. */
  get isRunning(): boolean {
    return this.connection !== null && !this.connection.isClosed
  }

  /** One line's worth of truth about what the browser is and whether it is up. */
  facts(): BrowserFacts {
    const port = this.endpoint ? Number.parseInt(new URL(this.endpoint).port, 10) : Number.NaN
    return {
      binary: this.binary ?? this.options.chromePath ?? 'the first Chromium on PATH',
      headless: this.options.headless !== false,
      // Its own profile is the common case and the long path is noise in a prompt
      // line: the reader only needs to know whether this is Milo's own or one
      // copied from a browser they use.
      profile: this.options.profileDir === browserProfileDir() ? 'its own' : this.options.profileDir,
      running: this.isRunning,
      port: Number.isFinite(port) ? port : null,
    }
  }

  get status(): BrowserStatus {
    const page = this.pageTargetId ? this.targets.get(this.pageTargetId) : undefined
    return {
      running: this.isRunning,
      mode: this.mode,
      version: this.version,
      url: page?.url ?? null,
    }
  }

  /** Starts the browser, once. Concurrent callers share the one start. */
  async start(): Promise<void> {
    if (this.isRunning) return
    if (!this.starting) {
      this.starting = this.launch().finally(() => {
        this.starting = null
      })
    }
    return this.starting
  }

  async close(): Promise<void> {
    this.screencast = null
    this.connection?.close()
    this.connection = null
    this.stopChrome?.()
    this.stopChrome = null
    this.targets.clear()
    this.pageTargetId = null
    this.mode = null
  }

  /** Opens a URL and hands back the page as the model reads it. */
  async navigate(url: string, wait: Wait, signal: AbortSignal): Promise<Observation> {
    await this.start()
    const target = await this.drivePage(signal)
    const sessionId = target.sessionId!

    const settled = wait === 'domcontentloaded' ? this.domSettled(sessionId) : this.loadSettled(sessionId)
    const result = await this.send<{ errorText?: string }>(
      'Page.navigate',
      { url },
      sessionId,
      OPEN_TIMEOUT_MS,
      signal,
    )
    if (result.errorText) throw new Error(`could not open ${url}: ${result.errorText}`)

    await settled
    if (wait === 'networkidle') await this.networkIdle(sessionId)
    await sleep(SETTLE_MS)
    return this.observe(signal)
  }

  /** What is on the page now. */
  async observe(signal: AbortSignal): Promise<Observation> {
    await this.start()
    const target = await this.drivePage(signal)
    this.nonce = randomUUID()
    this.refs.clear()
    this.elements.clear()

    const realms = this.realms()
    const frames: FrameObservation[] = []
    const unread: string[] = []
    // Continues from the last look: no ref number is ever handed out twice.
    let base = this.refCounter

    for (const realm of realms) {
      const label = realm.frameId === target.mainFrameId ? 'main' : realm.title
      try {
        const result = await this.send<{
          result?: { value?: unknown }
          exceptionDetails?: { text?: string; exception?: { description?: string; value?: unknown } }
        }>(
          'Runtime.evaluate',
          {
            expression: observeExpression(label, base, this.nonce),
            contextId: realm.contextId,
            returnByValue: true,
            awaitPromise: false,
          },
          realm.sessionId,
          SNAPSHOT_TIMEOUT_MS,
          signal,
        )
        if (result.exceptionDetails) {
          unread.push(`${label}: ${scriptFailure(result.exceptionDetails)}`)
          continue
        }
        const value = result.result?.value as FrameObservation | undefined
        if (!value || !Array.isArray(value.elements)) {
          unread.push(`${label}: the frame answered nothing`)
          continue
        }
        for (const element of value.elements) {
          this.refs.set(element.ref, { nonce: this.nonce, sessionId: realm.sessionId, contextId: realm.contextId })
          this.elements.set(element.ref, element)
        }
        base += value.elements.length
        frames.push(value)
      } catch (error) {
        unread.push(`${label}: ${errorMessage(error)}`)
      }
    }

    this.refCounter = base
    return mergeObservations(frames, unread)
  }

  /** What the element behind a ref is, from the look that minted it. */
  elementFor(ref: string): RawElement | undefined {
    return this.elements.get(ref)
  }

  /** The page's own words, in full, for reading rather than driving. */
  async readText(signal: AbortSignal): Promise<PageText> {
    await this.start()
    const target = await this.drivePage(signal)
    const contextId = this.mainContext(target)
    if (contextId === null) throw new Error('the page has no readable frame')

    const expression = `(() => {
      const body = document.body ? (document.body.innerText || '') : ''
      const text = body.replace(/\\n{3,}/g, '\\n\\n').trim()
      return { url: location.href, title: document.title, text: text.slice(0, ${TEXT_LIMIT + 1}), total: text.length }
    })()`

    const result = await this.send<{ result?: { value?: PageText & { total: number } } }>(
      'Runtime.evaluate',
      { expression, contextId, returnByValue: true },
      target.sessionId!,
      SNAPSHOT_TIMEOUT_MS,
      signal,
    )
    const value = result.result?.value
    if (!value) throw new Error('the page returned no text')
    return {
      url: value.url,
      title: value.title,
      text: value.text.slice(0, TEXT_LIMIT),
      truncated: value.total > TEXT_LIMIT,
    }
  }

  /** A picture of the viewport, for the pages whose content is only pixels. */
  async screenshot(signal: AbortSignal): Promise<string> {
    await this.start()
    const target = await this.drivePage(signal)
    const result = await this.send<{ data: string }>(
      'Page.captureScreenshot',
      { format: 'jpeg', quality: 72, captureBeyondViewport: false },
      target.sessionId!,
      SNAPSHOT_TIMEOUT_MS,
      signal,
    )
    return result.data
  }

  /**
   * Streams the page as JPEG frames, for a surface that draws the browser live.
   *
   * One screencast per session: the first watcher starts it and every frame is
   * acknowledged, which is what keeps Chrome sending the next one. A frame the
   * surface dropped must not stall the stream, so the ack is not waited on.
   */
  async startScreencast(onFrame: (frame: Buffer) => void): Promise<void> {
    await this.start()
    if (this.screencast) return
    const target = await this.drivePage(new AbortController().signal)
    const sessionId = target.sessionId
    if (!sessionId) throw new Error('the browser has no page to show')
    // Two watchers can reach here together; the second finds the first's stream
    // already up and rides it instead of starting a second.
    if (this.screencast) return
    const off = this.connection!.on('Page.screencastFrame', (params, eventSession) => {
      if (eventSession !== sessionId) return
      if (typeof params.data === 'string') onFrame(Buffer.from(params.data, 'base64'))
      const frameSession = params.sessionId
      if (typeof frameSession === 'number') {
        void this.connection
          ?.send('Page.screencastFrameAck', { sessionId: frameSession }, { sessionId, timeoutMs: ACT_TIMEOUT_MS })
          .catch(() => undefined)
      }
    })
    this.screencast = { off, sessionId }
    try {
      await this.send(
        'Page.startScreencast',
        { format: 'jpeg', quality: SCREENCAST_QUALITY, everyNthFrame: 1 },
        sessionId,
        HANDSHAKE_TIMEOUT_MS,
      )
    } catch (error) {
      this.screencast = null
      off()
      throw error
    }
  }

  /** Stops the live view, if one is running. Safe to call when none is. */
  stopScreencast(): void {
    const active = this.screencast
    if (!active) return
    this.screencast = null
    active.off()
    void this.connection
      ?.send('Page.stopScreencast', {}, { sessionId: active.sessionId, timeoutMs: ACT_TIMEOUT_MS })
      .catch(() => undefined)
  }

  /** Whether a live view is running. */
  get isStreaming(): boolean {
    return this.screencast !== null
  }

  /**
   * A pointer event the person made in the live view, at a point normalized to
   * the viewport (0..1) so the surface does not have to know its pixel size.
   */
  async pointer(kind: 'click' | 'move' | 'down' | 'up', nx: number, ny: number, signal: AbortSignal): Promise<void> {
    await this.start()
    const target = await this.drivePage(signal)
    const sessionId = target.sessionId
    if (!sessionId) throw new Error('the browser has no page to act on')
    const point = this.atPoint(nx, ny)
    if (kind === 'click') {
      await this.click(point, 1, sessionId, signal)
      return
    }
    const type = kind === 'move' ? 'mouseMoved' : kind === 'down' ? 'mousePressed' : 'mouseReleased'
    await this.dispatchMouse(type, point, kind === 'move' ? 0 : 1, sessionId, signal)
  }

  /** A wheel the person turned in the live view. */
  async wheel(nx: number, ny: number, deltaY: number, signal: AbortSignal): Promise<void> {
    await this.start()
    const target = await this.drivePage(signal)
    const sessionId = target.sessionId
    if (!sessionId) throw new Error('the browser has no page to act on')
    const point = this.atPoint(nx, ny)
    await this.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY },
      sessionId,
      ACT_TIMEOUT_MS,
      signal,
    )
  }

  /** A key the person pressed in the live view, sent to whatever has focus. */
  async key(key: string, signal: AbortSignal): Promise<void> {
    await this.start()
    const target = await this.drivePage(signal)
    if (!target.sessionId) throw new Error('the browser has no page to act on')
    await this.pressKey(key, target.sessionId, signal)
  }

  /** Text the person typed in the live view, inserted into whatever has focus. */
  async typeText(text: string, signal: AbortSignal): Promise<void> {
    await this.start()
    const target = await this.drivePage(signal)
    if (!target.sessionId) throw new Error('the browser has no page to act on')
    await this.send('Input.insertText', { text }, target.sessionId, ACT_TIMEOUT_MS, signal)
  }

  /** A normalized point, clamped to the page, in the viewport's own pixels. */
  private atPoint(nx: number, ny: number): { x: number; y: number } {
    const clamp = (value: number): number => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0))
    return { x: clamp(nx) * VIEWPORT.width, y: clamp(ny) * VIEWPORT.height }
  }

  /**
   * Performs one action and, unless told otherwise, hands back the page as it
   * is afterwards. A fresh look in the same call is what keeps a task at one
   * round trip per action instead of two.
   */
  async act(
    request: ActRequest,
    signal: AbortSignal,
    options: { observe?: boolean } = {},
  ): Promise<{ note: string; observation?: Observation }> {
    await this.start()
    const target = await this.drivePage(signal)

    const note = await this.performReportingAReplacedPage(request, target, signal)
    if (options.observe === false) return { note }
    await sleep(SETTLE_MS)
    const observation = await this.observe(signal)
    return { note, observation }
  }

  private async perform(request: ActRequest, target: TargetState, signal: AbortSignal): Promise<string> {
    if (request.action === 'scroll') {
      await this.scroll(request, target, signal)
      return `scrolled ${request.direction}`
    }
    if (request.action === 'press' && !request.ref) {
      await this.pressKey(request.key, target.sessionId!, signal)
      return `pressed ${request.key}`
    }

    const ref = (request as { ref?: string }).ref
    if (!ref) throw new Error('an action on an element needs the ref the last look gave it')
    const owner = this.refs.get(ref)
    if (!owner || owner.nonce !== this.nonce) throw new Error(refFromEarlierLook(ref))

    const handle = await this.handleFor(ref, owner, signal)
    // Still the look we are using, but the element behind the ref has gone: the
    // page moved under us, which is not the same thing as a ref out of date.
    if (!handle) throw new Error(refGone(ref))
    const lookup = refExpression(owner.nonce, ref)

    switch (request.action) {
      case 'click':
      case 'double_click': {
        await this.scrollIntoView(handle, owner, signal)
        const point = await this.pointFor(handle, owner, signal)
        await this.click(point, request.action === 'double_click' ? 2 : 1, owner.sessionId, signal)
        return `${request.action === 'double_click' ? 'double-clicked' : 'clicked'} ${ref}`
      }
      case 'hover': {
        await this.scrollIntoView(handle, owner, signal)
        const point = await this.pointFor(handle, owner, signal)
        await this.dispatchMouse('mouseMoved', point, 0, owner.sessionId, signal)
        return `hovered ${ref}`
      }
      case 'type': {
        if (request.replace) await this.evaluate(`(${SELECT_SOURCE})(${lookup})`, owner, signal)
        await this.send('DOM.focus', { objectId: handle.objectId }, owner.sessionId, ACT_TIMEOUT_MS, signal)
        await this.send('Input.insertText', { text: request.text }, owner.sessionId, ACT_TIMEOUT_MS, signal)
        return `typed into ${ref}`
      }
      case 'select': {
        const chosen = await this.evaluate(
          `(${CHOOSE_SOURCE})(${lookup}, ${JSON.stringify(request.text)})`,
          owner,
          signal,
        )
        if (chosen === false) throw new Error(`no option matching "${request.text}" in ${ref}`)
        return `selected "${request.text}" in ${ref}`
      }
      case 'upload': {
        const backendNodeId = await this.backendNodeFor(handle, owner, signal)
        await this.send('DOM.setFileInputFiles', { files: [request.path], backendNodeId }, owner.sessionId, ACT_TIMEOUT_MS, signal)
        return `uploaded ${request.path} into ${ref}`
      }
      case 'press': {
        await this.send('DOM.focus', { objectId: handle.objectId }, owner.sessionId, ACT_TIMEOUT_MS, signal)
        // In the element's own session: a frame is a target of its own, and a key
        // sent to the page would go to whatever has focus out there instead.
        await this.pressKey(request.key, owner.sessionId, signal)
        return `pressed ${request.key} in ${ref}`
      }
    }
  }

  /**
   * An action, with the one failure that is nobody's mistake reported as itself:
   * the frame's realm can die between the look that minted a ref and the action
   * that uses it — a navigation, or a page that reloads itself to run a security
   * check. Called a ref the model got wrong, it sent the model round the same
   * loop, clicking at a page that was never going to answer.
   */
  private async performReportingAReplacedPage(
    request: ActRequest,
    target: TargetState,
    signal: AbortSignal,
  ): Promise<string> {
    try {
      return await this.perform(request, target, signal)
    } catch (error) {
      throw isPageGoneError(error) ? new Error(pageReplaced()) : error
    }
  }

  private async launch(): Promise<void> {
    if (this.options.cdpUrl) {
      const wsUrl = await attachUrl(this.options.cdpUrl)
      this.endpoint = wsUrl
      this.binary = `attached to ${this.options.cdpUrl}`
      this.connection = await CdpConnection.connect(wsUrl, CONNECT_TIMEOUT_MS)
      this.mode = 'attached'
    } else {
      const chromePath = await findChrome(this.options.chromePath)
      if (!chromePath) {
        throw new Error(
          'no Chrome or Chromium found — install one from the Browser section of `milo setup`' +
            (process.platform === 'linux' ? ' (or `apt install chromium`)' : ''),
        )
      }
      const { handle, stop } = await launchChrome({
        chromePath,
        profileDir: this.options.profileDir,
        headless: this.options.headless !== false,
      })
      this.stopChrome = stop
      this.endpoint = handle.wsUrl
      this.binary = chromePath
      this.connection = await CdpConnection.connect(handle.wsUrl, CONNECT_TIMEOUT_MS)
      this.mode = 'owned'
    }

    this.wireEvents()
    // Knowing what pages exist is what lets an owned browser use the one it
    // started with, instead of opening a second one beside it.
    await this.send('Target.setDiscoverTargets', { discover: true }, undefined, HANDSHAKE_TIMEOUT_MS).catch(
      () => undefined,
    )
    try {
      const version = await this.send<{ product: string }>(
        'Browser.getVersion',
        {},
        undefined,
        HANDSHAKE_TIMEOUT_MS,
      )
      this.version = version.product
    } catch {
      // A version is nice to report and never worth failing a session over.
    }
  }

  private wireEvents(): void {
    const connection = this.connection!
    connection.on('Target.targetCreated', (params) => this.trackTarget(params, false))
    connection.on('Target.targetInfoChanged', (params) => this.trackTarget(params, true))
    connection.on('Target.attachedToTarget', (params, parentSessionId) => {
      const sessionId = params.sessionId
      const info = params.targetInfo as { targetId?: string; type?: string; url?: string } | undefined
      if (typeof sessionId !== 'string' || !info?.targetId) return
      const state = this.targets.get(info.targetId) ?? {
        targetId: info.targetId,
        sessionId: null,
        type: info.type ?? 'unknown',
        url: info.url ?? '',
        contexts: new Map<number, string>(),
        mainFrameId: null,
        nested: false,
      }
      state.sessionId = sessionId
      state.type = info.type ?? state.type
      state.url = info.url ?? state.url
      // Attached by a page of ours rather than by the browser: this is a frame.
      state.nested = Boolean(parentSessionId)
      this.targets.set(info.targetId, state)
      // Every domain it enables is caught inside, so this cannot reject — and it
      // must not be awaited here, or one slow frame would stall the event loop
      // that is still delivering the rest of the page's targets.
      void this.enableTarget(state)
    })
    connection.on('Target.detachedFromTarget', (params) => {
      const sessionId = params.sessionId
      if (typeof sessionId !== 'string') return
      for (const state of this.targets.values()) {
        if (state.sessionId !== sessionId) continue
        state.sessionId = null
        state.contexts.clear()
      }
    })

    connection.on('Runtime.executionContextCreated', (params, sessionId) => {
      const context = params.context as
        | { id?: number; auxData?: { isDefault?: boolean; frameId?: string } }
        | undefined
      if (!sessionId || typeof context?.id !== 'number') return
      if (!context.auxData?.isDefault || !context.auxData.frameId) return
      const state = this.bySession(sessionId)
      if (!state) return
      state.contexts.set(context.id, context.auxData.frameId)
    })
    connection.on('Runtime.executionContextDestroyed', (params, sessionId) => {
      const id = params.executionContextId
      if (!sessionId || typeof id !== 'number') return
      this.bySession(sessionId)?.contexts.delete(id)
    })
    connection.on('Runtime.executionContextsCleared', (_params, sessionId) => {
      if (!sessionId) return
      this.bySession(sessionId)?.contexts.clear()
    })

    connection.on('Page.frameNavigated', (params, sessionId) => {
      const frame = params.frame as { id?: string; parentId?: string; url?: string } | undefined
      if (!sessionId || !frame?.id) return
      const state = this.bySession(sessionId)
      if (!state) return
      if (!frame.parentId) {
        state.mainFrameId = frame.id
        state.url = frame.url ?? state.url
      }
    })
    connection.on('Page.loadEventFired', (_params, sessionId) => {
      if (!sessionId) return
      this.lastNetworkActivity.set(sessionId, Date.now())
      this.fire(this.loadWaiters, sessionId)
    })
    connection.on('Page.domContentEventFired', (_params, sessionId) => {
      if (!sessionId) return
      this.fire(this.domWaiters, sessionId)
    })

    connection.on('Network.requestWillBeSent', (_params, sessionId) => {
      if (!sessionId) return
      this.inflight.set(sessionId, (this.inflight.get(sessionId) ?? 0) + 1)
      this.lastNetworkActivity.set(sessionId, Date.now())
    })
    for (const done of ['Network.loadingFinished', 'Network.loadingFailed']) {
      connection.on(done, (_params, sessionId) => {
        if (!sessionId) return
        this.inflight.set(sessionId, Math.max(0, (this.inflight.get(sessionId) ?? 1) - 1))
        this.lastNetworkActivity.set(sessionId, Date.now())
      })
    }
  }

  private async enableTarget(state: TargetState): Promise<void> {
    const sessionId = state.sessionId
    if (!sessionId) return
    const domains = ['Runtime.enable', 'Page.enable', 'DOM.enable', 'Network.enable']
    for (const method of domains) {
      await this.send(method, {}, sessionId, HANDSHAKE_TIMEOUT_MS).catch((error) => {
        logDebug(`browser: ${method} failed on ${state.type}: ${errorMessage(error)}`)
      })
    }
    if (state.type === 'page') {
      await this.send(
        'Emulation.setDeviceMetricsOverride',
        { ...VIEWPORT, deviceScaleFactor: 1, mobile: false },
        sessionId,
        HANDSHAKE_TIMEOUT_MS,
      ).catch(() => undefined)
    }
  }

  /** Tracks a target the browser told us about, without attaching to it. */
  private trackTarget(params: Record<string, unknown>, existing: boolean): void {
    const info = params.targetInfo as { targetId?: string; type?: string; url?: string } | undefined
    if (!info?.targetId) return
    const state = this.targets.get(info.targetId)
    if (!state) {
      if (existing) return
      this.targets.set(info.targetId, {
        targetId: info.targetId,
        sessionId: null,
        type: info.type ?? 'unknown',
        url: info.url ?? '',
        contexts: new Map<number, string>(),
        mainFrameId: null,
        nested: false,
      })
      return
    }
    state.type = info.type ?? state.type
    state.url = info.url ?? state.url
  }

  /**
   * The page Milo drives, attached. Only this page and the frames inside it are
   * ever touched: attaching the browser to every target would, on a browser
   * somebody is already using, reach into their other tabs.
   */
  private async drivePage(signal: AbortSignal): Promise<TargetState> {
    await this.start()
    const attached = this.pageTargetId ? this.targets.get(this.pageTargetId) : undefined
    if (attached?.sessionId) return attached

    // A browser of our own opened empty, so the page it started with is the one
    // to use. A browser somebody is already in is not: opening a tab is the
    // polite move there, and taking their current one is not.
    const reusable = this.mode === 'owned' ? await this.firstPage(signal) : undefined
    const targetId =
      reusable?.targetId ??
      (
        await this.send<{ targetId: string }>(
          'Target.createTarget',
          { url: 'about:blank' },
          undefined,
          HANDSHAKE_TIMEOUT_MS,
        )
      ).targetId

    const state: TargetState = this.targets.get(targetId) ?? {
      targetId,
      sessionId: null,
      type: 'page',
      url: 'about:blank',
      contexts: new Map<number, string>(),
      mainFrameId: null,
      nested: false,
    }
    this.targets.set(targetId, state)
    this.pageTargetId = targetId

    if (!state.sessionId) {
      const session = await this.send<{ sessionId: string }>(
        'Target.attachToTarget',
        { targetId, flatten: true },
        undefined,
        HANDSHAKE_TIMEOUT_MS,
        signal,
      )
      state.sessionId = session.sessionId
      // Auto-attach lives on the page itself, so the frames inside it arrive as
      // sessions of their own and no other tab is ever attached to.
      await this.send(
        'Target.setAutoAttach',
        { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
        session.sessionId,
        HANDSHAKE_TIMEOUT_MS,
      ).catch(() => undefined)
      await this.enableTarget(state)
    }
    return state
  }

  /** A page target the browser already had, if one shows up quickly. */
  private async firstPage(signal: AbortSignal): Promise<TargetState | undefined> {
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      if (signal.aborted) return undefined
      for (const state of this.targets.values()) {
        if (state.type === 'page' && !state.nested && !state.sessionId) return state
      }
      await sleep(50)
    }
    return undefined
  }

  /**
   * Every realm worth reading, which is the page's own plus every frame nested
   * inside it. A target attached by the browser rather than by that page is
   * somebody else's tab and is left alone.
   */
  private realms(): { sessionId: string; contextId: number; frameId: string; title: string }[] {
    const realms: { sessionId: string; contextId: number; frameId: string; title: string }[] = []
    let index = 1
    for (const state of this.targets.values()) {
      if (!state.sessionId) continue
      if (state.targetId !== this.pageTargetId && !state.nested) continue
      for (const [contextId, frameId] of state.contexts) {
        realms.push({
          sessionId: state.sessionId,
          contextId,
          frameId,
          title: frameId === state.mainFrameId ? 'main' : `frame ${index++}`,
        })
      }
    }
    return realms
  }

  private mainContext(state: TargetState): number | null {
    for (const [contextId, frameId] of state.contexts) {
      if (frameId === state.mainFrameId) return contextId
    }
    const first = state.contexts.keys().next()
    return first.done ? null : first.value
  }

  private bySession(sessionId: string): TargetState | undefined {
    for (const state of this.targets.values()) {
      if (state.sessionId === sessionId) return state
    }
    return undefined
  }

  private loadSettled(sessionId: string): Promise<void> {
    return this.settled(this.loadWaiters, sessionId)
  }

  private domSettled(sessionId: string): Promise<void> {
    return this.settled(this.domWaiters, sessionId)
  }

  /**
   * Resolves on the event, or on a timeout — never rejects. A navigation that
   * came back with no error but a slow load still leaves a page worth looking
   * at, and failing here would throw that away.
   */
  private settled(waiters: Map<string, Set<() => void>>, sessionId: string): Promise<void> {
    return new Promise((resolve) => {
      const set = waiters.get(sessionId) ?? new Set<() => void>()
      const done = () => {
        clearTimeout(timer)
        set.delete(done)
        resolve()
      }
      const timer = setTimeout(done, OPEN_TIMEOUT_MS)
      set.add(done)
      waiters.set(sessionId, set)
    })
  }

  private fire(waiters: Map<string, Set<() => void>>, sessionId: string): void {
    const set = waiters.get(sessionId)
    if (!set) return
    for (const done of [...set]) done()
  }

  /** Waits until nothing has been in flight for a moment — an SPA has settled. */
  private async networkIdle(sessionId: string): Promise<void> {
    const deadline = Date.now() + OPEN_TIMEOUT_MS
    while (Date.now() < deadline) {
      const busy = (this.inflight.get(sessionId) ?? 0) > 0
      const quiet = Date.now() - (this.lastNetworkActivity.get(sessionId) ?? 0)
      if (!busy && quiet >= NETWORK_IDLE_MS) return
      await sleep(50)
    }
  }

  private async handleFor(
    ref: string,
    owner: RefOwner,
    signal: AbortSignal,
  ): Promise<{ objectId: string } | null> {
    const result = await this.send<{ result?: { objectId?: string; subtype?: string } }>(
      'Runtime.evaluate',
      { expression: refExpression(owner.nonce, ref), contextId: owner.contextId },
      owner.sessionId,
      ACT_TIMEOUT_MS,
      signal,
    )
    const objectId = result.result?.objectId
    return objectId ? { objectId } : null
  }

  /** Puts the element in view: input lands on the viewport, not on the page. */
  private async scrollIntoView(handle: { objectId: string }, owner: RefOwner, signal: AbortSignal): Promise<void> {
    await this.send(
      'Runtime.callFunctionOn',
      {
        objectId: handle.objectId,
        functionDeclaration: 'function () { this.scrollIntoView({ block: "center", inline: "center" }) }',
        returnByValue: true,
      },
      owner.sessionId,
      ACT_TIMEOUT_MS,
      signal,
    ).catch(() => undefined)
  }

  /** Where the element is, in the coordinate space its own session dispatches in. */
  private async pointFor(
    handle: { objectId: string },
    owner: RefOwner,
    signal: AbortSignal,
  ): Promise<{ x: number; y: number }> {
    const backendNodeId = await this.backendNodeFor(handle, owner, signal)
    const quads = await this.send<{ quads?: number[][] }>(
      'DOM.getContentQuads',
      { backendNodeId },
      owner.sessionId,
      ACT_TIMEOUT_MS,
      signal,
    )
    const quad = quads.quads?.[0]
    if (!quad || quad.length < 8) throw new Error('the element has no position on the page — take a fresh look')
    const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!]
    const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!]
    const x = (Math.min(...xs) + Math.max(...xs)) / 2
    const y = (Math.min(...ys) + Math.max(...ys)) / 2
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error('the element has no usable position — take a fresh look')
    }
    return { x, y }
  }

  private async backendNodeFor(
    handle: { objectId: string },
    owner: RefOwner,
    signal: AbortSignal,
  ): Promise<number> {
    const described = await this.send<{ node?: { backendNodeId?: number } }>(
      'DOM.describeNode',
      { objectId: handle.objectId },
      owner.sessionId,
      ACT_TIMEOUT_MS,
      signal,
    )
    const backendNodeId = described.node?.backendNodeId
    if (!backendNodeId) throw new Error('the element could not be found on the page — take a fresh look')
    return backendNodeId
  }

  private async click(
    point: { x: number; y: number },
    clickCount: number,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<void> {
    await this.dispatchMouse('mouseMoved', point, 0, sessionId, signal)
    await this.dispatchMouse('mousePressed', point, clickCount, sessionId, signal)
    await this.dispatchMouse('mouseReleased', point, clickCount, sessionId, signal)
  }

  private dispatchMouse(
    type: string,
    point: { x: number; y: number },
    clickCount: number,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    return this.send(
      'Input.dispatchMouseEvent',
      {
        type,
        x: point.x,
        y: point.y,
        button: 'left',
        buttons: type === 'mousePressed' ? 1 : 0,
        clickCount,
      },
      sessionId,
      ACT_TIMEOUT_MS,
      signal,
    )
  }

  private async scroll(
    request: Extract<ActRequest, { action: 'scroll' }>,
    target: TargetState,
    signal: AbortSignal,
  ): Promise<void> {
    const owner = request.ref ? this.refs.get(request.ref) : undefined
    if (request.ref && !owner) throw new Error(refFromEarlierLook(request.ref))
    const expression = `(${SCROLL_SOURCE})(${
      owner ? refExpression(owner.nonce, request.ref!) : 'null'
    }, ${JSON.stringify(request.direction)})`
    const main = this.mainContext(target)
    if (!main) throw new Error('the page has no readable frame — open a URL first')
    const realm = owner ?? { nonce: this.nonce, sessionId: target.sessionId!, contextId: main }
    await this.evaluate(expression, realm, signal)
  }

  private async pressKey(key: string, sessionId: string, signal: AbortSignal): Promise<void> {
    const code = KEY_CODES[key.toLowerCase()]
    const common = {
      key,
      code: code?.code ?? key,
      windowsVirtualKeyCode: code?.keyCode ?? 0,
      nativeVirtualKeyCode: code?.keyCode ?? 0,
      ...(code?.text ? { text: code.text } : {}),
    }
    await this.send(
      'Input.dispatchKeyEvent',
      { type: code?.text ? 'keyDown' : 'rawKeyDown', ...common },
      sessionId,
      ACT_TIMEOUT_MS,
      signal,
    )
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common }, sessionId, ACT_TIMEOUT_MS, signal)
  }

  /** Runs a snippet in a realm and hands back what it returned. */
  private async evaluate(expression: string, owner: RefOwner, signal: AbortSignal): Promise<unknown> {
    const result = await this.send<{
      result?: { value?: unknown }
      exceptionDetails?: { text?: string; exception?: { description?: string } }
    }>(
      'Runtime.evaluate',
      { expression, contextId: owner.contextId, returnByValue: true },
      owner.sessionId,
      ACT_TIMEOUT_MS,
      signal,
    )
    if (result.exceptionDetails) {
      throw new Error(scriptFailure(result.exceptionDetails))
    }
    return result.result?.value
  }

  private send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown>,
    sessionId: string | undefined,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T> {
    const connection = this.connection
    if (!connection) return Promise.reject(new Error('the browser is not running'))
    return connection.send<T>(method, params, { sessionId, timeoutMs, signal })
  }
}

/** Keys worth naming: a name the page's own handlers recognise. */
const KEY_CODES: Record<string, { code: string; keyCode: number; text?: string }> = {
  enter: { code: 'Enter', keyCode: 13, text: '\r' },
  tab: { code: 'Tab', keyCode: 9 },
  escape: { code: 'Escape', keyCode: 27 },
  backspace: { code: 'Backspace', keyCode: 8 },
  delete: { code: 'Delete', keyCode: 46 },
  space: { code: 'Space', keyCode: 32, text: ' ' },
  arrowup: { code: 'ArrowUp', keyCode: 38 },
  arrowdown: { code: 'ArrowDown', keyCode: 40 },
  arrowleft: { code: 'ArrowLeft', keyCode: 37 },
  arrowright: { code: 'ArrowRight', keyCode: 39 },
  pagedown: { code: 'PageDown', keyCode: 34 },
  pageup: { code: 'PageUp', keyCode: 33 },
  home: { code: 'Home', keyCode: 36 },
  end: { code: 'End', keyCode: 35 },
}

/** Selects everything in a field, so typing replaces rather than appends. */
const SELECT_SOURCE = `function (el) { if (el && el.select) el.select() }`

/**
 * Picks an option and lets the page hear about it — a `select` whose value is
 * set without `change` leaves a framework's own state describing the old choice.
 */
const CHOOSE_SOURCE = `function (el, text) {
  if (!el || el.tagName !== 'SELECT') return false
  var want = String(text).trim().toLowerCase()
  var options = el.options || []
  var match = null
  for (var i = 0; i < options.length; i++) {
    var label = (options[i].textContent || '').trim().toLowerCase()
    var value = String(options[i].value || '').toLowerCase()
    if (label === want || value === want) { match = options[i]; break }
  }
  if (!match) {
    for (var j = 0; j < options.length; j++) {
      var partial = (options[j].textContent || '').trim().toLowerCase()
      if (partial && partial.indexOf(want) !== -1) { match = options[j]; break }
    }
  }
  if (!match) return false
  el.value = match.value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return true
}`

/** Scrolls a page or a container, in the direction asked for. */
const SCROLL_SOURCE = `function (el, direction) {
  var target = el
  while (target && target !== document.body && target !== document.documentElement) {
    var style = getComputedStyle(target)
    var scrollable = /(auto|scroll|overlay)/.test(style.overflowY) && target.scrollHeight > target.clientHeight + 8
    if (scrollable) break
    target = target.parentElement
  }
  var container = target && target !== document.body ? target : (document.scrollingElement || document.documentElement)
  if (direction === 'top') { container.scrollTop = 0; return true }
  if (direction === 'bottom') { container.scrollTop = container.scrollHeight; return true }
  var amount = direction === 'up' ? -window.innerHeight : window.innerHeight
  if (container === document.scrollingElement || container === document.documentElement) window.scrollBy(0, amount)
  else container.scrollTop += amount
  return true
}`

/** What a script that threw actually said, rather than just "Uncaught". */
function scriptFailure(details: { text?: string; exception?: { description?: string } }): string {
  const description = details.exception?.description
  if (description) return description.split('\n')[0] ?? description
  return details.text ?? 'script error'
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
