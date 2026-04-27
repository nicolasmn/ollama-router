// ws-manager.js - WebSocket server for real-time dashboard updates
import { WebSocketServer } from 'ws'

const BROADCAST_INTERVAL_MS = 2000
const ACTIVE_STATUSES = new Set(['waiting', 'running'])

function getLastAttempt(request) {
  const attempts = Array.isArray(request.attempts) ? request.attempts : []
  return attempts[attempts.length - 1] || null
}

function deriveDisplayStatuses(requests) {
  const byNode = new Map()

  for (const request of requests) {
    if (!ACTIVE_STATUSES.has(request.status)) continue
    const lastAttempt = getLastAttempt(request)
    if (!lastAttempt?.nodeHost) continue

    if (!byNode.has(lastAttempt.nodeHost)) {
      byNode.set(lastAttempt.nodeHost, [])
    }
    byNode.get(lastAttempt.nodeHost).push(request)
  }

  for (const pending of byNode.values()) {
    pending.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    for (let index = 0; index < pending.length; index += 1) {
      pending[index].status = index === 0 ? 'running' : 'waiting'
    }
  }

  return requests
}

export class WsManager {
  /** @type {WebSocketServer} */
  #wss

  /** @type {import('./discovery-manager.js').DiscoveryManager} */
  #discoveryManager

  /** @type {import('./load-manager.js').LoadManager} */
  #loadManager

  /** @type {import('./request-history.js').RequestHistoryManager} */
  #requestHistoryManager

  /** @type {ReturnType<typeof setInterval> | null} */
  #interval = null

  /**
   * @param {object} opts
   * @param {import('node:http').Server} opts.server - HTTP server to attach to
   * @param {import('./discovery-manager.js').DiscoveryManager} opts.discoveryManager
   * @param {import('./load-manager.js').LoadManager} opts.loadManager
   * @param {import('./request-history.js').RequestHistoryManager} opts.requestHistoryManager
   */
  constructor({
    server,
    discoveryManager,
    loadManager,
    requestHistoryManager,
  }) {
    this.#discoveryManager = discoveryManager
    this.#loadManager = loadManager
    this.#requestHistoryManager = requestHistoryManager
    this.#wss = new WebSocketServer({ server, path: '/ws' })
    this.#setup()
  }

  #buildPayload() {
    const inventory = this.#discoveryManager.getNodes()
    const recentRequests = deriveDisplayStatuses(
      this.#requestHistoryManager.getRecentRequests(),
    )
    const scanStatus = this.#discoveryManager.getScanStatus()

    // Derive which models are actively serving running requests
    const activeModels = new Map() // nodeHost -> Map<modelName, count>
    for (const req of recentRequests) {
      if (req.status !== 'running') continue
      const lastAttempt = getLastAttempt(req)
      if (!lastAttempt) continue
      const byModel = activeModels.get(lastAttempt.nodeHost) || new Map()
      byModel.set(
        lastAttempt.modelName,
        (byModel.get(lastAttempt.modelName) || 0) + 1,
      )
      activeModels.set(lastAttempt.nodeHost, byModel)
    }

    const nodes = Object.fromEntries(
      Array.from(inventory.entries()).map(([nodeHost, node]) => [
        nodeHost,
        {
          host: node.host,
          reachable: node.reachable,
          lastSeen: node.lastSeen,
          activeRequests: this.#loadManager.getCurrentLoad(nodeHost),
          models: Object.fromEntries(
            Array.from(node.models.entries()).map(([modelName, modelInfo]) => [
              modelName,
              {
                name: modelInfo.name,
                family: modelInfo.family,
                size: modelInfo.size,
                profile: modelInfo.profile,
                recentLatency: modelInfo.recentLatency,
                recentTps: modelInfo.recentTps,
                failures: modelInfo.failures,
                totalRequests: modelInfo.totalRequests || 0,
                activeRequests: activeModels.get(nodeHost)?.get(modelName) || 0,
                lastRoutingEndpoint: modelInfo.lastRoutingEndpoint,
                lastRoutedAt: modelInfo.lastRoutedAt,
              },
            ]),
          ),
        },
      ]),
    )

    return {
      type: 'inventory',
      data: {
        timestamp: Date.now(),
        nodes,
        requests: recentRequests,
        scan: {
          inProgress: scanStatus.inProgress,
          lastScanMs: scanStatus.lastScanMs,
          lastScanAgo: scanStatus.lastScanAgo,
          nextScanInterval: this.#discoveryManager._determineNextScanInterval(),
          isNetworkConnected:
            this.#discoveryManager.isConnectedToNetworkNodes(),
        },
      },
    }
  }

  #broadcast(payload) {
    const message = JSON.stringify(payload)
    for (const client of this.#wss.clients) {
      if (client.readyState === 1 /* OPEN */) {
        client.send(message)
      }
    }
  }

  #setup() {
    this.#wss.on('connection', (ws) => {
      ws.send(JSON.stringify(this.#buildPayload()))
    })

    this.#interval = setInterval(() => {
      if (this.#wss.clients.size > 0) {
        this.#broadcast(this.#buildPayload())
      }
    }, BROADCAST_INTERVAL_MS)
  }

  stop() {
    if (this.#interval) {
      clearInterval(this.#interval)
      this.#interval = null
    }
    this.#wss.close()
  }
}
