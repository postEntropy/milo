import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import type {
  ActionResult,
  CuaDriverLike,
  ToolResult as DriverToolResult,
} from '@trycua/cua-driver'
import { errorMessage } from '../../util/errors.js'
import type { ImageMime } from '../providers/types.js'
import type {
  ComputerActionCompletion,
  ComputerActionEffect,
  ComputerActionOutcome,
  ComputerCapabilityStatus,
  ComputerDriverAdapter,
  ComputerScrollDirection,
  DiscoveredApp,
  DiscoveredWindow,
  HyprlandPluginState,
  RawWindowState,
} from './types.js'

const execFileAsync = promisify(execFile)

export const OMARCHY_ACTIVATION_GUIDE =
  'https://github.com/omacom/omarchy-pkgs/blob/master/pkgbuilds/cua-hyprland-plugin/README.md'

const HYPRLAND_PLUGIN_PACKAGE = 'cua-hyprland-plugin'
const HYPRLAND_PLUGIN_PATHS = [
  '/usr/lib/cua/hyprland/cua-hyprland-plugin.so',
  '/usr/lib/hyprland/cua-hyprland-plugin.so',
]
const PROBE_TIMEOUT_MS = 1500
const PROBE_MAX_BUFFER = 64 * 1024

type CuaSdkModule = typeof import('@trycua/cua-driver')

export type CommandProbeFn = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number; signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string }>

export interface HyprlandProbeDeps {
  runCommand?: CommandProbeFn
  fileExists?: (filePath: string) => boolean
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}

function defaultRunCommand(
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number; signal?: AbortSignal },
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(file, args, {
    timeout: options.timeout,
    maxBuffer: options.maxBuffer,
    ...(options.signal ? { signal: options.signal } : {}),
  })
}

function driverErrorInfo(error: unknown): {
  code?: string
  message: string
  hint?: string
  completion: ComputerActionCompletion
} {
  if (error && typeof error === 'object' && 'inner' in error) {
    const inner = (error as { inner?: unknown }).inner
    if (inner && typeof inner === 'object') {
      const rec = inner as Record<string, unknown>
      const code = typeof rec.code === 'string' && rec.code.trim() ? rec.code.trim() : undefined
      const hint = typeof rec.hint === 'string' && rec.hint.trim() ? rec.hint.trim() : undefined
      const reason = [rec.message, rec.reason]
        .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
        .join(' — ')
      // ActionCompletion enum in @trycua/cua-driver: 0 = NotStarted, 1 = Completed, 2 = Unknown
      const rawCompletion = rec.completion
      const completion: ComputerActionCompletion =
        rawCompletion === 0
          ? 'not_started'
          : rawCompletion === 1
            ? 'completed'
            : 'unknown'
      return {
        ...(code ? { code } : {}),
        message: reason || hint || code || errorMessage(error),
        ...(hint && hint !== reason ? { hint } : {}),
        completion,
      }
    }
  }
  return { message: errorMessage(error), completion: 'unknown' }
}

function errorOutcome(route: string, label: string, error: unknown): ComputerActionOutcome {
  const info = driverErrorInfo(error)
  return {
    effect: info.completion === 'unknown' ? 'unverifiable' : 'refused',
    completion: info.completion,
    route,
    summary: `${label} ${info.completion === 'unknown' ? 'outcome unknown' : 'refused'}: ${info.message}`,
    uncertain: info.completion === 'unknown',
    ...(info.code ? { errorCode: info.code } : {}),
    error: info.message,
    ...(info.hint ? { hint: info.hint } : {}),
  }
}

function mapEffect(effect: number | string | undefined): ComputerActionEffect {
  if (effect === 0 || effect === 'confirmed') return 'confirmed'
  if (effect === 1 || effect === 'partial') return 'partial'
  if (effect === 2 || effect === 'unverifiable') return 'unverifiable'
  if (effect === 3 || effect === 'suspected_noop') return 'suspected_noop'
  if (effect === 4 || effect === 'refused') return 'refused'
  return 'unverifiable'
}

function mapRoute(route: number | string | undefined): string {
  if (route === 0 || route === 'accessibility') return 'accessibility'
  if (route === 1 || route === 'synthetic_events') return 'synthetic_events'
  if (route === 2 || route === 'global_input') return 'global_input'
  if (route === 3 || route === 'system_api') return 'system_api'
  if (route === 4 || route === 'dom') return 'dom'
  if (route === 5 || route === 'trusted_input') return 'trusted_input'
  return 'unknown'
}

