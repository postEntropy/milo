import type { ImageMime } from '../providers/types.js'

/** Observed state of the optional Hyprland Cua compositor plugin. */
export type HyprlandPluginState =
  | 'not_applicable'
  | 'not_installed'
  | 'installed_not_loaded'
  | 'loaded_discovery_only'
  | 'loaded_abi_mismatch'
  | 'loaded_unsupported_protocol'
  | 'loaded_transport_stopped'
  | 'loaded_disabled'
  | 'input_available'
  | 'unverified'

/** What the host desktop backend can currently observe and drive. */
export interface ComputerCapabilityStatus {
  available: boolean
  platform: NodeJS.Platform
  sdkVersion: string | null
  displayServer: 'wayland+xwayland' | 'wayland' | 'x11' | 'none' | 'unsupported'
  waylandEnabled: boolean
  atspiAvailable: boolean
  screenCaptureAvailable: boolean
  inputModes: {
    accessibility: boolean
    windowScopedPointer: boolean
    xsendEvent: boolean
    hyprlandPlugin: boolean
  }
  /** Detailed Hyprland plugin state from `hyprctl -j cua:status` and package presence. */
  hyprlandPluginState?: HyprlandPluginState
  /** Concrete compositor or environment limitations that affect what will succeed. */
  limitations: string[]
  /** Actionable reason when `available` is false. */
  reason?: string
  /** Single-line status shared across CLI, web, iOS, and the system prompt. */
  summary: string
}

export interface ComputerFacts {
  enabled: boolean
  status: ComputerCapabilityStatus
  boundWindow?: {
    appName: string
    title: string
    pid: number
    windowId: string
  } | null
}

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface DiscoveredApp {
  pid: number
  name: string
  running: boolean
  active: boolean
  launchPath?: string
  kind?: string
}

export interface DiscoveredWindow {
  /** Native window identifier kept as a decimal string (never converted to `number`). */
  windowId: string
  pid: number
  appName: string
  title: string
  bounds: WindowBounds
  isOnScreen: boolean
}

export interface ElementFrame {
  x: number
  y: number
  width: number
  height: number
}

export interface RawWindowElement {
  elementIndex: bigint
  role: string
  depth: number
  elementToken?: string
  label?: string
  value?: string
  enabled?: boolean
  selected?: boolean
  isPassword?: boolean
  actions?: string[]
  frame?: ElementFrame
}

export interface WindowElementRef extends RawWindowElement {
  /** Monotonic Milo-owned reference valid only for the current snapshot (e.g. `c1`). */
  ref: string
}

export interface WindowScreenshot {
  mimeType: ImageMime
  data: string
  width: number
  height: number
  frameValid: boolean
}

export interface RawWindowState {
  snapshotId: string
  pid: number
  windowId: string
  appName: string
  windowTitle: string
  treeMarkdown?: string
  elements: RawWindowElement[]
  observationsText?: string
  degraded: boolean
  degradedReason?: string
  truncated: boolean
  truncationReason?: string
  screenshot?: WindowScreenshot
}

export type ComputerActionEffect = 'confirmed' | 'partial' | 'unverifiable' | 'suspected_noop' | 'refused'

/** Preserves the SDK's distinction between actions that never started, completed, or have unknown delivery. */
export type ComputerActionCompletion = 'not_started' | 'completed' | 'unknown'

export interface ComputerActionOutcome {
  effect: ComputerActionEffect
  completion: ComputerActionCompletion
  route: string
  summary: string
  uncertain: boolean
  /** Structured refusal/error code preserved from Cua Driver. */
  errorCode?: string
  error?: string
  hint?: string
}

export interface ComputerToolPreview {
  /** Opaque in-memory preview reference; never a filesystem path or raw image payload. */
  id: string
  width: number
  height: number
}

export type ComputerScrollDirection = 'up' | 'down' | 'left' | 'right'

export interface ComputerDriverAdapter {
  probe(signal?: AbortSignal): Promise<ComputerCapabilityStatus>
  listApps(signal?: AbortSignal): Promise<DiscoveredApp[]>
  listWindows(signal?: AbortSignal): Promise<DiscoveredWindow[]>
  launchApp(
    input: { name?: string; launchPath?: string },
    signal?: AbortSignal,
  ): Promise<{ ok: true; text: string; pid?: number } | { ok: false; error: string }>
  getWindowState(
    window: DiscoveredWindow,
    options: { includeScreenshot: boolean; maxElements?: number; maxDepth?: number; timeoutMs?: number },
    signal?: AbortSignal,
  ): Promise<RawWindowState>
  clickElement(
    window: DiscoveredWindow,
    elementToken: string,
    options?: { button?: 'left' | 'right' | 'middle'; count?: number },
    signal?: AbortSignal,
  ): Promise<ComputerActionOutcome>
  clickCoordinates(
    window: DiscoveredWindow,
    x: number,
    y: number,
    captureId: string,
    options?: { button?: 'left' | 'right' | 'middle'; count?: number },
    signal?: AbortSignal,
  ): Promise<ComputerActionOutcome>
  setElementValue?(
    window: DiscoveredWindow,
    elementToken: string,
    value: string,
    signal?: AbortSignal,
  ): Promise<ComputerActionOutcome>
  /**
   * Optional non-activating focus primitive. Only implemented by backends that can
   * focus an exact editable field without activating controls and positively verify focus.
   */
  focusElement?(
    window: DiscoveredWindow,
    elementToken: string,
    signal?: AbortSignal,
  ): Promise<ComputerActionOutcome>
  typeText(window: DiscoveredWindow, text: string, signal?: AbortSignal): Promise<ComputerActionOutcome>
  pressKey(window: DiscoveredWindow, key: string, modifiers?: string[], signal?: AbortSignal): Promise<ComputerActionOutcome>
  scroll(
    window: DiscoveredWindow,
    x: number,
    y: number,
    direction: ComputerScrollDirection,
    amount: number,
    signal?: AbortSignal,
  ): Promise<ComputerActionOutcome>
  close(): Promise<void>
}
