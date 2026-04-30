// discovery-manager.ts - Discovers, probes, and tracks Ollama nodes
import { NodeInfo, ModelInfo, ModelProfile } from './models.js'
import type { ModelProfileData } from './models.js'
import { createLogger } from './logger.js'
import { MetricsStore } from './metrics-store.js'
import { NetworkScanner } from './network-scanner.js'

const logger = createLogger('discovery')

const EMA_ALPHA = 0.2

export interface ScanStatus {
  inProgress: boolean
  lastScanMs: number
  lastScanAgo: number
  lastError: string | null
}

export interface DiscoveryConfig {
  ollamaNodes?: string[]
  discoveryInterval?: number
  autoDiscover?: boolean
  networkScanInterval?: number
  networkScanIntervalActive?: number
  metricsFile?: string | null
}

const DEFAULT_PROBE_INTERVAL = 30_000
const DEFAULT_SCAN_INTERVAL = 60_000
const DEFAULT_SCAN_INTERVAL_ACTIVE = 30 * 60_000

export class DiscoveryManager {
  inventory: Map<string, NodeInfo>
  _scanInProgress: boolean
  _lastScanMs: number
  private _lastScanError: string | null
  private probeTimer: NodeJS.Timeout | null
  private scanTimer: NodeJS.Timeout | null
  private metricsStore: MetricsStore | null
  private scanner: NetworkScanner
  private discoveryInterval: number
  networkScanInterval: number
  networkScanIntervalActive: number
  private inventoryUpdateHandler: ((inventory: Map<string, NodeInfo>) => void) | null

  autoDiscover: boolean

  constructor(config: DiscoveryConfig = {}) {
    this.inventory = new Map()
    this._scanInProgress = false
    this._lastScanMs = 0
    this._lastScanError = null
    this.probeTimer = null
    this.scanTimer = null
    this.discoveryInterval = config.discoveryInterval ?? DEFAULT_PROBE_INTERVAL
    this.networkScanInterval = config.networkScanInterval ?? DEFAULT_SCAN_INTERVAL
    this.networkScanIntervalActive = config.networkScanIntervalActive ?? DEFAULT_SCAN_INTERVAL_ACTIVE
    this.autoDiscover = config.autoDiscover ?? false
    this.inventoryUpdateHandler = null
    this.metricsStore = config.metricsFile ? new MetricsStore(config.metricsFile) : null
    this.scanner = new NetworkScanner()

    const seeds = config.ollamaNodes ?? []
    for (const host of seeds) {
      const normalized = host.startsWith('http') ? host : `http://${host}`
      this.inventory.set(normalized, new NodeInfo(normalized))
    }
  }

  setInventoryUpdateHandler(handler: (inventory: Map<string, NodeInfo>) => void): void {
    this.inventoryUpdateHandler = handler
  }

  getNodes(): Map<string, NodeInfo> {
    return this.inventory
  }

  getReachableNodeCount(): number {
    let count = 0
    for (const node of this.inventory.values()) {
      if (node.reachable) count++
    }
    return count
  }

  /** True if any non-localhost node is in inventory (regardless of reachability). */
  isConnectedToNetworkNodes(): boolean {
    for (const host of this.inventory.keys()) {
      if (!this._isLocalhost(host)) return true
    }
    return false
  }

  _isLocalhost(host: string): boolean {
    return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?/.test(host)
  }

  _determineNextScanInterval(): number {
    return this.isConnectedToNetworkNodes()
      ? this.networkScanIntervalActive
      : this.networkScanInterval
  }

  getScanStatus(): ScanStatus {
    const lastScanAgo = this._lastScanMs === 0 ? -1 : Date.now() - this._lastScanMs
    return {
      inProgress: this._scanInProgress,
      lastScanMs: this._lastScanMs,
      lastScanAgo,
      lastError: this._lastScanError,
    }
  }