function completionForEffect(effect: ComputerActionEffect): ComputerActionCompletion {
  if (effect === 'confirmed') return 'completed'
  if (effect === 'refused') return 'not_started'
  return 'unknown'
}

function toOutcome(result: ActionResult): ComputerActionOutcome {
  const effect = mapEffect(result.effect)
  const route = mapRoute(result.route)
  const completion = completionForEffect(effect)
  const uncertain = completion === 'unknown'
  const errorCode = result.error?.code?.trim() || undefined
  const errorHint = result.error?.hint?.trim() || undefined
  const topHint = result.hint?.trim() || undefined
  const summaryText = result.summary?.trim() || undefined
  const reason = summaryText ?? errorHint ?? (errorCode ? `Refused (${errorCode}).` : undefined)
  const hint = topHint && topHint !== reason ? topHint : errorHint && errorHint !== reason ? errorHint : undefined
  return {
    effect,
    completion,
    route,
    summary: reason ?? (effect === 'refused' ? 'Action refused.' : `Action ${effect} via ${route}.`),
    uncertain,
    ...(errorCode ? { errorCode } : {}),
    ...(effect === 'refused' && reason ? { error: reason } : {}),
    ...(hint ? { hint } : {}),
  }
}

function toolResultToOutcome(result: DriverToolResult): ComputerActionOutcome {
  if (result.action) return toOutcome(result.action)
  if (result.structuredJson) {
    try {
      const parsed = JSON.parse(result.structuredJson) as Record<string, unknown>
      if (typeof parsed.effect === 'string') {
        const effect = mapEffect(parsed.effect)
        const route = mapRoute(typeof parsed.route === 'string' ? parsed.route : undefined)
        const completion = completionForEffect(effect)
        const errObj = parsed.error && typeof parsed.error === 'object' ? (parsed.error as Record<string, unknown>) : null
        const errorCode =
          (typeof errObj?.code === 'string' && errObj.code.trim() ? errObj.code.trim() : undefined) ??
          (typeof result.errorCode === 'string' && result.errorCode.trim() ? result.errorCode.trim() : undefined)
        const errHint = typeof errObj?.hint === 'string' && errObj.hint.trim() ? errObj.hint.trim() : undefined
        const topHint = typeof parsed.hint === 'string' && parsed.hint.trim() ? parsed.hint.trim() : undefined
        const summaryText =
          (typeof parsed.summary === 'string' && parsed.summary.trim() ? parsed.summary.trim() : undefined) ??
          (result.text?.trim() || undefined)
        const reason = summaryText ?? errHint ?? (errorCode ? `Refused (${errorCode}).` : undefined)
        const hint = topHint && topHint !== reason ? topHint : errHint && errHint !== reason ? errHint : undefined
        return {
          effect,
          completion,
          route,
          summary: reason ?? (effect === 'refused' ? 'Action refused.' : `Action ${effect} via ${route}.`),
          uncertain: completion === 'unknown',
          ...(errorCode ? { errorCode } : {}),
          ...(effect === 'refused' && reason ? { error: reason } : {}),
          ...(hint ? { hint } : {}),
        }
      }
    } catch {
      // Fall through to plain text interpretation.
    }
  }
  if (result.isError) {
    const errorCode = result.errorCode?.trim() || undefined
    const reason = result.text?.trim() || (errorCode ? `Action refused (${errorCode}).` : 'Action refused by desktop driver.')
    return {
      effect: 'refused',
      completion: 'not_started',
      route: 'unknown',
      summary: reason,
      uncertain: false,
      ...(errorCode ? { errorCode } : {}),
      error: reason,
    }
  }
  return {
    effect: 'unverifiable',
    completion: 'unknown',
    route: 'unknown',
    summary: result.text || 'Action dispatched; delivery could not be independently confirmed.',
    uncertain: true,
  }
}

function normalizeMime(mime: string | undefined): ImageMime {
  return mime === 'image/jpeg' ? 'image/jpeg' : 'image/png'
}

function isHyprlandHost(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  if (platform !== 'linux') return false
  return Boolean(
    env.HYPRLAND_INSTANCE_SIGNATURE ||
      env.XDG_CURRENT_DESKTOP?.toLowerCase().includes('hyprland'),
  )
}

