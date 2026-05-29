// disabled-models-store.ts - Per-node model disable list with JSON persistence.
// A disabled model stays in the inventory (so the UI can show it) but is
// excluded from all router candidate selection until re-enabled.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createLogger } from './logger.js'

const logger = createLogger('disabled-models')

interface PersistedFile {
  disabled: Record<string, string[]>
}

export class DisabledModelsStore {
  readonly #byHost: Map<string, Set<string>> = new Map()
  #filePath: string | null = null
  #loaded = false

  /** Configure persistence target. Loads existing entries from disk if present. */
  configure(filePath: string): void {
    this.#filePath = filePath
    this.#load()
  }

  isDisabled(host: string, modelName: string): boolean {
    return this.#byHost.get(host)?.has(modelName) ?? false
  }

  /** Returns names disabled on this host (empty array if none). */
  list(host: string): string[] {
    const set = this.#byHost.get(host)
    return set ? Array.from(set) : []
  }

  /** @returns true when state changed. */
  disable(host: string, modelName: string): boolean {
    let set = this.#byHost.get(host)
    if (!set) {
      set = new Set()
      this.#byHost.set(host, set)
    }
    if (set.has(modelName)) return false
    set.add(modelName)
    this.#persist()
    return true
  }

  /** @returns true when state changed. */
  enable(host: string, modelName: string): boolean {
    const set = this.#byHost.get(host)
    if (!set?.has(modelName)) return false
    set.delete(modelName)
    if (set.size === 0) this.#byHost.delete(host)
    this.#persist()
    return true
  }

  /** Test helper — reset in-memory state. Does not touch disk. */
  reset(): void {
    this.#byHost.clear()
    this.#loaded = false
    this.#filePath = null
  }

  #load(): void {
    if (this.#loaded || !this.#filePath) return
    this.#loaded = true
    try {
      const raw = readFileSync(this.#filePath, 'utf8')
      const parsed = JSON.parse(raw) as PersistedFile
      if (parsed?.disabled && typeof parsed.disabled === 'object') {
        for (const [host, names] of Object.entries(parsed.disabled)) {
          if (Array.isArray(names) && names.length > 0) {
            this.#byHost.set(
              host,
              new Set(names.filter((n) => typeof n === 'string')),
            )
          }
        }
      }
    } catch {
      // No file yet (or unreadable) — start empty.
    }
  }

  #persist(): void {
    if (!this.#filePath) return
    const output: PersistedFile = {
      disabled: Object.fromEntries(
        Array.from(this.#byHost.entries()).map(([host, set]) => [
          host,
          Array.from(set),
        ]),
      ),
    }
    try {
      mkdirSync(dirname(this.#filePath), { recursive: true })
      writeFileSync(this.#filePath, JSON.stringify(output, null, 2), 'utf8')
    } catch (err) {
      logger.error(
        { err: (err as Error).message, filePath: this.#filePath },
        'Failed to persist disabled models',
      )
    }
  }
}

/** Singleton shared between admin routes, router, and ws-manager. */
export const disabledModelsStore = new DisabledModelsStore()
