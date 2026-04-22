// load-manager.js - Manages concurrent request load per node
import pino from 'pino'

const logger = pino()

export class LoadManager {
  constructor(config = {}) {
    this.MAX_CONCURRENT_PER_NODE = config.maxConcurrentPerNode || 3
    this.nodeLoad = new Map() // Maps nodeHost -> number of concurrent requests
  }

  /**
   * Increment load for a node
   * @param {string} nodeHost - host identifier (e.g., 'http://localhost:11434')
   * @throws {Error} if node is at capacity
   */
  incrementLoad(nodeHost) {
    const currentLoad = this.nodeLoad.get(nodeHost) || 0
    if (currentLoad >= this.MAX_CONCURRENT_PER_NODE) {
      throw new Error(
        `Node ${nodeHost} at capacity (${currentLoad}/${this.MAX_CONCURRENT_PER_NODE})`,
      )
    }
    this.nodeLoad.set(nodeHost, currentLoad + 1)
    logger.debug({ nodeHost, load: currentLoad + 1 }, 'Load incremented')
  }

  /**
   * Decrement load for a node
   * @param {string} nodeHost - host identifier
   */
  decrementLoad(nodeHost) {
    const currentLoad = this.nodeLoad.get(nodeHost) || 0
    const newLoad = Math.max(0, currentLoad - 1)
    this.nodeLoad.set(nodeHost, newLoad)
    logger.debug({ nodeHost, load: newLoad }, 'Load decremented')
  }

  /**
   * Get current load for a node
   * @param {string} nodeHost - host identifier
   * @returns {number} number of concurrent requests
   */
  getCurrentLoad(nodeHost) {
    return this.nodeLoad.get(nodeHost) || 0
  }

  /**
   * Check if node is at capacity
   * @param {string} nodeHost - host identifier
   * @returns {boolean}
   */
  isAtCapacity(nodeHost) {
    return this.getCurrentLoad(nodeHost) >= this.MAX_CONCURRENT_PER_NODE
  }

  /**
   * Get remaining capacity for a node
   * @param {string} nodeHost - host identifier
   * @returns {number} remaining slots
   */
  getCapacityRemaining(nodeHost) {
    return Math.max(
      0,
      this.MAX_CONCURRENT_PER_NODE - this.getCurrentLoad(nodeHost),
    )
  }

  /**
   * Get total active requests across all nodes
   * @returns {number}
   */
  getTotalActiveRequests() {
    return Array.from(this.nodeLoad.values()).reduce(
      (sum, load) => sum + load,
      0,
    )
  }

  /**
   * Clean up entries for nodes that no longer exist
   * @param {Set<string>} activeNodeHosts - set of node hosts that are reachable
   */
  cleanupOrphanedNodes(activeNodeHosts) {
    for (const [nodeHost] of this.nodeLoad) {
      if (!activeNodeHosts.has(nodeHost)) {
        this.nodeLoad.delete(nodeHost)
        logger.debug({ nodeHost }, 'Cleaned up orphaned node load entry')
      }
    }
  }
}