const SUPPORTED_HYPRLAND_INPUT_PROTOCOL = 3

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function parseCuaStatusJson(raw: string): 'input_available' | 'loaded_disabled' | 'unverified' | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const rec = asRecord(parsed)
  if (!rec) return null

  const abi = asRecord(rec.abi)
  const abiMatch = abi ? abi.match === true : rec.abi_match === true
  const abiMismatch = abi ? abi.match === false : rec.abi_match === false

  const transport = asRecord(rec.transport)
  const transportState = typeof transport?.state === 'string' ? transport.state.trim().toLowerCase() : ''
  const transportStopped =
    transport
      ? transport.ready === false || transportState === 'stopped' || transportState === 'disabled'
      : rec.transport_ready === false
  const transportReady =
    transport
      ? transport.ready === true && transportState !== 'stopped' && transportState !== 'disabled'
      : rec.transport_ready === true

  const endpoints = asRecord(rec.endpoints)
  const input = asRecord(rec.input) ?? asRecord(endpoints?.input)

  if (
    rec.enabled === false ||
    rec.input_enabled === false ||
    rec.configured === false ||
    abiMismatch ||
    transportStopped
  ) {
    return 'loaded_disabled'
  }

  if (input) {
    const inputState = typeof input.state === 'string' ? input.state.trim().toLowerCase() : ''
    const inputDisabled =
      input.test_only === true ||
      input.transport_ready === false ||
      input.enabled === false ||
      input.active === false ||
      input.supported === false ||
      inputState === 'disabled' ||
      inputState === 'stopped' ||
      inputState === 'error'
    const protocolSupported = input.protocol === SUPPORTED_HYPRLAND_INPUT_PROTOCOL

    if (
      abiMatch &&
      transportReady &&
      input.test_only === false &&
      protocolSupported &&
      input.transport_ready === true &&
      !inputDisabled
    ) {
      return 'input_available'
    }
    if (inputDisabled || (input.protocol !== undefined && !protocolSupported)) {
      return 'loaded_disabled'
    }
    return 'unverified'
  }

  const mode = typeof rec.mode === 'string' ? rec.mode.trim().toLowerCase() : ''
  if (mode === 'discovery' || mode === 'discovery-only' || asRecord(endpoints?.discovery)) {
    return 'loaded_disabled'
  }

  // `configured: true` alone does not prove ABI match, transport readiness, or active production input.
  return 'unverified'
}

async function checkPluginInstalled(
  runCommand: CommandProbeFn,
  fileExists: (filePath: string) => boolean,
  signal?: AbortSignal,
): Promise<'installed' | 'not_installed' | 'unverified'> {
  if (HYPRLAND_PLUGIN_PATHS.some((p) => fileExists(p))) return 'installed'
  try {
    await runCommand('pacman', ['-Q', HYPRLAND_PLUGIN_PACKAGE], {
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: 16 * 1024,
      ...(signal ? { signal } : {}),
    })
    return 'installed'
  } catch (error) {
    const rec = error as { code?: unknown; stderr?: unknown; stdout?: unknown }
    const combined = `${String(rec?.stderr ?? '')}\n${String(rec?.stdout ?? '')}`.toLowerCase()
    if (combined.includes('was not found') || combined.includes('not found')) {
      return 'not_installed'
    }
    if (typeof rec?.code === 'number' && rec.code === 1) {
      return 'not_installed'
    }
    return 'unverified'
  }
}

/**
 * Bounded, read-only Hyprland plugin probe using `hyprctl -j cua:status` and
 * Arch package / shared-library presence to distinguish installation from loading.
 */
