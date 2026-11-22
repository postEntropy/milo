import path from 'node:path'
import { errorMessage } from '../../util/errors.js'
import { hyprlandPluginLimitation, hyprlandRefusalGuidance } from './adapter.js'
import type {
  ComputerActionOutcome,
  ComputerCapabilityStatus,
  ComputerDriverAdapter,
  ComputerFacts,
  ComputerScrollDirection,
  DiscoveredApp,
  DiscoveredWindow,
  RawWindowState,
  WindowElementRef,
  WindowScreenshot,
} from './types.js'

export interface BoundSnapshot {
  captureId: string
  capturedAt: number
  window: DiscoveredWindow
  elements: Map<string, WindowElementRef>
  elementList: WindowElementRef[]
  treeText: string
  observationsText?: string
  degraded: boolean
  degradedReason?: string
  truncated: boolean
  truncationReason?: string
  screenshot?: WindowScreenshot
}

interface TurnLease {
  turnId: string
  sessionId?: string
  window: DiscoveredWindow
  /** Snapshot from the most recent observation; cleared on every action and replaced on every snapshot. */
  snapshot: BoundSnapshot | null
  /** Monotonic ref counter so an earlier ref string can never match a later snapshot. */
  nextRef: number
  revoked: boolean
}

export type OpenTargetResolution =
  | { kind: 'exact'; window: DiscoveredWindow }
  | { kind: 'ambiguous'; candidates: DiscoveredWindow[] }
  | { kind: 'launch'; app: string; launchPath?: string }
  | { kind: 'not_found'; message: string }

export type PendingOpenTarget =
  | { kind: 'exact'; window: DiscoveredWindow }
  | { kind: 'launch'; app: string; launchPath?: string }

export interface PlannedActionCheck {
  ok: true
  window: DiscoveredWindow
  captureId: string | null
  elementRef?: string
  elementToken?: string
  elementRole?: string
  elementLabel?: string
  summary: string
}

export interface PlannedActionFailure {
  ok: false
  error: string
}

export interface ComputerActInput {
  action: 'click' | 'type' | 'press' | 'scroll'
  ref?: string
  x?: number
  y?: number
  captureId?: string
  button?: 'left' | 'right' | 'middle'
  count?: number
  text?: string
  key?: string
  modifiers?: string[]
  direction?: ComputerScrollDirection
  amount?: number
}

export interface ComputerObservationResult {
  window: DiscoveredWindow
  snapshot: BoundSnapshot
  insufficientEvidence?: string
}

export interface ComputerActResult {
  window: DiscoveredWindow
  outcome: ComputerActionOutcome
  snapshot: BoundSnapshot | null
  insufficientEvidence?: string
}

const PASSWORD_PATTERN = /\b(password|passcode|pin|secret|otp|one[- ]time|cvv|cvc|card number)\b/i
const INPUT_ROUTE_REFUSAL_RE = /background|input[_ -]?route|hyprland|wayland|compositor|plugin|unsupported|no[_ -]?route|shortcut|synthetic/i

function isRelevantInputRefusal(outcome: ComputerActionOutcome, input: ComputerActInput): boolean {
  if (outcome.effect !== 'refused') return false
  if (input.action === 'press' || input.action === 'scroll' || (input.action === 'click' && typeof input.x === 'number')) {
    return true
  }
  if (outcome.route !== 'accessibility') return true
  const text = [outcome.errorCode, outcome.error, outcome.summary].filter(Boolean).join(' ')
  return INPUT_ROUTE_REFUSAL_RE.test(text)
}

const EDITABLE_TEXT_ROLES = new Set([
  'text',
  'text box',
  'textbox',
  'entry',
  'text field',
  'textfield',
  'text area',
  'textarea',
  'search box',
  'searchbox',
  'combo box',
  'combobox',
  'spin button',
  'spinbutton',
  'document text',
  'edit',
  'input',
  'terminal',
])

function isEditableTextElement(el: WindowElementRef): boolean {
  if (el.enabled === false) return false
  return EDITABLE_TEXT_ROLES.has(el.role.trim().toLowerCase())
}

function isSensitiveElement(el: WindowElementRef): boolean {
  if (el.isPassword === true) return true
  const role = el.role.toLowerCase()
  if (role.includes('password')) return true
  const label = (el.label ?? '').toLowerCase()
  return PASSWORD_PATTERN.test(label)
}

function windowLabel(win: Pick<DiscoveredWindow, 'appName' | 'title' | 'pid' | 'windowId'>): string {
  const title = win.title.trim() ? `"${win.title.trim()}"` : '(untitled window)'
  return `${title} (${win.appName}, pid ${win.pid}, id ${win.windowId})`
}

function isUserApp(app: DiscoveredApp): boolean {
  if (app.launchPath) return true
  if (app.kind && app.kind !== 'kernel') return true
  if (app.pid <= 2) return false
  if (app.name.startsWith('kworker/') || app.name.startsWith('kthread') || app.name.startsWith('rcu_') || app.name.startsWith('migration/')) {
    return false
  }
  return app.active || app.running
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replace(/\.desktop$/i, '')
}

