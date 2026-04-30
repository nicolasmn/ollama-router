// discovery-manager.ts
import { request } from 'undici'
import { NodeInfo, ModelInfo, ModelProfile } from './models.js'
import type { ModelProfileData } from './models.js'
import { NetworkScanner } from './network-scanner.js'
import { loadMetrics, saveMetrics } from './metrics-store.js'
import type { PersistedMetrics } from './metrics-store.js'
import { createLogger } from './logger.js'

const logger = createLogger('discovery')

export interface DiscoveryConfig {
  ollamaNodes?: string[]
  discoveryInterval?: number
  autoDiscover?: boolean
  networkScanInterval?: number
  networkScanIntervalActive?: number
  onInventoryUpdated?: ((inventory: Map<string, NodeInfo>) => void) | null
  metricsFile?: string | null
}

export interface ScanStatus {
  inProgress: boolean
  lastScanMs: number
  lastScanAgo: number
}

export class DiscoveryManager {
  OLLAMA_NODES: string[]
  DISCOVERY_INTERVAL: number
  autoDiscover: boolean
  NETWORK_SCAN_INTERVAL: number
  NETWORK_SCAN_INTERVAL_ACTIVE: number
  onInventoryUpdated: ((inventory: Map<string, NodeInfo>) => void) | null
  metricsFile: string | null
  inventory: Map<string, NodeInfo>
  periodicProbeHandle: ReturnType<typeof setInterval> | null
  networkScanHandle: ReturnType<typeof setInterval> | null
  metricsFlushHandle: ReturnType<typeof setInterval> | null
  networkScanner: NetworkScanner
  private _scanInProgress: boolean
  private _lastScanMs: number
  private _persistedMetrics: PersistedMetrics

  constructor(config: DiscoveryConfig = {}) {
    this.OLLAMA_NODES = config.ollamaNodes || []
    this.DISCOVERY_INTERVAL = config.discoveryInterval || 15000
    this.autoDiscover = config.autoDiscover ?? false
    this.NETWORK_SCAN_INTERVAL = config.networkScanInterval || 60000
    this.NETWORK_SCAN_INTERVAL_ACTIVE = config.networkScanIntervalActive || 1800000
    this.onInventoryUpdated = config.onInventoryUpdated || null
    this.metricsFile = config.metricsFile || null
    this.inventory = new Map()
    this.periodicProbeHandle = null
    this.networkScanHandle = null
    this.metricsFlushHandle = null
    this.networkScanner = new NetworkScanner()
    this._scanInProgress = false
    this._lastScanMs = 0
    this._persistedMetrics = this.metricsFile
      ? loadMetrics(this.metricsFile)
      : new Map()
  }

  notifyInventoryUpdated(): void {
    if (typeof this.onInventoryUpdated === 'function') {
      this.onInventoryUpdated(this.inventory)
    }
  }

  setInventoryUpdateHandler(
    handler: (inventory: Map<string, NodeInfo>) => void,
  ): void {
    this.onInventoryUpdated = handler
  }

  normalizeBaseUrl(host: string): string {
    if (host.startsWith('http')) return host
    return `http://${host}`
  }

  getScanStatus(): ScanStatus {
    const lastScanAgo =
      this._lastScanMs > 0 ? Date.now() - this._lastScanMs : -1
    return {
      inProgress: this._scanInProgress,
      lastScanMs: this._lastScanMs,
      lastScanAgo,
    }
  }

  isConnectedToNetworkNodes(): boolean {
    for (const [host] of this.inventory) {
      if (!this._isLocalhost(host)) return true
    }
    return false
  }

  _isLocalhost(url: string): boolean {
    try {
      const { hostname } = new URL(url)
      return (
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === '::1' ||
        hostname === '[::1]'
      )
    } catch {
      return false
    }
  }

  _determineNextScanInterval(): number {
    return this.isConnectedToNetworkNodes()
      ? this.NETWORK_SCAN_INTERVAL_ACTIVE
      : this.NETWORK_SCAN_INTERVAL
  }