export async function probeHyprlandPluginStatus(
  deps: HyprlandProbeDeps = {},
  signal?: AbortSignal,
): Promise<HyprlandPluginState> {
  const env = deps.env ?? process.env
  const platform = deps.platform ?? process.platform
  if (!isHyprlandHost(env, platform)) return 'not_applicable'

  const runCommand = deps.runCommand ?? defaultRunCommand
  const fileExists = deps.fileExists ?? existsSync

  try {
    const { stdout, stderr } = await runCommand('hyprctl', ['-j', 'cua:status'], {
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: PROBE_MAX_BUFFER,
      ...(signal ? { signal } : {}),
    })
    const trimmed = stdout.trim()
    const combined = `${trimmed}\n${stderr.trim()}`.toLowerCase()
    if (combined.includes('unknown request')) {
      const installed = await checkPluginInstalled(runCommand, fileExists, signal)
      return installed === 'installed'
        ? 'installed_not_loaded'
        : installed === 'not_installed'
          ? 'not_installed'
          : 'unverified'
    }
    if (trimmed) {
      const state = parseCuaStatusJson(trimmed)
      if (state) return state
    }
    return 'unverified'
  } catch (error) {
    const rec = error as { stdout?: unknown; stderr?: unknown }
    const combined = `${String(rec?.stdout ?? '')}\n${String(rec?.stderr ?? '')}`.toLowerCase()
    if (combined.includes('unknown request')) {
      const installed = await checkPluginInstalled(runCommand, fileExists, signal)
      return installed === 'installed'
        ? 'installed_not_loaded'
        : installed === 'not_installed'
          ? 'not_installed'
          : 'unverified'
    }
    return 'unverified'
  }
}

export function hyprlandPluginSummaryTag(state: HyprlandPluginState): string | null {
  switch (state) {
    case 'not_installed':
      return 'Hyprland plugin not installed'
    case 'installed_not_loaded':
      return 'Hyprland plugin installed, not loaded'
    case 'loaded_disabled':
      return 'Hyprland plugin loaded, input disabled'
    case 'input_available':
      return 'Hyprland input ready'
    case 'unverified':
      return 'Hyprland plugin status unverified'
    case 'not_applicable':
      return null
  }
}

export function hyprlandPluginLimitation(state: HyprlandPluginState): string | null {
  switch (state) {
    case 'not_installed':
      return `Hyprland Cua plugin (${HYPRLAND_PLUGIN_PACKAGE}) is not installed. Background pixel clicks and keyboard input on native Wayland windows require it; window capture and AT-SPI accessibility actions remain available where supported. See the Omarchy activation guide: ${OMARCHY_ACTIVATION_GUIDE}`
    case 'installed_not_loaded':
      return `Hyprland Cua plugin is installed but not loaded in the compositor. Load it and enable input for background Wayland input; window capture and AT-SPI accessibility actions remain available where supported. See the Omarchy activation guide: ${OMARCHY_ACTIVATION_GUIDE}`
    case 'loaded_disabled':
      return `Hyprland Cua plugin is loaded, but compositor input is disabled. Enable plugin:cua:enabled in Hyprland config and reload; window capture and AT-SPI accessibility actions remain available where supported. See the Omarchy activation guide: ${OMARCHY_ACTIVATION_GUIDE}`
    case 'unverified':
      return 'Hyprland Cua plugin status could not be verified via `hyprctl -j cua:status`. Window capture and AT-SPI accessibility actions remain available where supported.'
    case 'input_available':
    case 'not_applicable':
      return null
  }
}

export function hyprlandRefusalGuidance(
  state: HyprlandPluginState | undefined,
  appName: string,
  action: string,
): string | null {
  if (!state || state === 'not_applicable') return null
  if (state === 'input_available') {
    return `The Hyprland Cua plugin is active, but "${appName}" or this "${action}" action lacks a supported background input route. Window capture and AT-SPI accessibility actions remain available where supported.`
  }
  return hyprlandPluginLimitation(state)
}

/**
 * The single adapter boundary around `@trycua/cua-driver`.
 *
 * The native SDK is lazy-loaded on first use so Milo starts cleanly with
 * Computer Use disabled even on hosts without a matching native binding.
 */
export class CuaDriverAdapter implements ComputerDriverAdapter {
  private sdk: CuaSdkModule | null = null
  private driver: CuaDriverLike | null = null
  private closed = false
  private readonly probeDeps: HyprlandProbeDeps

  constructor(probeDeps: HyprlandProbeDeps = {}) {
    this.probeDeps = probeDeps
  }

  private async loadSdk(): Promise<CuaSdkModule> {
    if (this.sdk) return this.sdk
    this.sdk = await import('@trycua/cua-driver')
    return this.sdk
  }

  private async ensureDriver(): Promise<{ sdk: CuaSdkModule; driver: CuaDriverLike }> {
    if (this.closed) throw new Error('Desktop driver has been closed.')
    const sdk = await this.loadSdk()
    if (this.driver) return { sdk, driver: this.driver }
    if (
      process.platform === 'linux' &&
      process.env.WAYLAND_DISPLAY &&
      process.env.CUA_DRIVER_RS_ENABLE_WAYLAND === undefined
    ) {
      process.env.CUA_DRIVER_RS_ENABLE_WAYLAND = '1'
    }
    this.driver = sdk.CuaDriver.create({ claudeCodeCompatibility: false, embedded: true })
    return { sdk, driver: this.driver }
  }

