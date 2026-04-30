// load-manager.ts - Tracks concurrent in-flight requests per node
import { createLogger } from './logger.js'

const logger = createLogger('load')

export interface LoadManagerConfig {
  maxConcurrentPerNode?: number
}

export class LoadManager {
  private loads: Map<string, number>
  private maxConcurrent: number

  constructor({ maxConcurrentPerNode = 3 }: LoadManagerConfig = {}) {
    this.loads = new Map()
    this.maxConcurrent = maxConcurrentPerNode
  }

  getCurrentLoad(nodeHost: string): number {
    return this.loads.get(nodeHost) ?? 0
  }

  canAcceptRequest(nodeHost: string): boolean {
    return this.getCurrentLoad(nodeHost) < this.maxConcurrent
  }

  incrementLoad(nodeHost: string): void {
    this.loads.set(nodeHost, this.getCurrentLoad(nodeHost) + 1)
  }

  decrementLoad(nodeHost: string): void {
    const current = this.getCurrentLoad(nodeHost)
    if (current > 0) {
      this.loads.set(nodeHost, current - 1)
    }
  }

  /** Remove load entries for hosts no longer present in inventory. */
  cleanupOrphanedNodes(activeHosts: Set<string>): void {
    for (const host of this.loads.keys()) {
      if (!activeHosts.has(host)) {
        this.loads.delete(host)
        logger.debug({ nodeHost: host }, 'Cleaned up orphaned load entry')
      }
    }
  }

  getAllLoads(): Map<string, number> {
    return new Map(this.loads)
  }
}
