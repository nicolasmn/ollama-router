// force-model-store.ts - One-shot model override store for next request
// Set via dashboard → consumed on first routed request → auto-clears.

const TTL_MS = 10 * 60 * 1000 // 10 minutes

export interface ForceModelEntry {
  model: string
  expiresAt: number
}

export class ForceModelStore {
  #entry: ForceModelEntry | null = null
  #timer: ReturnType<typeof setTimeout> | null = null

  set(model: string): void {
    this.#clearTimer()
    const expiresAt = Date.now() + TTL_MS
    this.#entry = { model, expiresAt }
    this.#timer = setTimeout(() => {
      this.#entry = null
      this.#timer = null
    }, TTL_MS)
  }

  get(): ForceModelEntry | null {
    if (!this.#entry) return null
    if (Date.now() > this.#entry.expiresAt) {
      this.#clearTimer() // prevent dangling setTimeout firing on already-null entry
      this.#entry = null
      return null
    }
    return this.#entry
  }

  /** Consume the override — returns the model name and clears the entry. */
  consume(): string | null {
    const entry = this.get()
    if (!entry) return null
    this.clear()
    return entry.model
  }

  clear(): void {
    this.#clearTimer()
    this.#entry = null
  }

  #clearTimer(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
  }
}

/** Singleton used across router, admin routes, and ws-manager. */
export const forceModelStore = new ForceModelStore()