  async probe(signal?: AbortSignal): Promise<ComputerCapabilityStatus> {
    if (process.platform !== 'linux') {
      const reason = `Computer Use currently targets Linux (Omarchy/Hyprland); host platform is ${process.platform}.`
      return {
        available: false,
        platform: process.platform,
        sdkVersion: null,
        displayServer: 'unsupported',
        waylandEnabled: false,
        atspiAvailable: false,
        screenCaptureAvailable: false,
        inputModes: { accessibility: false, windowScopedPointer: false, xsendEvent: false, hyprlandPlugin: false },
        limitations: [reason],
        reason,
        summary: `Unavailable (${process.platform} is not supported yet)`,
      }
    }

    const hasWayland = Boolean(process.env.WAYLAND_DISPLAY)
    const hasX11 = Boolean(process.env.DISPLAY)
    if (!hasWayland && !hasX11) {
      const reason = 'No active desktop display found (WAYLAND_DISPLAY and DISPLAY are both unset).'
      return {
        available: false,
        platform: process.platform,
        sdkVersion: null,
        displayServer: 'none',
        waylandEnabled: false,
        atspiAvailable: false,
        screenCaptureAvailable: false,
        inputModes: { accessibility: false, windowScopedPointer: false, xsendEvent: false, hyprlandPlugin: false },
        limitations: [reason],
        reason,
        summary: 'Unavailable (no display server)',
      }
    }

    const displayServer =
      hasWayland && hasX11 ? 'wayland+xwayland' : hasWayland ? 'wayland' : 'x11'

    let driver: CuaDriverLike
    try {
      ;({ driver } = await this.ensureDriver())
    } catch (error) {
      const reason = `Could not load or initialize @trycua/cua-driver native binding: ${errorMessage(error)}`
      return {
        available: false,
        platform: process.platform,
        sdkVersion: null,
        displayServer,
        waylandEnabled: false,
        atspiAvailable: false,
        screenCaptureAvailable: false,
        inputModes: { accessibility: false, windowScopedPointer: false, xsendEvent: false, hyprlandPlugin: false },
        limitations: [reason],
        reason,
        summary: 'Unavailable (native SDK binding missing or failed to initialize)',
      }
    }

    const asyncOpts = signal ? { signal } : undefined
    let sdkVersion: string | null = null
    try {
      const meta = await driver.metadata(asyncOpts)
      sdkVersion = meta.driverVersion || null
    } catch {
      sdkVersion = null
    }

    let atspiAvailable = false
    let waylandEnabled = false
    let xsendEvent = false
    let screenCaptureAvailable = false
    let windowScopedPointer = false
    const limitations: string[] = []

    try {
      const perms = await driver.callTool('check_permissions', '{}', asyncOpts)
      if (perms.structuredJson) {
        const parsed = JSON.parse(perms.structuredJson) as Record<string, unknown>
        atspiAvailable = parsed.atspi === true
        waylandEnabled = parsed.wayland_enabled === true
        xsendEvent = parsed.xsend_event === true
      }
    } catch (error) {
      limitations.push(`Permission probe failed: ${errorMessage(error)}`)
    }

    try {
      const health = await driver.callTool('health_report', '{}', asyncOpts)
      if (health.structuredJson) {
        const parsed = JSON.parse(health.structuredJson) as {
          checks?: Array<{ name?: string; status?: string; message?: string }>
        }
        for (const check of parsed.checks ?? []) {
          if (check.name === 'ax_capability') {
            if (check.status === 'pass') atspiAvailable = true
            else if (check.message) limitations.push(`Accessibility: ${check.message}`)
          } else if (check.name === 'screen_capture_capability') {
            if (check.status === 'pass') screenCaptureAvailable = true
            else if (check.message) limitations.push(`Screen capture: ${check.message}`)
          } else if (check.name === 'wayland_backend') {
            const msg = check.message ?? ''
            if (msg.includes('virtual-pointer=true')) windowScopedPointer = true
            if (check.status !== 'pass' && msg) limitations.push(`Wayland backend: ${msg}`)
          }
        }
      }
    } catch (error) {
      limitations.push(`Health probe failed: ${errorMessage(error)}`)
    }

    const hyprlandPluginState = await probeHyprlandPluginStatus(this.probeDeps, signal)
    const hyprlandPlugin = hyprlandPluginState === 'input_available'
    const hyprlandLimitation = hyprlandPluginLimitation(hyprlandPluginState)
    if (hyprlandLimitation) {
      limitations.push(hyprlandLimitation)
    }
    if (hasWayland && !waylandEnabled) {
      limitations.push('Native Wayland backend is disabled; only XWayland windows can be discovered.')
    }
    if (!atspiAvailable) {
      limitations.push('AT-SPI accessibility bus is not reachable; semantic element discovery will be degraded.')
    }
    if (!screenCaptureAvailable) {
      limitations.push('Window screenshot capture is unavailable on this compositor.')
    }

    const available = driver.isAvailable() && (atspiAvailable || screenCaptureAvailable || xsendEvent || hyprlandPlugin)
    const parts: string[] = []
    if (sdkVersion) parts.push(`SDK ${sdkVersion}`)
    parts.push(displayServer)
    parts.push(atspiAvailable ? 'AT-SPI ready' : 'AT-SPI unavailable')
    parts.push(screenCaptureAvailable ? 'capture ready' : 'no capture')
    const hyprlandTag = hyprlandPluginSummaryTag(hyprlandPluginState)
    if (hyprlandTag) parts.push(hyprlandTag)

    return {
      available,
      platform: process.platform,
      sdkVersion,
      displayServer,
      waylandEnabled,
      atspiAvailable,
      screenCaptureAvailable,
      inputModes: {
        accessibility: atspiAvailable,
        windowScopedPointer: windowScopedPointer || xsendEvent || hyprlandPlugin,
        xsendEvent,
        hyprlandPlugin,
      },
      hyprlandPluginState,
      limitations,
      ...(!available ? { reason: limitations[0] ?? 'Desktop automation backend is not available.' } : {}),
      summary: available ? `Ready (${parts.join(' · ')})` : `Unavailable (${limitations[0] ?? 'backend check failed'})`,
    }
  }

