// load-manager.js - Tracks active request load per node
import { createLogger } from './logger.js'

const logger = createLogger('load')

export class LoadManager {
  constructor(config = {}) {
    this.maxConcurrentPerNode = config.maxConcurrentPerNode || 5
    this.loads = new Map() // nodeHost -> current active request count
    this.onNodeLoadChange = config.onNodeLoadChange || null
  }

  getCurrentLoad(nodeHost) {
    return this.loads.get(nodeHost) || 0
  }

  incrementLoad(nodeHost) {
    const current = this.getCurrentLoad(nodeHost)
    if (current >= this.maxConcurrentPerNode) {
      logger.debug({ nodeHost, current, max: this.maxConcurrentPerNode }, 'Node at capacity')
      const err = new Error(`Node at capacity: ${nodeHost}`)
      err.statusCode = 429
      err.code = 'NODE_AT_CAPACITY'
      throw err
    }
    const next = current + 1
    this.loads.set(nodeHost, next)
    if (typeof this.onNodeLoadChange === 'function') {
      this.onNodeLoadChange(nodeHost, next)
    }
  }

  decrementLoad(nodeHost) {
    const current = this.getCurrentLoad(nodeHost)
    const next = Math.max(0, current - 1)
    this.loads.set(nodeHost, next)
    if (typeof this.onNodeLoadChange === 'function') {
      this.onNodeLoadChange(nodeHost, next)
    }
  }

  isAtCapacity(nodeHost) {
    return this.getCurrentLoad(nodeHost) >= this.maxConcurrentPerNode
  }

  /**
   * Remove load tracking entries for nodes no longer in the active inventory.
   * @param {Set<string>} activeHostSet - set of currently known node host URLs
   */
  cleanupOrphanedNodes(activeHostSet) {
    for (const host of this.loads.keys()) {
      if (!activeHostSet.has(host)) {
        this.loads.delete(host)
      }
    }
  }

  getLoadSummary() {
    const summary = {}
    for (const [host, load] of this.loads) {
      summary[host] = load
    }
    return summary
  }
}
