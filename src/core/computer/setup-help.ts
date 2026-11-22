import type { ComputerCapabilityStatus, HyprlandPluginState } from './types.js'

export const OMARCHY_ACTIVATION_GUIDE =
  'https://github.com/omacom/omarchy-pkgs/blob/master/pkgbuilds/cua-hyprland-plugin/README.md'

export const HYPRLAND_PLUGIN_PACKAGE = 'cua-hyprland-plugin'

export const COMPUTER_SETUP_HELP_LABEL = 'Ask Milo for help'

export type ComputerSetupHelpState =
  | 'installed_not_loaded'
  | 'loaded_discovery_only'
  | 'loaded_disabled'

export interface ComputerSetupHelp {
  label: string
  state: ComputerSetupHelpState
  prompt: string
}

export interface ComputerStatusWithHelp extends ComputerCapabilityStatus {
  setupHelp: ComputerSetupHelp | null
}

/** Single-line Hyprland plugin state tag shared by probes, settings, and setup prompts. */
export function hyprlandPluginSummaryTag(state: HyprlandPluginState): string | null {
  switch (state) {
    case 'not_installed':
      return 'Hyprland plugin not installed'
    case 'installed_not_loaded':
      return 'Hyprland plugin installed, not loaded'
    case 'loaded_discovery_only':
      return 'Hyprland plugin loaded. Background input unavailable.'
    case 'loaded_abi_mismatch':
      return 'Hyprland plugin ABI mismatch'
    case 'loaded_unsupported_protocol':
      return 'Hyprland input protocol unsupported'
    case 'loaded_transport_stopped':
      return 'Hyprland input transport stopped'
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

/** Actionable limitation description for non-ready Hyprland plugin states. */
export function hyprlandPluginLimitation(state: HyprlandPluginState): string | null {
  switch (state) {
    case 'not_installed':
      return `Hyprland Cua plugin (${HYPRLAND_PLUGIN_PACKAGE}) is not installed. Background pixel clicks and keyboard input on native Wayland windows require it; window capture and AT-SPI accessibility actions remain available where supported. See the Omarchy activation guide: ${OMARCHY_ACTIVATION_GUIDE}`
    case 'installed_not_loaded':
      return `Hyprland Cua plugin is installed but not loaded in the compositor. Load it and check whether it announces background input support before enabling input; window capture and AT-SPI accessibility actions remain available where supported. See the Omarchy activation guide: ${OMARCHY_ACTIVATION_GUIDE}`
    case 'loaded_discovery_only':
      return `Hyprland plugin loaded. Background input unavailable. This module only announces discovery support, so background Wayland input cannot be enabled on it; window capture and AT-SPI accessibility actions remain available where supported. Check whether the current Omarchy channel offers a compatible package with input support for your installed Hyprland version (${OMARCHY_ACTIVATION_GUIDE}).`
    case 'loaded_abi_mismatch':
      return 'Hyprland Cua plugin ABI does not match the running Hyprland compositor. Background input is unavailable until a matching cua-hyprland-plugin package is installed; window capture and AT-SPI accessibility actions remain available where supported.'
    case 'loaded_unsupported_protocol':
      return 'Hyprland Cua plugin reported an input protocol other than v3. Background input is unavailable until a compatible cua-hyprland-plugin build supporting v3 input is installed; window capture and AT-SPI accessibility actions remain available where supported.'
    case 'loaded_transport_stopped':
      return 'Hyprland Cua plugin is loaded, but its Cua input transport is stopped or not ready. Inspect `hyprctl -j cua:status` for transport state or errors; window capture and AT-SPI accessibility actions remain available where supported.'
    case 'loaded_disabled':
      return `Hyprland Cua plugin is loaded with input support confirmed, and compositor input is currently disabled. Enable plugin:cua:enabled in Hyprland config and reload; window capture and AT-SPI accessibility actions remain available where supported. See the Omarchy activation guide: ${OMARCHY_ACTIVATION_GUIDE}`
    case 'unverified':
      return 'Hyprland Cua plugin status could not be verified via `hyprctl -j cua:status`. Window capture and AT-SPI accessibility actions remain available where supported.'
    case 'input_available':
    case 'not_applicable':
      return null
  }
}

/** Contextual refusal explanation when an input action is refused on a Hyprland host. */
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

/** True when the structured Hyprland probe state offers guided Milo setup help. */
export function isComputerSetupHelpState(
  state: HyprlandPluginState | undefined,
): state is ComputerSetupHelpState {
  return (
    state === 'installed_not_loaded' ||
    state === 'loaded_discovery_only' ||
    state === 'loaded_disabled'
  )
}

function formatDetectedDiagnostics(
  status: ComputerCapabilityStatus,
  state: ComputerSetupHelpState,
): string {
  const modes = [
    `accessibility=${status.inputModes.accessibility ? 'yes' : 'no'}`,
    `windowScopedPointer=${status.inputModes.windowScopedPointer ? 'yes' : 'no'}`,
    `xsendEvent=${status.inputModes.xsendEvent ? 'yes' : 'no'}`,
    `hyprlandPlugin=${status.inputModes.hyprlandPlugin ? 'yes' : 'no'}`,
  ].join(', ')
  const tag = hyprlandPluginSummaryTag(state) ?? state
  return [
    `- Hyprland plugin state: ${state} (${tag})`,
    `- Probe summary: ${status.summary}`,
    `- Backend available: ${status.available ? 'yes' : 'no'}`,
    `- Host: ${status.platform} · display server: ${status.displayServer}${status.sdkVersion ? ` · SDK ${status.sdkVersion}` : ''}`,
    `- Capabilities: waylandEnabled=${status.waylandEnabled ? 'yes' : 'no'}, atspiAvailable=${status.atspiAvailable ? 'yes' : 'no'}, screenCaptureAvailable=${status.screenCaptureAvailable ? 'yes' : 'no'}`,
    `- Input modes: ${modes}`,
  ].join('\n')
}

function buildComputerSetupHelpPrompt(
  status: ComputerCapabilityStatus,
  state: ComputerSetupHelpState,
): string {
  const situation =
    state === 'installed_not_loaded'
      ? 'the Hyprland Cua plugin is installed, but not loaded in the compositor'
      : state === 'loaded_discovery_only'
        ? 'the Hyprland Cua plugin is loaded in discovery-only mode, so background input is unavailable'
        : 'the Hyprland Cua plugin is loaded with input support confirmed, but compositor input is currently disabled'

  const details = [
    ...(status.reason && !status.available ? [status.reason] : []),
    ...status.limitations,
  ].filter((line, index, all) => line.trim().length > 0 && all.indexOf(line) === index)

  const stateInstructions =
    state === 'loaded_discovery_only'
      ? [
          '1. Check the current state on this host first (`hyprctl -j cua:status`, installed Hyprland version, installed `cua-hyprland-plugin` package version and announced capabilities, and the configured Omarchy repository/channel).',
          `2. Consult the official Omarchy activation guide (${OMARCHY_ACTIVATION_GUIDE}) and check whether the current Omarchy channel offers a compatible \`cua-hyprland-plugin\` package with background input support for the installed Hyprland version.`,
          '3. Explain clearly what you found—including why background input is unavailable in this discovery-only module and whether an updated/compatible package is available on the current Omarchy channel.',
          '4. Ask for my confirmation before applying any changes, upgrading packages, editing Hyprland config, or reloading the compositor.',
        ]
      : state === 'loaded_disabled'
        ? [
            '1. Check the current state on this host first (`hyprctl -j cua:status`, confirmed `capabilities.supported`, package/plugin status, and relevant Hyprland configuration files).',
            `2. Consult the official Omarchy activation guide (${OMARCHY_ACTIVATION_GUIDE}) so your recommendations match Omarchy's documented steps.`,
            '3. Explain clearly what you found and which exact changes are needed (such as enabling `plugin:cua:enabled` and reloading, since background input support is confirmed on the loaded module).',
            '4. Ask for my confirmation before applying any changes, editing Hyprland config, loading plugins, or reloading the compositor.',
          ]
        : [
            '1. Check the current state on this host first (for example `hyprctl -j cua:status`, package/plugin status, and relevant Hyprland configuration files).',
            `2. Consult the official Omarchy activation guide (${OMARCHY_ACTIVATION_GUIDE}) so your recommendations match Omarchy's documented steps.`,
            '3. Explain clearly what you found and which exact changes are needed to load the plugin; once loaded, verify whether `capabilities.supported` confirms background input support before enabling input.',
            '4. Ask for my confirmation before applying any changes, editing Hyprland config, loading plugins, or reloading the compositor.',
          ]

  return [
    `Help me set up Computer Use on this Hyprland host. The probe detected that ${situation}.`,
    '',
    'Detected Computer Use diagnostics:',
    formatDetectedDiagnostics(status, state),
    ...(details.length > 0
      ? ['', 'Reported limitations:', ...details.map((item) => `- ${item}`)]
      : []),
    '',
    `Official Omarchy activation guide: ${OMARCHY_ACTIVATION_GUIDE}`,
    '',
    'Please:',
    ...stateInstructions,
    '5. After I confirm and an authorized fix is applied, verify the Computer Use / Hyprland plugin status again and report the updated state.',
  ].join('\n')
}

/**
 * Returns the guided setup action and prompt when the structured probe state indicates
 * an installed-but-unloaded, loaded discovery-only, or loaded-but-disabled Hyprland Cua plugin, or null otherwise.
 */
export function computerSetupHelp(
  status: ComputerCapabilityStatus | null | undefined,
): ComputerSetupHelp | null {
  const state = status?.hyprlandPluginState
  if (!status || !isComputerSetupHelpState(state)) return null
  return {
    label: COMPUTER_SETUP_HELP_LABEL,
    state,
    prompt: buildComputerSetupHelpPrompt(status, state),
  }
}

/** Attaches the core-derived `setupHelp` descriptor to a Computer Use probe status. */
export function withComputerSetupHelp(status: ComputerCapabilityStatus): ComputerStatusWithHelp {
  return {
    ...status,
    setupHelp: computerSetupHelp(status),
  }
}

/** Shared `/computer setup` response when guided Hyprland setup is not applicable. */
export function computerSetupUnavailableReply(status: ComputerCapabilityStatus): string {
  switch (status.hyprlandPluginState) {
    case 'input_available':
      return `Hyprland Computer Use input is already ready (${status.summary}).`
    case 'not_installed':
      return `Hyprland Cua plugin is not installed (${status.summary}). See the Omarchy activation guide: ${OMARCHY_ACTIVATION_GUIDE}`
    case 'loaded_abi_mismatch':
      return `Hyprland Cua plugin ABI does not match the running Hyprland compositor (${status.summary}). Install a matching cua-hyprland-plugin package for this Hyprland build.`
    case 'loaded_unsupported_protocol':
      return `Hyprland Cua plugin uses an unsupported input protocol (${status.summary}). Install a cua-hyprland-plugin build supporting v3 input.`
    case 'loaded_transport_stopped':
      return `Hyprland Cua plugin input transport is stopped (${status.summary}). Inspect hyprctl -j cua:status for transport errors.`
    case 'unverified':
      return `Hyprland Cua plugin status could not be verified (${status.summary}). Check that Hyprland is running and try again.`
    case 'not_applicable':
    case undefined:
      return `Hyprland Cua plugin setup only applies on a Hyprland Linux host (${status.summary}).`
    case 'installed_not_loaded':
    case 'loaded_discovery_only':
    case 'loaded_disabled':
      return status.summary
  }
}