  async listApps(signal?: AbortSignal): Promise<DiscoveredApp[]> {
    const { sdk, driver } = await this.ensureDriver()
    const res = await driver.listApps(sdk.ListAppsInput.new({}), signal ? { signal } : undefined)
    return res.apps.map((app) => ({
      pid: app.pid,
      name: app.name,
      running: app.running,
      active: app.active,
      ...(app.launchPath ? { launchPath: app.launchPath } : {}),
      ...(app.kind ? { kind: app.kind } : {}),
    }))
  }

  async listWindows(signal?: AbortSignal): Promise<DiscoveredWindow[]> {
    const { sdk, driver } = await this.ensureDriver()
    const res = await driver.listWindows(sdk.ListWindowsInput.new({}), signal ? { signal } : undefined)
    const windows: DiscoveredWindow[] = []
    for (const win of res.windows) {
      if (win.pid === undefined) continue
      windows.push({
        windowId: win.windowId.toString(),
        pid: win.pid,
        appName: win.appName,
        title: win.title,
        bounds: {
          x: win.bounds.x,
          y: win.bounds.y,
          width: win.bounds.width,
          height: win.bounds.height,
        },
        isOnScreen: win.isOnScreen,
      })
    }
    return windows
  }

  async launchApp(
    input: { name?: string; launchPath?: string },
    signal?: AbortSignal,
  ): Promise<{ ok: true; text: string; pid?: number } | { ok: false; error: string }> {
    const { driver } = await this.ensureDriver()
    const payload: Record<string, unknown> = {}
    if (input.launchPath) payload.launch_path = input.launchPath
    else if (input.name) payload.name = input.name
    try {
      const result = await driver.callTool('launch_app', JSON.stringify(payload), signal ? { signal } : undefined)
      if (result.isError) {
        return { ok: false, error: result.text || result.errorCode || 'Could not launch application.' }
      }
      let pid: number | undefined
      if (result.structuredJson) {
        try {
          const parsed = JSON.parse(result.structuredJson) as Record<string, unknown>
          if (typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0) {
            pid = parsed.pid
          }
        } catch {
          // Ignore unparseable structured JSON.
        }
      }
      return { ok: true, text: result.text || 'Application launched.', ...(pid ? { pid } : {}) }
    } catch (error) {
      return { ok: false, error: driverErrorInfo(error).message }
    }
  }