  async getModelDetails(
    base: string,
    modelName: string,
  ): Promise<Record<string, unknown> | null> {
    try {
      const resp = await request(`${base}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelName }),
        headersTimeout: 5000,
        bodyTimeout: 5000,
      })
      if (resp.statusCode !== 200) return null
      return (await resp.body.json()) as Record<string, unknown>
    } catch {
      return null
    }
  }

  buildModelProfile(
    showData: Record<string, unknown> | null,
  ): ModelProfile {
    const capabilities = new Set<string>(
      ((showData?.capabilities as string[]) || []).map((c) =>
        String(c).toLowerCase(),
      ),
    )
    let parameters = 0
    let contextLength = 4096
    if (showData?.model_info && typeof showData.model_info === 'object') {
      const info = showData.model_info as Record<string, unknown>
      const rawParams = info['general.parameter_count']
      if (typeof rawParams === 'number' && rawParams > 0) {
        parameters = rawParams / 1e9
      }
      const contextKey = Object.keys(info).find((k) =>
        k.endsWith('.context_length'),
      )
      if (contextKey && typeof info[contextKey] === 'number') {
        contextLength = info[contextKey] as number
      }
    }
    return new ModelProfile({
      capabilities,
      parameters,
      contextLength,
      supportsTools: capabilities.has('tools'),
      supportsVision: capabilities.has('vision'),
      supportsAudio: capabilities.has('audio'),
      supportsThinking: capabilities.has('thinking'),
      isEmbedding:
        capabilities.has('embedding') || capabilities.has('embeddings'),
    })
  }

  async populateNodeModelsEnriched(
    base: string,
    modelsData: Array<Record<string, unknown>>,
  ): Promise<Map<string, ModelInfo>> {
    const models = new Map<string, ModelInfo>()
    const detailsPromises = modelsData.map((mdata) =>
      this.getModelDetails(base, mdata.name as string).then((showData) => ({
        mdata,
        showData,
      })),
    )
    const results = await Promise.allSettled(detailsPromises)
    for (const result of results) {
      if (result.status !== 'fulfilled') continue
      const { mdata, showData } = result.value
      const name = mdata.name as string
      const details = mdata.details as Record<string, unknown> | undefined
      const family =
        (details?.family as string) ||
        ((showData?.details as Record<string, unknown>)?.family as string) ||
        ''
      const size = (mdata.size as number) || 0
      const profile = this.buildModelProfile(showData)
      models.set(name, new ModelInfo(name, family, size, profile))
    }
    return models
  }

  async probeNode(host: string): Promise<NodeInfo> {
    const base = this.normalizeBaseUrl(host)
    const node = new NodeInfo(base)
    try {
      const versionResp = await request(`${base}/api/version`, {
        headersTimeout: 5000,
        bodyTimeout: 5000,
      })
      if (versionResp.statusCode !== 200)
        throw new Error(`Version ${versionResp.statusCode}`)
      await versionResp.body.dump()
      const tagsResp = await request(`${base}/api/tags`, {
        headersTimeout: 10000,
        bodyTimeout: 10000,
      })
      if (tagsResp.statusCode !== 200)
        throw new Error(`Tags ${tagsResp.statusCode}`)
      const tagsData = (await tagsResp.body.json()) as {
        models: Array<Record<string, unknown>>
      }
      const enrichedModels = await this.populateNodeModelsEnriched(
        base,
        tagsData.models || [],
      )
      for (const [name, modelInfo] of enrichedModels) {
        node.models.set(name, modelInfo)
      }
      node.reachable = true
      node.lastSeen = Date.now()
      logger.info(
        { nodeHost: base, modelCount: node.models.size },
        'Node ready',
      )
    } catch (err) {
      logger.warn(
        { nodeHost: base, err: (err as Error).message },
        'Node probe failed',
      )
      node.reachable = false
    }
    return node
  }

  mergeDiscoveredNodes(discoveredUrls: string[]): string[] {
    const existingNormalized = new Set(
      this.OLLAMA_NODES.map((n) => this.normalizeBaseUrl(n)),
    )
    const newHosts: string[] = []
    for (const url of discoveredUrls) {
      const normalized = this.normalizeBaseUrl(url)
      if (!existingNormalized.has(normalized)) {
        this.OLLAMA_NODES.push(url)
        existingNormalized.add(normalized)
        newHosts.push(normalized)
        logger.info({ nodeHost: url }, 'Auto-discovered node added')
      }
    }
    return newHosts
  }

  async discoverNetworkNodes(): Promise<void> {
    if (this._scanInProgress) return
    this._scanInProgress = true
    try {
      const discovered = await this.networkScanner.scanLocalNetwork()
      if (discovered.length > 0) {
        const newHosts = this.mergeDiscoveredNodes(discovered)
        if (newHosts.length > 0) {
          const tasks = newHosts.map((host) => this.probeNode(host))
          const results = await Promise.allSettled(tasks)
          let updated = false
          for (const res of results) {
            if (res.status === 'fulfilled') {
              this.inventory.set(res.value.host, res.value)
              if (res.value.reachable) updated = true
            }
          }
          if (updated) this.notifyInventoryUpdated()
        }
      }
    } finally {
      this._scanInProgress = false
      this._lastScanMs = Date.now()
    }
  }

  async initialize(): Promise<number> {
    if (this.autoDiscover) await this.discoverNetworkNodes()
    const initialTasks = this.OLLAMA_NODES.map((host) => this.probeNode(host))
    const initialResults = await Promise.allSettled(initialTasks)
    let reachableCount = 0
    for (const res of initialResults) {
      if (res.status === 'fulfilled') {
        this.inventory.set(res.value.host, res.value)
        if (res.value.reachable) reachableCount++
      }
    }
    logger.info(
      { reachable: reachableCount, total: this.inventory.size },
      'Discovery initialized',
    )
    this.notifyInventoryUpdated()
    return reachableCount
  }

  startPeriodicProbe(): void {
    if (this.periodicProbeHandle) return
    this.periodicProbeHandle = setInterval(async () => {
      await this.performProbe()
    }, this.DISCOVERY_INTERVAL)
    if (this.metricsFile) {
      this.metricsFlushHandle = setInterval(() => {
        saveMetrics(this.metricsFile as string, this.inventory)
      }, 60_000)
      this.metricsFlushHandle.unref()
    }
    if (this.autoDiscover) {
      this.networkScanHandle = setInterval(async () => {
        await this.discoverNetworkNodes()
      }, this.NETWORK_SCAN_INTERVAL)
    }
  }

  async performProbe(): Promise<void> {
    const tasks = this.OLLAMA_NODES.map((host) => this.probeNode(host))
    const results = await Promise.allSettled(tasks)
    const newInventory = new Map<string, NodeInfo>()
    for (const res of results) {
      if (res.status === 'fulfilled') {
        newInventory.set(res.value.host, res.value)
      }
    }
    this.mergeInventory(newInventory)
    this.notifyInventoryUpdated()
  }

  mergeInventory(newInventory: Map<string, NodeInfo>): void {
    const merged = new Map<string, NodeInfo>()
    for (const [host, freshNode] of newInventory) {
      const previousNode = this.inventory.get(host)
      if (previousNode && freshNode.reachable) {
        freshNode.failures = 0
        freshNode.lastFailure = previousNode.lastFailure ?? 0
        freshNode.activeRequests = previousNode.activeRequests ?? 0
        for (const [modelName, freshModel] of freshNode.models) {
          const previousModel = previousNode.models.get(modelName)
          if (previousModel) {
            freshModel.status = previousModel.status
            freshModel.activeRequests = previousModel.activeRequests
            freshModel.recentLatency = previousModel.recentLatency
            freshModel.recentTps = previousModel.recentTps
            freshModel.failures = previousModel.failures
            freshModel.totalRequests = previousModel.totalRequests
            freshModel.lastRoutingEndpoint = previousModel.lastRoutingEndpoint
            freshModel.lastRoutedAt = previousModel.lastRoutedAt
          } else {
            this._applyPersistedMetrics(host, modelName, freshModel)
          }
        }
      } else if (!previousNode && freshNode.reachable) {
        for (const [modelName, freshModel] of freshNode.models) {
          this._applyPersistedMetrics(host, modelName, freshModel)
        }
      } else if (previousNode) {
        freshNode.failures = (previousNode.failures ?? 0) + 1
        freshNode.lastFailure = Date.now()
        freshNode.lastSeen = previousNode.lastSeen
        freshNode.models = previousNode.models
      }
      merged.set(host, freshNode)
    }
    this.inventory = merged
  }

  private _applyPersistedMetrics(
    host: string,
    modelName: string,
    freshModel: ModelInfo,
  ): void {
    const persisted = this._persistedMetrics.get(host)?.get(modelName)
    if (!persisted) return
    if (freshModel.recentLatency === 0 && persisted.recentLatency > 0)
      freshModel.recentLatency = persisted.recentLatency
    if (freshModel.recentTps === 0 && persisted.recentTps > 0)
      freshModel.recentTps = persisted.recentTps
    if (freshModel.failures === 0 && persisted.failures > 0)
      freshModel.failures = persisted.failures
    if (freshModel.totalRequests === 0 && persisted.totalRequests > 0)
      freshModel.totalRequests = persisted.totalRequests
  }

  stopPeriodicProbe(): void {
    if (this.periodicProbeHandle) {
      clearInterval(this.periodicProbeHandle)
      this.periodicProbeHandle = null
    }
    if (this.networkScanHandle) {
      clearInterval(this.networkScanHandle)
      this.networkScanHandle = null
    }
    if (this.metricsFlushHandle) {
      clearInterval(this.metricsFlushHandle)
      this.metricsFlushHandle = null
    }
    if (this.metricsFile && this.inventory.size > 0) {
      try {
        saveMetrics(this.metricsFile, this.inventory)
      } catch (err) {
        logger.warn({ err }, 'Failed to flush metrics on shutdown')
      }
    }
  }

  getNodes(): Map<string, NodeInfo> {
    return this.inventory
  }

  markNodeUnreachable(nodeHost: string): void {
    const node = this.inventory.get(nodeHost)
    if (!node || !node.reachable) return
    node.reachable = false
    node.failures = (node.failures || 0) + 1
    node.lastFailure = Date.now()
    logger.warn({ nodeHost }, 'Node marked unreachable due to connection failure')
    this.notifyInventoryUpdated()
  }

  getReachableNodeCount(): number {
    let count = 0
    for (const node of this.inventory.values()) {
      if (node.reachable) count++
    }
    return count
  }

  updateModelMetrics(
    nodeHost: string,
    modelName: string,
    latency: number,
    tokensGenerated = 0,
    endpoint: string | null = null,
  ): void {
    const node = this.inventory.get(nodeHost)
    if (!node) return
    const modelInfo = node.models.get(modelName)
    if (!modelInfo) return
    const tps = latency > 0 ? tokensGenerated / (latency / 1000) : 0
    modelInfo.recentLatency =
      modelInfo.recentLatency === 0
        ? latency
        : 0.9 * modelInfo.recentLatency + 0.1 * latency
    modelInfo.recentTps =
      modelInfo.recentTps === 0
        ? tps
        : 0.9 * modelInfo.recentTps + 0.1 * tps
    modelInfo.totalRequests = (modelInfo.totalRequests || 0) + 1
    modelInfo.lastSeen = Date.now()
    modelInfo.lastRoutedAt = Date.now()
    if (endpoint !== null) modelInfo.lastRoutingEndpoint = endpoint
  }

  recordModelFailure(
    nodeHost: string,
    modelName: string,
    err: NodeJS.ErrnoException | null,
  ): void {
    const node = this.inventory.get(nodeHost)
    if (!node) return
    const modelInfo = node.models.get(modelName)
    if (modelInfo) modelInfo.failures = (modelInfo.failures || 0) + 1
    const isConnectionFailure =
      err?.code === 'ECONNREFUSED' ||
      err?.code === 'ECONNRESET' ||
      err?.code === 'ETIMEDOUT' ||
      err?.code === 'EHOSTUNREACH'
    if (isConnectionFailure) {
      this.markNodeUnreachable(nodeHost)
    } else {
      logger.warn({ nodeHost, modelName, err: err?.message }, 'Model request failed')
    }
  }
}