  buildModelProfile(data: unknown): ModelProfile {
    if (!data || typeof data !== 'object') return new ModelProfile()
    const d = data as Record<string, unknown>
    const capabilities = Array.isArray(d.capabilities)
      ? new Set<string>(d.capabilities as string[])
      : new Set<string>()
    const modelInfo = (d.model_info ?? {}) as Record<string, unknown>

    const paramCount = modelInfo['general.parameter_count'] as number | undefined
    const parameters = paramCount ? paramCount / 1e9 : 0

    let contextLength = 4096
    for (const [key, val] of Object.entries(modelInfo)) {
      if (key.endsWith('.context_length') && typeof val === 'number') {
        contextLength = val
        break
      }
    }

    let architecture = ''
    let embeddingDim = 0
    const archVal = modelInfo['general.architecture']
    if (typeof archVal === 'string') {
      architecture = archVal
      const dimKey = `${architecture}.embedding_length`
      if (typeof modelInfo[dimKey] === 'number') embeddingDim = modelInfo[dimKey] as number
    }

    return new ModelProfile({
      capabilities,
      parameters,
      contextLength,
      architecture,
      embeddingDim,
      supportsTools: capabilities.has('tools'),
      supportsVision: capabilities.has('vision'),
      supportsAudio: capabilities.has('audio'),
      supportsThinking: capabilities.has('thinking'),
      isEmbedding: capabilities.has('embedding'),
    })
  }

  markNodeUnreachable(nodeHost: string): void {
    const node = this.inventory.get(nodeHost)
    if (!node) return
    if (!node.reachable) return // single-fire design
    node.reachable = false
    node.failures++
    node.lastFailure = Date.now()
    logger.warn({ nodeHost }, 'Node marked unreachable due to connection failure')
  }

  async initialize(): Promise<number> {
    logger.info('Initializing DiscoveryManager')
    if (this.autoDiscover) await this.discoverNetworkNodes()
    await this.performProbe()
    return this.getReachableNodeCount()
  }

  startPeriodicProbe(): void {
    if (this.probeTimer) return
    this.probeTimer = setInterval(
      () => this.performProbe().catch((err: Error) => {
        logger.warn({ err: err.message }, 'Periodic probe failed')
      }),
      this.discoveryInterval,
    )
    if (this.autoDiscover) {
      this.scanTimer = setInterval(
        () => this.discoverNetworkNodes().catch((err: Error) => {
          logger.warn({ err: err.message }, 'Periodic scan failed')
        }),
        this._determineNextScanInterval(),
      )
    }
  }

  stopPeriodicProbe(): void {
    if (this.probeTimer) { clearInterval(this.probeTimer); this.probeTimer = null }
    if (this.scanTimer) { clearInterval(this.scanTimer); this.scanTimer = null }
  }

  async discoverNetworkNodes(): Promise<void> {
    if (this._scanInProgress) return
    this._scanInProgress = true
    this._lastScanError = null
    logger.info('Starting network scan')
    try {
      const found = await this.scanner.scanLocalNetwork()
      for (const host of found) {
        if (!this.inventory.has(host)) {
          logger.info({ host }, 'Discovered new node')
          this.inventory.set(host, new NodeInfo(host))
        }
      }
      this._lastScanMs = Date.now()
      logger.info({ found: found.length }, 'Network scan complete')
    } catch (err) {
      const msg = (err as Error).message
      this._lastScanError = msg
      logger.error({ err: msg }, 'Network scan failed')
    } finally {
      this._scanInProgress = false
    }
  }

  async performProbe(): Promise<void> {
    const probes = Array.from(this.inventory.keys()).map((host) =>
      this._probeNode(host).catch((err: Error) => {
        logger.warn({ host, err: err.message }, 'Node probe failed')
      }),
    )
    await Promise.allSettled(probes)
    this.inventoryUpdateHandler?.(this.inventory)
    await this.metricsStore?.persist(this.inventory)
  }

