// ws-manager.js - WebSocket server for real-time dashboard updates
import { WebSocketServer } from 'ws'

const BROADCAST_INTERVAL_MS = 2000

export class WsManager {
  /** @type {WebSocketServer} */
  #wss

  /** @type {import('./discovery-manager.js').DiscoveryManager} */
  #discoveryManager

  /** @type {import('./load-manager.js').LoadManager} */
  #loadManager

  /** @type {ReturnType<typeof setInterval> | null} */
  #interval = null

  /**
   * @param {object} opts
   * @param {import('node:http').Server} opts.server - HTTP server to attach to
   * @param {import('./discovery-manager.js').DiscoveryManager} opts.discoveryManager
   * @param {import('./load-manager.js').LoadManager} opts.loadManager
   */
  constructor({ server, discoveryManager, loadManager }) {
    this.#discoveryManager = discoveryManager
    this.#loadManager = loadManager
    this.#wss = new WebSocketServer({ server, path: '/ws' })
    this.#setup()
  }

  #buildPayload() {
    const inventory = this.#discoveryManager.getNodes()

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
                lastRoutingEndpoint: modelInfo.lastRoutingEndpoint,
                lastRoutedAt: modelInfo.lastRoutedAt,
              },
            ]),
          ),
        },
      ]),
    )

    return { type: 'inventory', data: { timestamp: Date.now(), nodes } }
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
