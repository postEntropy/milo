import { AsyncLocalStorage } from 'node:async_hooks'

/** The tool currently executing, inherited by classifier calls it makes. */
export interface TraceContext {
  turn?: string
  session?: string
  surface?: string
  callId?: string
}

const context = new AsyncLocalStorage<TraceContext>()

export function withTraceContext<T>(value: TraceContext, work: () => T): T {
  return context.run(value, work)
}

export function currentTraceContext(): TraceContext | undefined {
  return context.getStore()
}
