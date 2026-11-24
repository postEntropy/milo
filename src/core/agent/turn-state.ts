import type { AgentEvent } from './events.js'

/**
 * Observable phase of an active turn.
 *
 * `waiting-response` is distinct from `thinking`: waiting for the provider to
 * start answering (or when a wire does not signal reasoning) must never be
 * presented as the model actively thinking.
 */
export type TurnWaitPhase =
  | 'waiting-response'
  | 'thinking'
  | 'writing'
  | 'tool'
  | 'asking'
  | 'waiting'
  | 'compacting'
  | 'waiting-job'
  | 'done'

export interface TurnWaitState {
  phase: TurnWaitPhase
  /** Total observed reasoning duration in milliseconds across completed reasoning blocks. */
  thoughtMs?: number
  /** True if a reasoning block was observed without measurable start/end boundaries. */
  hasUnobservedReasoning?: boolean
}

export interface WaitIndicator {
  kind: 'dots' | 'text'
  label: string
  icon?: 'spark' | 'light'
}

export function initialTurnWaitState(): TurnWaitState {
  return { phase: 'waiting-response' }
}

function invalidateDuration(state: TurnWaitState, phase: TurnWaitPhase): TurnWaitState {
  const { thoughtMs: _dropped, ...rest } = state
  return { ...rest, phase, hasUnobservedReasoning: true }
}

function transitionNonThinking(state: TurnWaitState, nextPhase: TurnWaitPhase): TurnWaitState {
  if (state.phase === 'thinking') {
    return invalidateDuration(state, nextPhase)
  }
  return state.phase === nextPhase ? state : { ...state, phase: nextPhase }
}

/**
 * Single state transition for an active turn across surfaces.
 *
 * Surfaces use this so CLI, web, gateway runner and session persistence interpret
 * the exact same `AgentEvent` stream in one way.
 */
export function reduceTurnWaitState(state: TurnWaitState, event: AgentEvent): TurnWaitState {
  switch (event.type) {
    case 'response-waiting':
    case 'waited':
    case 'compacted':
    case 'steer':
    case 'tool-end':
    case 'job-waited':
      return transitionNonThinking(state, 'waiting-response')
    case 'waiting':
      return transitionNonThinking(state, 'waiting')
    case 'compacting':
      return transitionNonThinking(state, 'compacting')
    case 'job-waiting':
      return transitionNonThinking(state, 'waiting-job')
    case 'reasoning-start':
      return state.phase === 'thinking' ? state : { ...state, phase: 'thinking' }
    case 'reasoning-delta':
      if (event.replayed) {
        return invalidateDuration(state, state.phase)
      }
      if (state.phase === 'thinking') return state
      return invalidateDuration(state, 'thinking')
    case 'reasoning-end': {
      const phase: TurnWaitPhase = state.phase === 'thinking' ? 'waiting-response' : state.phase
      if (typeof event.ms === 'number' && Number.isFinite(event.ms) && event.ms >= 0) {
        if (state.hasUnobservedReasoning) {
          const { thoughtMs: _dropped, ...rest } = state
          return { ...rest, phase }
        }
        return { ...state, phase, thoughtMs: (state.thoughtMs ?? 0) + event.ms }
      }
      return invalidateDuration(state, phase)
    }
    case 'text-delta':
      return transitionNonThinking(state, 'writing')
    case 'ui':
      return event.draft ? transitionNonThinking(state, 'writing') : state
    case 'tool-start':
      return transitionNonThinking(state, 'tool')
    case 'bot-start':
      return { phase: 'waiting-response' }
    case 'bot-end':
    case 'done':
    case 'aborted':
    case 'error':
      return transitionNonThinking(state, 'done')
    default:
      return state
  }
}

/**
 * Final reportable thinking duration in milliseconds, or `undefined` when no
 * observable reasoning lasted at least one second.
 */
export function finalThoughtMs(state: Pick<TurnWaitState, 'thoughtMs' | 'hasUnobservedReasoning'>): number | undefined {
  if (state.hasUnobservedReasoning) return undefined
  if (state.thoughtMs === undefined || state.thoughtMs < 1000) return undefined
  return state.thoughtMs
}

/**
 * Wait-line label and icon for the browser and phone, when a turn is waiting on
 * the model rather than drawing prose, a tool row, or a session status.
 */
export function waitIndicator(phase: TurnWaitPhase | undefined): WaitIndicator | null {
  if (phase === 'thinking') return { kind: 'text', label: 'Thinking', icon: 'light' }
  if (phase === 'waiting-response') return { kind: 'dots', label: 'Waiting for response' }
  return null
}

/**
 * Status-line label for the terminal UI.
 */
export function cliStatusLabel(
  phase: TurnWaitPhase | 'idle',
  detail?: { toolName?: string },
): string {
  switch (phase) {
    case 'asking':
      return 'waiting for confirmation'
    case 'compacting':
      return 'folding the oldest turns into the summary…'
    case 'waiting':
      return 'waiting for another Milo on this session…'
    case 'waiting-job':
    case 'tool':
      return `${detail?.toolName || 'working'}…`
    case 'writing':
      return 'writing…'
    case 'thinking':
      return 'thinking…'
    default:
      return '…'
  }
}
