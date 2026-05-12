// load-manager.ts - Per-node concurrent request tracking
import { createLogger } from './logger.js'

const logger = createLogger('load')

export interface LoadManagerConfig {
  maxConcurrentPerNode?: number
  onNodeLoadChange?: (nodeHost: string, currentLoad: number) => void
}

const DEFAULT_MAX_CONCURRENT = 3

export class LoadManager {
  private maxConcurrentPerNode: number
  private loads: Map<string, number>
  /** Nodes that bypass the concurrent request cap (e.g. cloud nodes). */
  private unlimitedNodes: Set<string>
  private onNodeLoadChange?: (nodeHost: string, currentLoad: number) => void

  constructor(config: LoadManagerConfig = {}) {
    this.maxConcurrentPerNode = config.maxConcurrentPerNode ?? DEFAULT_MAX_CONCURRENT
    this.loads = new Map()
    this.unlimitedNodes = new Set()
    this.onNodeLoadChange = config.onNodeLoadChange
  }

  /** Mark a node as having no concurrent request cap (e.g. ollama.com cloud). */
  setUnlimited(nodeHost: string): void {
    this.unlimitedNodes.add(nodeHost)
  }

  /** Remove the unlimited override for a node. */
  clearUnlimited(nodeHost: string): void {
    this.unlimitedNodes.delete(nodeHost)
  }

  getCurrentLoad(nodeHost: string): number {
    return this.loads.get(nodeHost) ?? 0
  }

  getMaxConcurrentPerNode(): number {
    return this.maxConcurrentPerNode
  }

  getUtilization(nodeHost: string): number {
    if (this.unlimitedNodes.has(nodeHost)) return 0
    const max = this.maxConcurrentPerNode
    if (max <= 0) return 0
    return this.getCurrentLoad(nodeHost) / max
  }

  /** Returns true when node is AT or OVER capacity (no more requests accepted). */
  isAtCapacity(nodeHost: string): boolean {
    if (this.unlimitedNodes.has(nodeHost)) return false
    return this.getCurrentLoad(nodeHost) >= this.maxConcurrentPerNode
  }

  /** Alias used internally by router. */
  canAcceptRequest(nodeHost: string): boolean {
    return !this.isAtCapacity(nodeHost)
  }

  incrementLoad(nodeHost: string): void {
    const current = this.getCurrentLoad(nodeHost)
    if (!this.unlimitedNodes.has(nodeHost) && current >= this.maxConcurrentPerNode) {
      throw new Error(`Node ${nodeHost} at capacity (${current}/${this.maxConcurrentPerNode})`)
    }
    const next = current + 1
    this.loads.set(nodeHost, next)
    this.onNodeLoadChange?.(nodeHost, next)
    logger.debug({ nodeHost, load: next }, 'Load incremented')
  }

  decrementLoad(nodeHost: string): void {
    const current = this.getCurrentLoad(nodeHost)
    const next = Math.max(0, current - 1)
    if (next === 0) {
      this.loads.delete(nodeHost)
    } else {
      this.loads.set(nodeHost, next)
    }
    this.onNodeLoadChange?.(nodeHost, next)
    logger.debug({ nodeHost, load: next }, 'Load decremented')
  }

  cleanupOrphanedNodes(activeNodeHosts: Set<string>): void {
    for (const nodeHost of this.loads.keys()) {
      if (!activeNodeHosts.has(nodeHost)) {
        this.loads.delete(nodeHost)
        logger.debug({ nodeHost }, 'Removed orphaned node from load map')
      }
    }
  }

  getSnapshot(): Record<string, number> {
    return Object.fromEntries(this.loads)
  }
}