  async getWindowState(
    window: DiscoveredWindow,
    options: { includeScreenshot: boolean; maxElements?: number; maxDepth?: number; timeoutMs?: number },
    signal?: AbortSignal,
  ): Promise<RawWindowState> {
    const { sdk, driver } = await this.ensureDriver()
    const state = await driver.getWindowState(
      sdk.GetWindowStateInput.new({
        pid: window.pid,
        windowId: BigInt(window.windowId),
        includeAccessibilityTree: true,
        includeScreenshot: options.includeScreenshot,
        maxElements: options.maxElements ?? 120,
        maxDepth: options.maxDepth ?? 12,
        timeoutMs: options.timeoutMs ?? 2000,
        treeFormat: 'both',
      }),
      signal ? { signal } : undefined,
    )

    const img = state.images[0]
    const screenshot =
      options.includeScreenshot && img?.dataBase64
        ? {
            mimeType: normalizeMime(img.mimeType ?? state.screenshotMimeType),
            data: img.dataBase64,
            width: state.screenshotWidth ?? window.bounds.width,
            height: state.screenshotHeight ?? window.bounds.height,
            frameValid: state.screenshotFrameValid !== false,
          }
        : undefined

    const observationsText =
      state.observations && state.observations.length > 0
        ? state.observations
            .slice(0, 60)
            .map((obs) => {
              const bits = [obs.role]
              if (obs.label) bits.push(`"${obs.label}"`)
              if (obs.value) bits.push(`=${obs.value}`)
              return bits.join(' ')
            })
            .join('\n')
        : undefined

    return {
      snapshotId: state.snapshotId ?? `snap-${Date.now()}`,
      pid: state.pid,
      windowId: state.windowId.toString(),
      appName: state.appName ?? window.appName,
      windowTitle: state.windowTitle ?? window.title,
      ...(state.treeMarkdown ? { treeMarkdown: state.treeMarkdown } : {}),
      elements: (state.elements ?? []).map((el) => ({
        elementIndex: el.elementIndex,
        role: el.role,
        depth: el.depth,
        ...(el.elementToken ? { elementToken: el.elementToken } : {}),
        ...(el.label !== undefined ? { label: el.label } : {}),
        ...(el.value !== undefined ? { value: el.value } : {}),
        ...(el.enabled !== undefined ? { enabled: el.enabled } : {}),
        ...(el.selected !== undefined ? { selected: el.selected } : {}),
        ...(el.isPassword !== undefined ? { isPassword: el.isPassword } : {}),
        ...(el.actions ? { actions: el.actions } : {}),
        ...(el.frame
          ? {
              frame: {
                x: el.frame.x,
                y: el.frame.y,
                width: el.frame.w,
                height: el.frame.h,
              },
            }
          : {}),
      })),
      ...(observationsText ? { observationsText } : {}),
      degraded: state.degraded === true,
      ...(state.degradedReason ? { degradedReason: state.degradedReason } : {}),
      truncated: state.truncated === true,
      ...(state.truncationReason ? { truncationReason: state.truncationReason } : {}),
      ...(screenshot ? { screenshot } : {}),
    }
  }

  async clickElement(
    window: DiscoveredWindow,
    elementToken: string,
    options?: { button?: 'left' | 'right' | 'middle'; count?: number },
    signal?: AbortSignal,
  ): Promise<ComputerActionOutcome> {
    const { sdk, driver } = await this.ensureDriver()
    const button =
      options?.button === 'right'
        ? sdk.ClickButton.Right
        : options?.button === 'middle'
          ? sdk.ClickButton.Middle
          : sdk.ClickButton.Left
    try {
      const result = await driver.click(
        sdk.ClickInput.new({
          target: new sdk.ActionTarget.Window({ pid: window.pid, windowId: BigInt(window.windowId) }),
          position: new sdk.ClickPosition.Element({ elementToken }),
          deliveryMode: sdk.InputDeliveryMode.Background,
          button,
          count: options?.count ?? 1,
        }),
        signal ? { signal } : undefined,
      )
      return toOutcome(result)
    } catch (error) {
      return errorOutcome('accessibility', 'Element click', error)
    }
  }