function executableBasename(launchPath: string | undefined): string | null {
  if (!launchPath?.trim()) return null
  const first = launchPath.trim().split(/\s+/)[0] ?? ''
  if (!first) return null
  return normalizeToken(path.basename(first))
}

/**
 * Checks whether a newly opened window can be confidently associated with the
 * app the person approved for launch. Prevents binding an unrelated window that
 * happens to open first while waiting for the launched app.
 */
function windowMatchesLaunchedApp(
  win: DiscoveredWindow,
  launch: { name: string; launchPath?: string; pid?: number },
): boolean {
  if (launch.pid !== undefined && win.pid === launch.pid) return true
  const app = normalizeToken(win.appName)
  if (!app) return false

  const expected = new Set<string>()
  const normName = normalizeToken(launch.name)
  if (normName) expected.add(normName)
  const base = executableBasename(launch.launchPath)
  if (base) expected.add(base)

  const appLastSegment = app.includes('.') ? app.slice(app.lastIndexOf('.') + 1) : app
  for (const candidate of expected) {
    if (app === candidate || appLastSegment === candidate) return true
    if (candidate.includes('.') && candidate.slice(candidate.lastIndexOf('.') + 1) === appLastSegment) {
      return true
    }
  }
  return false
}

/**
 * Serializes desktop operations across Sessions and enforces Milo's turn-scoped
 * window binding, authorization re-checks, and ref expiry.
 */
export class ComputerManager {
  private readonly adapter: ComputerDriverAdapter
  private cachedStatus: ComputerCapabilityStatus | null = null
  private leases = new Map<string, TurnLease>()
  private pendingOpens = new Map<string, PendingOpenTarget>()
  private pendingActions = new Map<string, PlannedActionCheck>()
  private queue: Promise<void> = Promise.resolve()

  constructor(adapter: ComputerDriverAdapter) {
    this.adapter = adapter
  }