  private async _probeNode(host: string): Promise<void> {
    const node = this.inventory.get(host)
    if (!node) return
    try {
      const { request } = await import('undici')
      const tagsResp = await request(`${host}/api/tags`, { headersTimeout: 5000, bodyTimeout: 5000 })
      if (tagsResp.statusCode !== 200) {
        this.markNodeUnreachable(host)
        return
      }
      const tagsData = (await tagsResp.body.json()) as { models?: Array<Record<string, unknown>> }
      const apiModels = tagsData.models ?? []

      node.reachable = true
      node.lastSeen = Date.now()
      node.failures = 0

      const seenNames = new Set<string>()
      for (const raw of apiModels) {
        const name = raw.name as string
        seenNames.add(name)

        if (!node.models.has(name)) {
          let profile = new ModelProfile()
          try {
            const showResp = await request(`${host}/api/show`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name }),
              headersTimeout: 5000,
              bodyTimeout: 5000,
            })
            if (showResp.statusCode === 200) {
              const showData = await showResp.body.json()
              profile = this.buildModelProfile(showData)
            }
          } catch { /* use default profile */ }
          const details = (raw.details ?? {}) as Record<string, unknown>
          const info = new ModelInfo(
            name,
            (details.family as string) ?? profile.architecture ?? '',
            (raw.size as number) ?? 0,
            profile,
          )
          node.models.set(name, info)
        }
        node.models.get(name)!.lastSeen = Date.now()
      }
      for (const name of node.models.keys()) {
        if (!seenNames.has(name)) node.models.delete(name)
      }
    } catch {
      this.markNodeUnreachable(host)
    }
  }

  mergeInventory(freshNodes: Map<string, NodeInfo>): void {
    for (const host of this.inventory.keys()) {
      if (!freshNodes.has(host)) this.inventory.delete(host)
    }
    for (const [host, freshNode] of freshNodes) {
      const existing = this.inventory.get(host)
      if (!existing) {
        this.inventory.set(host, freshNode)
        continue
      }
      freshNode.activeRequests = existing.activeRequests
      for (const [name, freshModel] of freshNode.models) {
        const existingModel = existing.models.get(name)
        if (existingModel) {
          freshModel.recentLatency = existingModel.recentLatency
          freshModel.recentTps = existingModel.recentTps
          freshModel.failures = existingModel.failures
          freshModel.totalRequests = existingModel.totalRequests
          freshModel.lastRoutedAt = existingModel.lastRoutedAt
          freshModel.lastRoutingEndpoint = existingModel.lastRoutingEndpoint
        }
      }
      this.inventory.set(host, freshNode)
    }
  }

  updateModelMetrics(
    nodeHost: string,
    modelName: string,
    latencyMs: number,
    tokens: number,
    endpoint?: string,
  ): void {
    const node = this.inventory.get(nodeHost)
    const model = node?.models.get(modelName)
    if (!model) return

    if (model.totalRequests === 0) {
      model.recentLatency = latencyMs
      model.recentTps = tokens > 0 ? (tokens / latencyMs) * 1000 : 0
    } else {
      model.recentLatency = EMA_ALPHA * latencyMs + (1 - EMA_ALPHA) * model.recentLatency
      if (tokens > 0) {
        const newTps = (tokens / latencyMs) * 1000
        model.recentTps = EMA_ALPHA * newTps + (1 - EMA_ALPHA) * model.recentTps
      }
    }
    model.totalRequests++
    model.lastRoutedAt = Date.now()
    if (endpoint) model.lastRoutingEndpoint = endpoint
  }

  recordModelFailure(
    nodeHost: string,
    modelName: string,
    err: NodeJS.ErrnoException,
  ): void {
    const node = this.inventory.get(nodeHost)
    const model = node?.models.get(modelName)
    if (model) model.failures++
    const isNetworkError = err?.code === 'ECONNREFUSED' || err?.code === 'ECONNRESET'
    if (isNetworkError) this.markNodeUnreachable(nodeHost)
  }
}
