/**
 * One-shot permission decisions awaited by a gateway (an inline button press in
 * Telegram or Discord). Resolves `false` if nobody answers in time.
 */
export class PendingDecisions {
  private readonly waiters = new Map<string, (allowed: boolean) => void>()

  wait(id: string, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id)
        resolve(false)
      }, timeoutMs)
      this.waiters.set(id, (allowed) => {
        clearTimeout(timer)
        resolve(allowed)
      })
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
