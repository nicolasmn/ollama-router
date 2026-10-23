// ws-manager.ts - WebSocket server for real-time dashboard updates
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import type { Server } from 'node:http'
import type { DiscoveryManager } from './discovery-manager.js'
import type { LoadManager } from './load-manager.js'
import type { RequestHistoryManager, RequestEntry } from './request-history.js'
import { forceModelStore } from './force-model-store.js'
import { disabledModelsStore } from './disabled-models-store.js'
import { cloudUsageStore } from './cloud-usage.js'

const BROADCAST_INTERVAL_MS = 2000
const ACTIVE_STATUSES = new Set(['waiting', 'running'])

export interface WsManagerConfig {
  server: Server
  discoveryManager: DiscoveryManager
  loadManager: LoadManager
  requestHistoryManager: RequestHistoryManager
}

function getLastAttempt(request: RequestEntry) {
  const attempts = Array.isArray(request.attempts) ? request.attempts : []
  return attempts[attempts.length - 1] || null
}

function deriveDisplayStatuses(requests: RequestEntry[]): RequestEntry[] {
  const byNode = new Map<string, RequestEntry[]>()
  for (const request of requests) {
    if (!ACTIVE_STATUSES.has(request.status)) continue
    const lastAttempt = getLastAttempt(request)
    if (!lastAttempt?.nodeHost) continue
    if (!byNode.has(lastAttempt.nodeHost)) byNode.set(lastAttempt.nodeHost, [])
    byNode.get(lastAttempt.nodeHost)!.push(request)
  }
  for (const pending of byNode.values()) {
    pending.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    for (let i = 0; i < pending.length; i++) {
      pending[i].status = i === 0 ? 'running' : 'waiting'
    }
  }
  return requests
}

export class WsManager {
  #wss: WebSocketServer
  #discoveryManager: DiscoveryManager
  #loadManager: LoadManager
  #requestHistoryManager: RequestHistoryManager
  #interval: ReturnType<typeof setInterval> | null = null

  constructor({
    server,
    discoveryManager,
    loadManager,
    requestHistoryManager,
  }: WsManagerConfig) {
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

    // Full message threads can be large; the periodic broadcast only needs
    // routing metadata. The dashboard fetches message details via
    // GET /admin/requests/:id (hydration) when a drawer is opened.
    const slimmedRequests = recentRequests.map((request) => ({
      ...request,
      messageList: undefined,
      hasMessages: Array.isArray(request.messageList) && request.messageList.length > 0,
    }))

    const activeModels = new Map<string, Map<string, number>>()
    for (const req of recentRequests) {
      if (req.status !== 'running') continue
      const lastAttempt = getLastAttempt(req)
      if (!lastAttempt) continue
      const byModel =
        activeModels.get(lastAttempt.nodeHost) || new Map<string, number>()
      byModel.set(
        lastAttempt.modelName,
        (byModel.get(lastAttempt.modelName) || 0) + 1,
      )
      activeModels.set(lastAttempt.nodeHost, byModel)
    }

    const nodes = Object.fromEntries(
      Array.from(inventory.entries()).map(([nodeHost, node]) => {
        const isCloud = node.cloud ?? false
        return [
          nodeHost,
          {
            host: node.host,
            reachable: node.reachable,
            cloud: isCloud,
            lastSeen: node.lastSeen,
            mac: node.mac,
            activeRequests: this.#loadManager.getCurrentLoad(nodeHost),
            // Cloud nodes have no concurrency cap — null hides the capacity bar in the UI
            maxConcurrentRequests: isCloud
              ? null
              : this.#loadManager.getMaxConcurrentPerNode(),
            atCapacity: this.#loadManager.isAtCapacity(nodeHost),
            utilization: this.#loadManager.getUtilization(nodeHost),
            models: Object.fromEntries(
              Array.from(node.models.entries()).map(
                ([modelName, modelInfo]) => [
                  modelName,
                  {
                    name: modelInfo.name,
                    family: modelInfo.family,
                    size: modelInfo.size,
                    profile: modelInfo.profile,
                    recentLatency: modelInfo.recentLatency,
                    recentTps: modelInfo.recentTps,
                    recentTtft: modelInfo.recentTtft,
                    recentLoadMs: modelInfo.recentLoadMs,
                    failures: modelInfo.failures,
                    totalRequests: modelInfo.totalRequests || 0,
                    activeRequests:
                      activeModels.get(nodeHost)?.get(modelName) || 0,
                    lastRoutingEndpoint: modelInfo.lastRoutingEndpoint,
                    lastRoutedAt: modelInfo.lastRoutedAt,
                    disabled: disabledModelsStore.isDisabled(
                      nodeHost,
                      modelName,
                    ),
                  },
                ],
              ),
            ),
          },
        ]
      }),
    )

    const forceOverrideEntry = forceModelStore.get()
    const forceOverride = forceOverrideEntry
      ? { model: forceOverrideEntry.model, expiresAt: forceOverrideEntry.expiresAt }
      : null

    return {
      type: 'inventory',
      data: {
        timestamp: Date.now(),
        nodes,
        requests: slimmedRequests,
        forceOverride,
        cloudUsage: cloudUsageStore.get(),
        scan: {
          inProgress: scanStatus.inProgress,
          lastScanMs: scanStatus.lastScanMs,
          lastScanAgo: scanStatus.lastScanAgo,
          nextScanInterval:
            this.#discoveryManager._determineNextScanInterval(),
          isNetworkConnected:
            this.#discoveryManager.isConnectedToNetworkNodes(),
        },
      },
    }
  }

  #broadcast(payload: unknown): void {
    const message = JSON.stringify(payload)
    for (const client of this.#wss.clients) {
      if ((client as WebSocket).readyState === 1) {
        ;(client as WebSocket).send(message)
      }
    }
  }

  #setup(): void {
    this.#wss.on('connection', (ws: WebSocket) => {
      ws.send(JSON.stringify(this.#buildPayload()))
    })
    this.#interval = setInterval(() => {
      if (this.#wss.clients.size > 0) {
        this.#broadcast(this.#buildPayload())
      }
    }, BROADCAST_INTERVAL_MS)
  }

  stop(): void {
    if (this.#interval) {
      clearInterval(this.#interval)
      this.#interval = null
    }
    this.#wss.close()
  }
}