  async clickCoordinates(
    window: DiscoveredWindow,
    x: number,
    y: number,
    captureId: string,
    options?: { button?: 'left' | 'right' | 'middle'; count?: number },
    signal?: AbortSignal,
  ): Promise<ComputerActionOutcome> {
    const { sdk, driver } = await this.ensureDriver()
    const button =
      options?.button === 'right'
        ? sdk.ClickButton.Right
        : options?.button === 'middle'
          ? sdk.ClickButton.Middle
          : sdk.ClickButton.Left
    try {
      const result = await driver.click(
        sdk.ClickInput.new({
          target: new sdk.ActionTarget.Window({ pid: window.pid, windowId: BigInt(window.windowId) }),
          position: new sdk.ClickPosition.CapturedCoordinates({ x, y, captureId }),
          deliveryMode: sdk.InputDeliveryMode.Background,
          button,
          count: options?.count ?? 1,
        }),
        signal ? { signal } : undefined,
      )
      return toOutcome(result)
    } catch (error) {
      return errorOutcome('synthetic_events', 'Coordinate click', error)
    }
  }

  async setElementValue(
    window: DiscoveredWindow,
    elementToken: string,
    value: string,
    signal?: AbortSignal,
  ): Promise<ComputerActionOutcome> {
    const { driver } = await this.ensureDriver()
    try {
      const result = await driver.callTool(
        'set_value',
        JSON.stringify({
          element_token: elementToken,
          pid: window.pid,
          value,
          delivery_mode: 'background',
        }),
        signal ? { signal } : undefined,
      )
      return toolResultToOutcome(result)
    } catch (error) {
      return errorOutcome('accessibility', 'Accessibility set_value', error)
    }
  }

  async typeText(window: DiscoveredWindow, text: string, signal?: AbortSignal): Promise<ComputerActionOutcome> {
    const { sdk, driver } = await this.ensureDriver()
    try {
      const result = await driver.typeText(
        sdk.TypeTextInput.new({
          text,
          target: new sdk.ActionTarget.Window({ pid: window.pid, windowId: BigInt(window.windowId) }),
        }),
        signal ? { signal } : undefined,
      )
      return toolResultToOutcome(result)
    } catch (error) {
      return errorOutcome('synthetic_events', 'Typing', error)
    }
  }

  async pressKey(
    window: DiscoveredWindow,
    key: string,
    modifiers?: string[],
    signal?: AbortSignal,
  ): Promise<ComputerActionOutcome> {
    const { sdk, driver } = await this.ensureDriver()
    try {
      const result = await driver.pressKey(
        sdk.PressKeyInput.new({
          key,
          ...(modifiers && modifiers.length > 0 ? { modifiers } : {}),
          target: new sdk.ActionTarget.Window({ pid: window.pid, windowId: BigInt(window.windowId) }),
        }),
        signal ? { signal } : undefined,
      )
      return toolResultToOutcome(result)
    } catch (error) {
      return errorOutcome('synthetic_events', 'Key press', error)
    }
  }

  async scroll(
    window: DiscoveredWindow,
    x: number,
    y: number,
    direction: ComputerScrollDirection,
    amount: number,
    signal?: AbortSignal,
  ): Promise<ComputerActionOutcome> {
    const { sdk, driver } = await this.ensureDriver()
    const mappedDirection =
      direction === 'up'
        ? sdk.ScrollDirection.Up
        : direction === 'down'
          ? sdk.ScrollDirection.Down
          : direction === 'left'
            ? sdk.ScrollDirection.Left
            : sdk.ScrollDirection.Right
    try {
      const result = await driver.scroll(
        sdk.ScrollInput.new({
          x,
          y,
          direction: mappedDirection,
          by: sdk.ScrollBy.Line,
          amount: BigInt(Math.max(1, Math.round(amount))),
          target: new sdk.ActionTarget.Window({ pid: window.pid, windowId: BigInt(window.windowId) }),
        }),
        signal ? { signal } : undefined,
      )
      return toolResultToOutcome(result)
    } catch (error) {
      return errorOutcome('synthetic_events', 'Scroll', error)
    }
  }

  async close(): Promise<void> {
    this.closed = true
    const driver = this.driver
    this.driver = null
    if (!driver) return
    try {
      await driver.shutdown()
    } finally {
      if ('uniffiDestroy' in driver && typeof (driver as { uniffiDestroy?: unknown }).uniffiDestroy === 'function') {
        ;(driver as { uniffiDestroy: () => void }).uniffiDestroy()
      }
    }
  }
}
