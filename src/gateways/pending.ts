import type { PermissionResult } from '../core/tools/permission.js'

/**
 * One-shot permission decisions awaited by a gateway (an inline button press in
 * Telegram or Discord). Resolves a denial if nobody answers in time.
 *
 * A waiter may name the session the question was put to. An answer is then the act
 * of that session — a different one holding the same id cannot resolve it.
 */
export class PendingDecisions {
  private readonly waiters = new Map<string, { finish: (result: PermissionResult) => void; owner?: string }>()

  /**
   * Waits for the answer. A stopped turn resolves it too, as a **denial**: the
   * wait would otherwise keep the turn parked for its full timeout — the typing
   * indicator on, the queue blocked — and a ✅ pressed afterwards would run the
   * very tool the stop was meant to prevent.
   */
  wait(id: string, timeoutMs: number, signal?: AbortSignal, owner?: string): Promise<PermissionResult> {
    return new Promise<PermissionResult>((resolve) => {
      let timer: ReturnType<typeof setTimeout>
      const finish = (result: PermissionResult): void => {
        clearTimeout(timer)
        this.waiters.delete(id)
        signal?.removeEventListener('abort', stopped)
        resolve(result)
      }
      const stopped = (): void => finish({ allowed: false })

      timer = setTimeout(stopped, timeoutMs)
      if (signal?.aborted) {
        finish({ allowed: false })
        return
      }
      signal?.addEventListener('abort', stopped, { once: true })
      this.waiters.set(id, { finish, ...(owner !== undefined ? { owner } : {}) })
    })
  }

  /**
   * Returns false when the id is unknown (already answered or expired), or when an
   * owner was named and the answer comes from someone else.
   */
  resolve(id: string, result: PermissionResult, owner?: string): boolean {
    const waiter = this.waiters.get(id)
    if (!waiter) return false
    if (waiter.owner !== undefined && waiter.owner !== owner) return false
    this.waiters.delete(id)
    waiter.finish(result)
    return true
  }

  get size(): number {
    return this.waiters.size
  }
}
