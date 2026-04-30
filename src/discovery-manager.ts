// discovery-manager.ts - Discovers, probes, and tracks Ollama nodes
import { NodeInfo, ModelInfo, ModelProfile } from './models.js'
import { createLogger } from './logger.js'
import { MetricsStore } from './metrics-store.js'
import { NetworkScanner } from './network-scanner.js'

const logger = createLogger('discovery')

export interface ScanStatus {
  inProgress: boolean
  lastScanMs: number
  lastError: string | null
}

export interface DiscoveryConfig {
  ollamaNodes?: string[]
  discoveryInterval?: number
  autoDiscover?: boolean
  networkScanInterval?: number
  metricsFile?: string | null
}

const DEFAULT_PROBE_INTERVAL = 30_000
const DEFAULT_SCAN_INTERVAL = 5 * 60_000

export class DiscoveryManager {
  private inventory: Map<string, NodeInfo>
  private probeTimer: NodeJS.Timeout | null
  private scanTimer: NodeJS.Timeout | null
  private scanStatus: ScanStatus
  private metricsStore: MetricsStore | null
  private scanner: NetworkScanner
  private discoveryInterval: number
  private networkScanInterval: number
  private inventoryUpdateHandler:
    | ((inventory: Map<string, NodeInfo>) => void)
    | null

  autoDiscover: boolean

  constructor(config: DiscoveryConfig = {}) {
    this.inventory = new Map()
    this.probeTimer = null
    this.scanTimer = null
    this.scanStatus = { inProgress: false, lastScanMs: 0, lastError: null }
    this.discoveryInterval = config.discoveryInterval ?? DEFAULT_PROBE_INTERVAL
    this.networkScanInterval =
      config.networkScanInterval ?? DEFAULT_SCAN_INTERVAL
    this.autoDiscover = config.autoDiscover ?? false
    this.inventoryUpdateHandler = null
    this.metricsStore = config.metricsFile
      ? new MetricsStore(config.metricsFile)
      : null
    this.scanner = new NetworkScanner()

    const seeds = config.ollamaNodes ?? []
    for (const host of seeds) {
      this.inventory.set(host, new NodeInfo(host))
    }
  }

  setInventoryUpdateHandler(
    handler: (inventory: Map<string, NodeInfo>) => void,
  ): void {
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

  isConnectedToNetworkNodes(): boolean {
    return this.getReachableNodeCount() > 0
  }

  getScanStatus(): ScanStatus {
    return { ...this.scanStatus }
  }

  async initialize(): Promise<number> {
    logger.info('Initializing DiscoveryManager')
    if (this.autoDiscover) {
      await this.discoverNetworkNodes()
    }
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
        this.networkScanInterval,
      )
    }
  }

  stopPeriodicProbe(): void {
    if (this.probeTimer) {
      clearInterval(this.probeTimer)
      this.probeTimer = null
    }
    if (this.scanTimer) {
      clearInterval(this.scanTimer)
      this.scanTimer = null
    }
  }

  async discoverNetworkNodes(): Promise<void> {
    if (this.scanStatus.inProgress) return
    this.scanStatus.inProgress = true
    this.scanStatus.lastError = null
    logger.info('Starting network scan')
    try {
      const found = await this.scanner.scan()
      this._mergeDiscoveredNodes(found)
      this.scanStatus.lastScanMs = Date.now()
      logger.info({ found: found.length }, 'Network scan complete')
    } catch (err) {
      const msg = (err as Error).message
      this.scanStatus.lastError = msg
      logger.error({ err: msg }, 'Network scan failed')
    } finally {
      this.scanStatus.inProgress = false
    }
  }

  private _mergeDiscoveredNodes(hosts: string[]): void {
    for (const host of hosts) {
      if (!this.inventory.has(host)) {
        logger.info({ host }, 'Discovered new node')
        this.inventory.set(host, new NodeInfo(host))
      }
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
      const resp = await request(`${host}/api/tags`, {
        headersTimeout: 5000,
        bodyTimeout: 5000,
      })
      if (resp.statusCode !== 200) {
        node.reachable = false
        node.failures++
        node.lastFailure = Date.now()
        return
      }
      const data = (await resp.body.json()) as { models?: Array<Record<string, unknown>> }
      node.reachable = true
      node.lastSeen = Date.now()
      node.failures = 0
      this._updateNodeModels(node, data.models ?? [])
    } catch {
      node.reachable = false
      node.failures++
      node.lastFailure = Date.now()
    }
  }

  private _updateNodeModels(
    node: NodeInfo,
    apiModels: Array<Record<string, unknown>>,
  ): void {
    const seenNames = new Set<string>()
    for (const raw of apiModels) {
      const name = raw.name as string
      seenNames.add(name)
      if (!node.models.has(name)) {
        const details = (raw.details ?? {}) as Record<string, unknown>
        const profile = new ModelProfile({
          capabilities: new Set(
            Array.isArray(raw.capabilities) ? (raw.capabilities as string[]) : [],
          ),
        })
        const info = new ModelInfo(
          name,
          (details.family as string) ?? '',
          (raw.size as number) ?? 0,
          profile,
        )
        node.models.set(name, info)
      }
      const info = node.models.get(name)!
      info.lastSeen = Date.now()
    }
    for (const name of node.models.keys()) {
      if (!seenNames.has(name)) node.models.delete(name)
    }
  }

  updateModelMetrics(
    nodeHost: string,
    modelName: string,
    latencyMs: number,
    tokens: number,
    _endpoint: string,
  ): void {
    const node = this.inventory.get(nodeHost)
    const model = node?.models.get(modelName)
    if (!model) return
    model.recentLatency = latencyMs
    if (tokens > 0 && latencyMs > 0) {
      model.recentTps = (tokens / latencyMs) * 1000
    }
    model.totalRequests++
    model.lastRoutedAt = Date.now()
  }

  recordModelFailure(
    nodeHost: string,
    modelName: string,
    _err: NodeJS.ErrnoException,
  ): void {
    const node = this.inventory.get(nodeHost)
    const model = node?.models.get(modelName)
    if (model) model.failures++
  }
}
