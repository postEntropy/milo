/**
 * One-shot permission decisions awaited by a gateway (an inline button press in
 * Telegram or Discord). Resolves `false` if nobody answers in time.
 */
export class PendingDecisions {
  private readonly waiters = new Map<string, (allowed: boolean) => void>()

  /**
   * Waits for the answer. A stopped turn resolves it too, as a **denial**: the
   * wait would otherwise keep the turn parked for its full timeout — the typing
   * indicator on, the queue blocked — and a ✅ pressed afterwards would run the
   * very tool the stop was meant to prevent.
   */
  wait(id: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout>
      const finish = (allowed: boolean): void => {
        clearTimeout(timer)
        this.waiters.delete(id)
        signal?.removeEventListener('abort', stopped)
        resolve(allowed)
      }
      const stopped = (): void => finish(false)

      timer = setTimeout(stopped, timeoutMs)
      if (signal?.aborted) {
        finish(false)
        return
      }
      signal?.addEventListener('abort', stopped, { once: true })
      this.waiters.set(id, finish)
    })
  }

  /** Returns false when the id is unknown (already answered or expired). */
  resolve(id: string, allowed: boolean): boolean {
    const waiter = this.waiters.get(id)
    if (!waiter) return false
    this.waiters.delete(id)
    waiter(allowed)
    return true
  }

  get size(): number {
    return this.waiters.size
  }
}