  /** Serializes every desktop operation across all Sessions in FIFO order. */
  private runExclusive<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      if (signal?.aborted) {
        const err = new Error('The turn was stopped before the desktop operation ran.')
        err.name = 'AbortError'
        throw err
      }
      return fn()
    })
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async probe(signal?: AbortSignal, options?: { fresh?: boolean }): Promise<ComputerCapabilityStatus> {
    if (!options?.fresh && this.cachedStatus) return this.cachedStatus
    const status = await this.adapter.probe(signal)
    this.cachedStatus = status
    return status
  }

  facts(turnId?: string): ComputerFacts {
    const status: ComputerCapabilityStatus = this.cachedStatus ?? {
      available: false,
      platform: process.platform,
      sdkVersion: null,
      displayServer: 'none',
      waylandEnabled: false,
      atspiAvailable: false,
      screenCaptureAvailable: false,
      inputModes: { accessibility: false, windowScopedPointer: false, xsendEvent: false, hyprlandPlugin: false },
      limitations: [],
      summary: 'Not probed yet',
    }
    const lease = turnId ? this.leases.get(turnId) : undefined
    return {
      enabled: true,
      status,
      boundWindow:
        lease && !lease.revoked
          ? {
              appName: lease.window.appName,
              title: lease.window.title,
              pid: lease.window.pid,
              windowId: lease.window.windowId,
            }
          : null,
    }
  }

  /** Records the exact resolved target shown in the approval dialog so execution binds only what was approved. */
  stagePendingOpen(turnId: string, target: PendingOpenTarget): void {
    this.pendingOpens.set(turnId, target)
  }

  /** Consumes the staged open target for `turnId`, if any. */
  takePendingOpen(turnId: string): PendingOpenTarget | undefined {
    const target = this.pendingOpens.get(turnId)
    this.pendingOpens.delete(turnId)
    return target
  }

  /** Records the exact planned action shown in the approval dialog for post-approval revalidation. */
  stagePendingAction(turnId: string, planned: PlannedActionCheck): void {
    this.pendingActions.set(turnId, planned)
  }

  /** Consumes the staged action for `turnId`, if any. */
  takePendingAction(turnId: string): PlannedActionCheck | undefined {
    const planned = this.pendingActions.get(turnId)
    this.pendingActions.delete(turnId)
    return planned
  }

  /** Invalidates any desktop window access held by `turnId` (on turn end or stop). */
  releaseTurn(turnId: string): void {
    this.pendingOpens.delete(turnId)
    this.pendingActions.delete(turnId)
    const lease = this.leases.get(turnId)
    if (!lease) return
    lease.revoked = true
    lease.snapshot = null
    this.leases.delete(turnId)
  }

  /** Reads the currently bound window for a turn, if still authorized. */
  boundWindow(turnId: string): DiscoveredWindow | null {
    const lease = this.leases.get(turnId)
    if (!lease || lease.revoked) return null
    return lease.window
  }

  async list(
    query: string | undefined,
    signal?: AbortSignal,
  ): Promise<{ ok: true; status: ComputerCapabilityStatus; windows: DiscoveredWindow[]; apps: DiscoveredApp[] } | { ok: false; error: string }> {
    return this.runExclusive(signal, async () => {
      const status = await this.probe(signal)
      if (!status.available) {
        return { ok: false, error: status.reason ?? `Computer Use is unavailable: ${status.summary}` }
      }
      const [allWindows, allApps] = await Promise.all([
        this.adapter.listWindows(signal),
        this.adapter.listApps(signal),
      ])
      const needle = query?.trim().toLowerCase()
      const windows = needle
        ? allWindows.filter(
            (w) =>
              w.appName.toLowerCase().includes(needle) ||
              w.title.toLowerCase().includes(needle) ||
              w.windowId === needle ||
              String(w.pid) === needle,
          )
        : allWindows

      const seenApps = new Set<string>()
      const apps: DiscoveredApp[] = []
      for (const app of allApps) {
        if (!isUserApp(app)) continue
        if (needle && !app.name.toLowerCase().includes(needle) && !(app.launchPath?.toLowerCase().includes(needle))) {
          continue
        }
        const key = `${app.name.toLowerCase()}:${app.launchPath ?? ''}`
        if (seenApps.has(key)) continue
        seenApps.add(key)
        apps.push(app)
        if (apps.length >= 40) break
      }

      return { ok: true, status, windows, apps }
    })
  }

  /**
   * Resolves a `computer_open` target BEFORE prompting the user so the approval
   * dialog names the exact window (or catches ambiguity before asking).
   */
  async resolveOpenTarget(
    args: { windowId?: string; pid?: number; app?: string; launch?: boolean },
    signal?: AbortSignal,
  ): Promise<OpenTargetResolution> {
    return this.runExclusive(signal, async () => {
      const status = await this.probe(signal)
      if (!status.available) {
        return { kind: 'not_found', message: status.reason ?? `Computer Use is unavailable: ${status.summary}` }
      }

      const windows = await this.adapter.listWindows(signal)
      if (args.windowId) {
        const match = windows.find(
          (w) => w.windowId === args.windowId && (args.pid === undefined || w.pid === args.pid),
        )
        if (!match) {
          return {
            kind: 'not_found',
            message: `No open window matched windowId ${args.windowId}${args.pid !== undefined ? ` (pid ${args.pid})` : ''}. Run computer_list to discover current windows.`,
          }
        }
        return { kind: 'exact', window: match }
      }

      const appQuery = args.app?.trim()
      if (!appQuery) {
        return { kind: 'not_found', message: 'Provide either windowId (from computer_list) or app.' }
      }

      const lower = appQuery.toLowerCase()
      const exactMatches = windows.filter(
        (w) => w.appName.toLowerCase() === lower || w.title.toLowerCase() === lower,
      )
      const matches =
        exactMatches.length > 0
          ? exactMatches
          : windows.filter(
              (w) => w.appName.toLowerCase().includes(lower) || w.title.toLowerCase().includes(lower),
            )

      if (matches.length === 1 && !args.launch) {
        return { kind: 'exact', window: matches[0]! }
      }
      if (matches.length > 1 && !args.launch) {
        return { kind: 'ambiguous', candidates: matches }
      }

      const apps = await this.adapter.listApps(signal)
      const matchedApp = apps.find(
        (a) => a.name.toLowerCase() === lower || a.launchPath?.toLowerCase().includes(lower),
      )
      return { kind: 'launch', app: appQuery, ...(matchedApp?.launchPath ? { launchPath: matchedApp.launchPath } : {}) }
    })
  }

  /**
   * Validates and summarizes a planned `computer_act` BEFORE prompting the user,
   * so stale refs or invalid coordinates fail immediately without nagging the user.
   */
  async planAction(
    turnId: string,
    args: ComputerActInput,
    signal?: AbortSignal,
  ): Promise<PlannedActionCheck | PlannedActionFailure> {
    const lease = this.leases.get(turnId)
    if (!lease || lease.revoked) {
      return { ok: false, error: 'No desktop window is authorized for this turn. Call computer_open first.' }
    }
    const win = lease.window
    const targetName = windowLabel(win)
    const snap = lease.snapshot

    if (args.action === 'click') {
      if (args.ref) {
        if (!snap) {
          return { ok: false, error: 'No current snapshot is available. Call computer_snapshot before acting on an element ref.' }
        }
        const el = snap.elements.get(args.ref)
        if (!el) {
          return {
            ok: false,
            error: `Reference "${args.ref}" is stale or unknown (references expire after every snapshot or action). Call computer_snapshot to get fresh refs.`,
          }
        }
        if (isSensitiveElement(el)) {
          return { ok: false, error: `Refused to interact with sensitive/password element ${args.ref}.` }
        }
        const desc = [el.role, el.label ? `"${el.label}"` : ''].filter(Boolean).join(' ')
        const clickKind = args.count && args.count > 1 ? `Double-click` : args.button === 'right' ? 'Right-click' : 'Click'
        return {
          ok: true,
          window: win,
          captureId: snap.captureId,
          elementRef: el.ref,
          ...(el.elementToken ? { elementToken: el.elementToken } : {}),
          elementRole: el.role,
          ...(el.label ? { elementLabel: el.label } : {}),
          summary: `${clickKind} ${desc || el.ref} (${el.ref}) in ${targetName}`,
        }
      }
      if (typeof args.x === 'number' && typeof args.y === 'number') {
        const check = await this.validatePixelCoords(snap, args.x, args.y, args.captureId, signal)
        if (!check.ok) return check
        const clickKind = args.count && args.count > 1 ? `Double-click` : args.button === 'right' ? 'Right-click' : 'Click'
        return {
          ok: true,
          window: win,
          captureId: snap!.captureId,
          summary: `${clickKind} at (${Math.round(args.x)}, ${Math.round(args.y)}) in ${targetName}`,
        }
      }
      return { ok: false, error: 'click requires either an element ref from the latest snapshot or pixel coordinates (x, y) with capture_id from the latest screenshot.' }
    }

    if (args.action === 'type') {
      if (!args.text) return { ok: false, error: 'type requires non-empty text.' }
      const ref = args.ref?.trim() ?? ''
      if (!ref) {
        return {
          ok: false,
          error: 'type requires a current editable element ref from the latest snapshot. Call computer_snapshot and pass ref.',
        }
      }
      if (!snap) {
        return { ok: false, error: 'No current snapshot is available. Call computer_snapshot before acting on an element ref.' }
      }
      const el = snap.elements.get(ref)
      if (!el) {
        return {
          ok: false,
          error: `Reference "${ref}" is stale or unknown (references expire after every snapshot or action). Call computer_snapshot to get fresh refs.`,
        }
      }
      if (isSensitiveElement(el)) {
        return { ok: false, error: `Refused to type into sensitive/password element ${ref}.` }
      }
      if (!isEditableTextElement(el)) {
        return {
          ok: false,
          error: `Refused to type into non-editable element ${el.ref} (${el.role}${el.label ? ` "${el.label}"` : ''}). Approval for type is scoped to editable text fields.`,
        }
      }
      const preview = args.text.length > 60 ? `${args.text.slice(0, 57)}...` : args.text
      const targetEl = ` into ${el.role}${el.label ? ` "${el.label}"` : ''} (${el.ref})`
      return {
        ok: true,
        window: win,
        captureId: snap.captureId,
        elementRef: el.ref,
        elementRole: el.role,
        ...(el.elementToken ? { elementToken: el.elementToken } : {}),
        ...(el.label ? { elementLabel: el.label } : {}),
        summary: `Type "${preview}"${targetEl} in ${targetName}`,
      }
    }

    if (args.action === 'press') {
      if (!args.key?.trim()) return { ok: false, error: 'press requires a key name (for example "Return", "Tab", or "Escape").' }
      const combo = args.modifiers && args.modifiers.length > 0 ? `${args.modifiers.join('+')}+${args.key}` : args.key
      return { ok: true, window: win, captureId: snap?.captureId ?? null, summary: `Press ${combo} in ${targetName}` }
    }

    if (args.action === 'scroll') {
      if (!args.direction) return { ok: false, error: 'scroll requires a direction (up, down, left, or right).' }
      if (typeof args.x === 'number' && typeof args.y === 'number') {
        const check = await this.validatePixelCoords(snap, args.x, args.y, args.captureId, signal)
        if (!check.ok) return check
      }
      return {
        ok: true,
        window: win,
        captureId: snap?.captureId ?? null,
        summary: `Scroll ${args.direction} (${args.amount ?? 3} lines) in ${targetName}`,
      }
    }

    return { ok: false, error: `Unknown computer action "${String((args as { action?: unknown }).action)}".` }
  }

  private async validatePixelCoords(
    snap: BoundSnapshot | null,
    x: number,
    y: number,
    captureId: string | undefined,
    signal?: AbortSignal,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!snap?.screenshot) {
      return {
        ok: false,
        error: 'Pixel actions require a current exact-window screenshot from computer_snapshot (prefer accessibility element refs when available).',
      }
    }
    if (!snap.screenshot.frameValid) {
      return { ok: false, error: 'The latest window capture frame is invalid; pixel coordinates cannot be safely mapped.' }
    }
    if (!captureId?.trim()) {
      return {
        ok: false,
        error: `Pixel actions require capture_id from the current snapshot (current capture is "${snap.captureId}").`,
      }
    }
    if (captureId !== snap.captureId) {
      return {
        ok: false,
        error: `Capture reference "${captureId}" is stale (current capture is "${snap.captureId}"). Call computer_snapshot first.`,
      }
    }
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= snap.screenshot.width || y >= snap.screenshot.height) {
      return {
        ok: false,
        error: `Coordinates (${x}, ${y}) are outside the current window capture (${snap.screenshot.width}x${snap.screenshot.height}).`,
      }
    }
    if (
      this.cachedStatus &&
      !this.cachedStatus.inputModes.windowScopedPointer &&
      !this.cachedStatus.inputModes.xsendEvent &&
      !this.cachedStatus.inputModes.hyprlandPlugin
    ) {
      // Refresh cached status before rejecting so a plugin activated since the last check is seen immediately.
      let latest = this.cachedStatus
      try {
        latest = await this.probe(signal, { fresh: true })
      } catch {
        latest = this.cachedStatus
      }
      if (
        !latest.inputModes.windowScopedPointer &&
        !latest.inputModes.xsendEvent &&
        !latest.inputModes.hyprlandPlugin
      ) {
        const hyprlandReason = latest.hyprlandPluginState
          ? hyprlandPluginLimitation(latest.hyprlandPluginState)
          : null
        return {
          ok: false,
          error:
            hyprlandReason ??
            'The active compositor does not advertise a window-scoped pointer input route. Use accessibility element refs instead.',
        }
      }
    }
    return { ok: true }
  }

  /**
   * Binds an exact authorized window to `turnId` (launching first if requested),
   * re-verifying that the window still exists and matches what the user approved.
   */
  async openWindow(
    options: {
      turnId: string
      sessionId?: string
      expectedWindow?: DiscoveredWindow
      launchApp?: { name: string; launchPath?: string }
      visionConfirmed: boolean
      signal?: AbortSignal
    },
  ): Promise<
    | { ok: true; observation: ComputerObservationResult }
    | { ok: false; error: string; candidates?: DiscoveredWindow[] }
  > {
    return this.runExclusive(options.signal, async () => {
      const status = await this.probe(options.signal)
      if (!status.available) {
        return { ok: false, error: status.reason ?? `Computer Use is unavailable: ${status.summary}` }
      }

      let targetWindow: DiscoveredWindow | undefined

      if (options.launchApp) {
        const before = await this.adapter.listWindows(options.signal)
        const beforeIds = new Set(before.map((w) => w.windowId))
        const launched = await this.adapter.launchApp(
          options.launchApp.launchPath
            ? { launchPath: options.launchApp.launchPath }
            : { name: options.launchApp.name },
          options.signal,
        )
        if (!launched.ok) {
          return { ok: false, error: `Could not launch "${options.launchApp.name}": ${launched.error}` }
        }

        const launchMeta = {
          name: options.launchApp.name,
          launchPath: options.launchApp.launchPath,
          pid: launched.pid,
        }

        // Wait briefly for windows that can be confidently associated with the approved app.
        let associated: DiscoveredWindow[] = []
        let unassociated: DiscoveredWindow[] = []
        for (let attempt = 0; attempt < 15; attempt += 1) {
          if (options.signal?.aborted) {
            return { ok: false, error: 'The turn was stopped while waiting for the application window.' }
          }
          await new Promise((resolve) => setTimeout(resolve, 200))
          const now = await this.adapter.listWindows(options.signal)
          const fresh = now.filter((w) => !beforeIds.has(w.windowId))
          if (fresh.length === 0) continue
          const matched = fresh.filter((w) => windowMatchesLaunchedApp(w, launchMeta))
          if (matched.length > 0) {
            associated = matched
            break
          }
          unassociated = fresh
        }

        if (associated.length === 0) {
          if (unassociated.length > 0) {
            return {
              ok: false,
              error: `Launched "${options.launchApp.name}", but could not associate the newly opened window(s) with that app. Select an exact windowId and request fresh computer_open approval before capturing.`,
              candidates: unassociated,
            }
          }
          return {
            ok: false,
            error: `Launched "${options.launchApp.name}", but no associated desktop window appeared within 3 seconds. Call computer_list to check open windows.`,
          }
        }
        if (associated.length > 1) {
          return {
            ok: false,
            error: `Launching "${options.launchApp.name}" opened ${associated.length} candidate windows. Call computer_open with one exact windowId and obtain fresh approval before capturing.`,
            candidates: associated,
          }
        }
        targetWindow = associated[0]
      } else if (options.expectedWindow) {
        const live = await this.adapter.listWindows(options.signal)
        const current = live.find(
          (w) => w.windowId === options.expectedWindow!.windowId && w.pid === options.expectedWindow!.pid,
        )
        if (!current) {
          return {
            ok: false,
            error: `Window ${windowLabel(options.expectedWindow)} closed or disappeared while approval was pending.`,
          }
        }
        if (current.appName !== options.expectedWindow.appName || current.title !== options.expectedWindow.title) {
          return {
            ok: false,
            error: `Window changed while approval was pending (expected ${windowLabel(options.expectedWindow)}, found ${windowLabel(current)}). Re-confirm with computer_open.`,
          }
        }
        targetWindow = current
      }

      if (!targetWindow) {
        return { ok: false, error: 'No target window was resolved.' }
      }

      const lease: TurnLease = {
        turnId: options.turnId,
        sessionId: options.sessionId,
        window: targetWindow,
        snapshot: null,
        nextRef: 1,
        revoked: false,
      }
      this.leases.set(options.turnId, lease)

      const observation = await this.captureForLease(lease, status, options.visionConfirmed, options.signal)
      return { ok: true, observation }
    })
  }

  async snapshot(
    options: { turnId: string; includeScreenshot?: boolean; visionConfirmed: boolean; signal?: AbortSignal },
  ): Promise<{ ok: true; observation: ComputerObservationResult } | { ok: false; error: string }> {
    return this.runExclusive(options.signal, async () => {
      const check = await this.verifyLeaseAndWindow(options.turnId, options.signal)
      if (!check.ok) return check
      const { lease, status } = check
      const wantShot = options.includeScreenshot !== false && options.visionConfirmed
      const observation = await this.captureForLease(lease, status, wantShot, options.signal)
      return { ok: true, observation }
    })
  }

  async act(
    options: { turnId: string; input: ComputerActInput; visionConfirmed: boolean; signal?: AbortSignal },
  ): Promise<{ ok: true; result: ComputerActResult } | { ok: false; error: string }> {
    return this.runExclusive(options.signal, async () => {
      const staged = this.takePendingAction(options.turnId)
      const check = await this.verifyLeaseAndWindow(options.turnId, options.signal, staged?.window)
      if (!check.ok) return check
      const { lease, status, liveWindow } = check

      // Re-validate planned action against the current snapshot before dispatch.
      const planned = await this.planAction(options.turnId, options.input, options.signal)
      if (!planned.ok) return planned

      // If an approval was staged, verify the snapshot and resolved element did not drift while approval was pending.
      if (staged) {
        if (staged.captureId !== null && planned.captureId !== staged.captureId) {
          return {
            ok: false,
            error: `Snapshot changed while approval was pending (approved capture "${staged.captureId}", current "${planned.captureId ?? 'none'}"). Call computer_snapshot and re-approve.`,
          }
        }
        if (staged.elementRef && (planned.elementToken !== staged.elementToken || planned.elementLabel !== staged.elementLabel)) {
          return {
            ok: false,
            error: `Target element ${staged.elementRef} changed while approval was pending. Call computer_snapshot and re-approve.`,
          }
        }
      }

      const prevSnapshot = lease.snapshot
      const trimmedRef = options.input.ref?.trim()
      const resolvedElement = trimmedRef && prevSnapshot ? prevSnapshot.elements.get(trimmedRef) : undefined

      // Expire all action references immediately before dispatching the action.
      lease.snapshot = null

      let outcome: ComputerActionOutcome
      try {
        if (options.input.action === 'click') {
          if (resolvedElement) {
            if (resolvedElement.elementToken) {
              outcome = await this.adapter.clickElement(
                liveWindow,
                resolvedElement.elementToken,
                { button: options.input.button, count: options.input.count },
                options.signal,
              )
            } else if (resolvedElement.frame && prevSnapshot?.screenshot?.frameValid) {
              const cx = Math.round(resolvedElement.frame.x + resolvedElement.frame.width / 2)
              const cy = Math.round(resolvedElement.frame.y + resolvedElement.frame.height / 2)
              outcome = await this.adapter.clickCoordinates(
                liveWindow,
                cx,
                cy,
                prevSnapshot.captureId,
                { button: options.input.button, count: options.input.count },
                options.signal,
              )
            } else {
              return {
                ok: false,
                error: `Element ${resolvedElement.ref} has no accessibility action token and no valid capture coordinates.`,
              }
            }
          } else {
            outcome = await this.adapter.clickCoordinates(
              liveWindow,
              Math.round(options.input.x!),
              Math.round(options.input.y!),
              options.input.captureId!,
              { button: options.input.button, count: options.input.count },
              options.signal,
            )
          }
        } else if (options.input.action === 'type') {
          if (!resolvedElement) {
            return {
              ok: false,
              error: 'type requires a current editable element ref from the latest snapshot. Call computer_snapshot and pass ref.',
            }
          }
          if (!resolvedElement.elementToken) {
            outcome = {
              effect: 'refused',
              completion: 'not_started',
              route: 'accessibility',
              summary: `Refused to type into ${resolvedElement.ref}: element has no accessibility token for direct typing or non-activating focus.`,
              uncertain: false,
            }
          } else if (this.adapter.setElementValue) {
            // Route typing directly to the approved editable accessibility element first.
            const setRes = await this.adapter.setElementValue(
              liveWindow,
              resolvedElement.elementToken,
              options.input.text!,
              options.signal,
            )
            // Only consider fallback when the SDK positively reports the action never started.
            if (setRes.effect !== 'refused' || setRes.completion !== 'not_started') {
              outcome = setRes
            } else if (this.adapter.focusElement) {
              // Backend supports non-activating focus + focus verification before sending keys.
              const focusOutcome = await this.adapter.focusElement(
                liveWindow,
                resolvedElement.elementToken,
                options.signal,
              )
              if (focusOutcome.effect !== 'confirmed' || focusOutcome.completion !== 'completed' || focusOutcome.uncertain) {
                outcome = {
                  ...focusOutcome,
                  summary: `Stopped before typing into ${resolvedElement.ref}: non-activating focus was ${focusOutcome.effect} (${focusOutcome.completion}) — re-observe window state before retrying.`,
                }
              } else {
                outcome = await this.adapter.typeText(liveWindow, options.input.text!, options.signal)
              }
            } else {
              // Never click an element to simulate typing; clicking can activate controls.
              outcome = {
                effect: 'refused',
                completion: 'not_started',
                route: 'accessibility',
                summary: `Refused to type into ${resolvedElement.ref}: direct set_value is unsupported (${setRes.summary}) and this backend cannot focus the field without activating it.`,
                uncertain: false,
                ...(setRes.errorCode ? { errorCode: setRes.errorCode } : {}),
              }
            }
          } else if (this.adapter.focusElement) {
            const focusOutcome = await this.adapter.focusElement(
              liveWindow,
              resolvedElement.elementToken,
              options.signal,
            )
            if (focusOutcome.effect !== 'confirmed' || focusOutcome.completion !== 'completed' || focusOutcome.uncertain) {
              outcome = {
                ...focusOutcome,
                summary: `Stopped before typing into ${resolvedElement.ref}: non-activating focus was ${focusOutcome.effect} (${focusOutcome.completion}) — re-observe window state before retrying.`,
              }
            } else {
              outcome = await this.adapter.typeText(liveWindow, options.input.text!, options.signal)
            }
          } else {
            outcome = {
              effect: 'refused',
              completion: 'not_started',
              route: 'accessibility',
              summary: `Refused to type into ${resolvedElement.ref}: direct set_value is unavailable and this backend cannot focus the field without activating it.`,
              uncertain: false,
            }
          }
        } else if (options.input.action === 'press') {
          outcome = await this.adapter.pressKey(liveWindow, options.input.key!, options.input.modifiers, options.signal)
        } else {
          const sx = typeof options.input.x === 'number' ? Math.round(options.input.x) : Math.round(liveWindow.bounds.width / 2)
          const sy = typeof options.input.y === 'number' ? Math.round(options.input.y) : Math.round(liveWindow.bounds.height / 2)
          outcome = await this.adapter.scroll(
            liveWindow,
            sx,
            sy,
            options.input.direction!,
            options.input.amount ?? 3,
            options.signal,
          )
        }
      } catch (error) {
        return { ok: false, error: `Desktop action failed: ${errorMessage(error)}` }
      }

      // Refresh status after a relevant refusal so plugin activation takes effect without a restart,
      // and attach accurate Hyprland guidance when applicable.
      let effectiveStatus = status
      if (isRelevantInputRefusal(outcome, options.input)) {
        try {
          effectiveStatus = await this.probe(options.signal, { fresh: true })
        } catch {
          effectiveStatus = status
        }
        const guidance = hyprlandRefusalGuidance(
          effectiveStatus.hyprlandPluginState,
          liveWindow.appName,
          options.input.action,
        )
        if (guidance) {
          outcome = {
            ...outcome,
            hint: guidance,
          }
        }
      }

      // Inspect fresh state after the action (especially when delivery is unknown/uncertain).
      let fresh: ComputerObservationResult | null = null
      if (!options.signal?.aborted && !lease.revoked) {
        try {
          const stillThere = await this.verifyLeaseAndWindow(options.turnId, options.signal)
          if (stillThere.ok) {
            fresh = await this.captureForLease(lease, effectiveStatus, options.visionConfirmed, options.signal)
          }
        } catch {
          fresh = null
        }
      }

      return {
        ok: true,
        result: {
          window: lease.window,
          outcome,
          snapshot: fresh?.snapshot ?? null,
          ...(fresh?.insufficientEvidence ? { insufficientEvidence: fresh.insufficientEvidence } : {}),
        },
      }
    })
  }

  private async verifyLeaseAndWindow(
    turnId: string,
    signal?: AbortSignal,
    approvedWindow?: DiscoveredWindow,
  ): Promise<{ ok: true; lease: TurnLease; status: ComputerCapabilityStatus; liveWindow: DiscoveredWindow } | { ok: false; error: string }> {
    if (signal?.aborted) {
      this.releaseTurn(turnId)
      return { ok: false, error: 'Desktop access was invalidated because the turn was stopped.' }
    }
    const lease = this.leases.get(turnId)
    if (!lease || lease.revoked) {
      return { ok: false, error: 'No desktop window is authorized for this turn. Call computer_open first.' }
    }
    const status = await this.probe(signal)
    if (!status.available) {
      return { ok: false, error: status.reason ?? `Computer Use is unavailable: ${status.summary}` }
    }
    const windows = await this.adapter.listWindows(signal)
    const liveWindow = windows.find((w) => w.windowId === lease.window.windowId && w.pid === lease.window.pid)
    if (!liveWindow) {
      this.releaseTurn(turnId)
      return {
        ok: false,
        error: `Authorized window ${windowLabel(lease.window)} is no longer open. Call computer_list and computer_open to authorize another window.`,
      }
    }
    if (liveWindow.appName !== lease.window.appName) {
      this.releaseTurn(turnId)
      return {
        ok: false,
        error: `Authorized window identity changed (expected ${lease.window.appName}, found ${liveWindow.appName}). Authorization revoked.`,
      }
    }
    if (approvedWindow && (liveWindow.title !== approvedWindow.title || liveWindow.windowId !== approvedWindow.windowId)) {
      return {
        ok: false,
        error: `Authorized window changed while approval was pending (expected ${windowLabel(approvedWindow)}, found ${windowLabel(liveWindow)}). Inspect with computer_snapshot and re-approve.`,
      }
    }
    lease.window = liveWindow
    return { ok: true, lease, status, liveWindow }
  }

  private async captureForLease(
    lease: TurnLease,
    status: ComputerCapabilityStatus,
    wantScreenshot: boolean,
    signal?: AbortSignal,
  ): Promise<ComputerObservationResult> {
    const includeScreenshot = wantScreenshot && status.screenCaptureAvailable
    const raw: RawWindowState = await this.adapter.getWindowState(
      lease.window,
      { includeScreenshot, maxElements: 120, maxDepth: 12, timeoutMs: 2000 },
      signal,
    )

    const elements = new Map<string, WindowElementRef>()
    const elementList: WindowElementRef[] = []
    for (const el of raw.elements) {
      const ref = `c${lease.nextRef++}`
      const entry: WindowElementRef = { ...el, ref }
      elements.set(ref, entry)
      elementList.push(entry)
    }

    const treeText = formatElementsTree(elementList, raw)
    const snapshot: BoundSnapshot = {
      captureId: raw.snapshotId,
      capturedAt: Date.now(),
      window: {
        ...lease.window,
        appName: raw.appName || lease.window.appName,
        title: raw.windowTitle || lease.window.title,
      },
      elements,
      elementList,
      treeText,
      ...(raw.observationsText ? { observationsText: raw.observationsText } : {}),
      degraded: raw.degraded,
      ...(raw.degradedReason ? { degradedReason: raw.degradedReason } : {}),
      truncated: raw.truncated,
      ...(raw.truncationReason ? { truncationReason: raw.truncationReason } : {}),
      ...(raw.screenshot ? { screenshot: raw.screenshot } : {}),
    }

    lease.snapshot = snapshot

    let insufficientEvidence: string | undefined
    if (!wantScreenshot) {
      const actionableCount = elementList.filter((e) => e.elementToken || (e.actions && e.actions.length > 0)).length
      if (snapshot.degraded || elementList.length <= 1 || actionableCount === 0) {
        insufficientEvidence =
          'The active model does not have confirmed vision support, and the accessibility tree for this window is degraded or exposes insufficient interactive controls to verify or drive it reliably.'
      }
    }

    return { window: snapshot.window, snapshot, ...(insufficientEvidence ? { insufficientEvidence } : {}) }
  }

  async close(): Promise<void> {
    for (const turnId of [...this.leases.keys()]) {
      this.releaseTurn(turnId)
    }
    await this.adapter.close()
  }
}

function formatElementsTree(elements: WindowElementRef[], raw: RawWindowState): string {
  const lines: string[] = []
  for (const el of elements) {
    const indent = '  '.repeat(Math.min(el.depth, 8))
    const parts = [`${indent}${el.ref}`, el.role]
    if (el.label) parts.push(`"${el.label.replace(/\s+/g, ' ').slice(0, 120)}"`)
    if (el.isPassword) parts.push('<password field — Milo will not fill this>')
    else if (el.value !== undefined && el.value !== '') {
      parts.push(`value="${el.value.replace(/\s+/g, ' ').slice(0, 80)}"`)
    }
    if (el.enabled === false) parts.push('[disabled]')
    if (el.selected === true) parts.push('[selected]')
    if (el.actions && el.actions.length > 0) parts.push(`[actions=${el.actions.slice(0, 6).join(',')}]`)
    lines.push(parts.join(' '))
  }
  if (lines.length === 0 && raw.treeMarkdown) {
    return raw.treeMarkdown.slice(0, 8000)
  }
  return lines.join('\n')
}
