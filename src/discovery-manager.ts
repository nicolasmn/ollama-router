// discovery-manager.ts - Discovers, probes, and tracks Ollama nodes
import { NodeInfo, ModelInfo, ModelProfile } from './models.js'
import type { ModelProfileData } from './models.js'
import { createLogger } from './logger.js'
import { MetricsStore } from './metrics-store.js'
import type { PersistedModelMetrics } from './metrics-store.js'
import { NetworkScanner } from './network-scanner.js'
import { networkInterfaces } from 'node:os'

const logger = createLogger('discovery')

const EMA_ALPHA = 0.2

/** Collect all non-loopback IPv4/IPv6 addresses assigned to this machine. */
function getSelfAddresses(): Set<string> {
  const addrs = new Set<string>()
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (!iface.internal) addrs.add(iface.address)
    }
  }
  return addrs
}

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
  cloudUrl?: string
  cloudApiKey?: string
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
  private _pendingMetrics: Map<string, Map<string, PersistedModelMetrics>> | null
  private cloudUrl: string
  private cloudApiKey: string
  readonly cloudModels: string[]
  autoDiscover: boolean
  /** LAN/WLAN addresses of this machine, resolved once at startup. */
  private readonly selfAddresses: Set<string>

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
    this.metricsStore = config.metricsFile
      ? new MetricsStore(config.metricsFile, config.cloudUrl ?? '')
      : null
    this.scanner = new NetworkScanner()
    this._pendingMetrics = null
    this.cloudUrl = config.cloudUrl ?? ''
    this.cloudApiKey = config.cloudApiKey ?? ''
    this.cloudModels = []
    this.selfAddresses = getSelfAddresses()
    logger.debug({ selfAddresses: [...this.selfAddresses] }, 'Self-addresses resolved')

    for (const host of config.ollamaNodes ?? []) {
      const normalized = host.startsWith('http') ? host : `http://${host}`
      this.inventory.set(normalized, new NodeInfo(normalized))
    }
  }

  /**
   * Fetch a real ModelProfile from the cloud /api/show endpoint.
   * Falls back to an empty profile on any error so registration never blocks.
   */
  private async _fetchCloudProfile(modelName: string): Promise<ModelProfile> {
    try {
      const { request } = await import('undici')
      const resp = await request(`${this.cloudUrl}/api/show`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.cloudApiKey}`,
        },
        body: JSON.stringify({ name: modelName }),
        headersTimeout: 8000,
        bodyTimeout: 15000,
      })
      if (resp.statusCode !== 200) {
        await resp.body.dump()
        logger.warn({ modelName, status: resp.statusCode }, 'Cloud /api/show returned non-200, using empty profile')
        return new ModelProfile()
      }
      const data = await resp.body.json()
      return this.buildModelProfile(data)
    } catch (err) {
      logger.warn({ modelName, err: (err as Error).message }, 'Cloud /api/show fetch failed, using empty profile')
      return new ModelProfile()
    }
  }

  async registerCloudNode(): Promise<void> {
    if (!this.cloudUrl || !this.cloudApiKey) return

    const existing = this.inventory.get(this.cloudUrl)
    const node = existing ?? new NodeInfo(this.cloudUrl, true)

    node.cloud = true
    node.reachable = true
    node.lastSeen = Date.now()

    // Remove models no longer in the active list
    const seenNames = new Set(this.cloudModels)
    for (const name of node.models.keys()) {
      if (!seenNames.has(name)) node.models.delete(name)
    }

    // Add new models — fetch real profile from /api/show for each
    const newModels = this.cloudModels.filter((name) => !node.models.has(name))
    await Promise.allSettled(
      newModels.map(async (modelName) => {
        const profile = await this._fetchCloudProfile(modelName)
        const modelInfo = new ModelInfo(modelName, profile.architecture || '', 0, profile)
        modelInfo.lastSeen = Date.now()
        node.models.set(modelName, modelInfo)
        logger.debug({ modelName, supportsTools: profile.supportsTools, supportsThinking: profile.supportsThinking }, 'Cloud model profile fetched')
      }),
    )

    if (!existing) this.inventory.set(this.cloudUrl, node)
    logger.info({ cloudUrl: this.cloudUrl, models: this.cloudModels }, 'Cloud node registered')
  }

  addCloudModel(name: string): void {
    if (this.cloudModels.includes(name)) return
    ;(this.cloudModels as string[]).push(name)
    // Fire-and-forget — profile fetch is async; inventory updates when done
    this.registerCloudNode()
      .then(() => this.persistMetrics())
      .catch((err: Error) => logger.warn({ err: err.message }, 'addCloudModel registerCloudNode failed'))
  }

  removeCloudModel(name: string): boolean {
    const idx = this.cloudModels.indexOf(name)
    if (idx === -1) return false
    ;(this.cloudModels as string[]).splice(idx, 1)
    // Sync removal — no network call needed
    const node = this.inventory.get(this.cloudUrl)
    if (node) node.models.delete(name)
    this.persistMetrics()
    logger.info({ cloudUrl: this.cloudUrl, models: this.cloudModels }, 'Cloud node registered')
    return true
  }

  getCloudApiKey(nodeHost: string): string {
    return this.inventory.get(nodeHost)?.cloud ? this.cloudApiKey : ''
  }

  getCloudInfo(): { configured: boolean; cloudUrl: string; cloudApiKey: string; models: string[] } {
    return {
      configured: !!(this.cloudUrl && this.cloudApiKey),
      cloudUrl: this.cloudUrl,
      cloudApiKey: this.cloudApiKey,
      models: [...this.cloudModels],
    }
  }

  setInventoryUpdateHandler(handler: (inventory: Map<string, NodeInfo>) => void): void {
    this.inventoryUpdateHandler = handler
  }

  getNodes(): Map<string, NodeInfo> { return this.inventory }

  getReachableNodeCount(): number {
    let count = 0
    for (const node of this.inventory.values()) if (node.reachable) count++
    return count
  }

  isConnectedToNetworkNodes(): boolean {
    for (const host of this.inventory.keys()) if (!this._isLocalhost(host)) return true
    return false
  }

  /**
   * Returns true when `host` resolves to this machine.
   *
   * Covers:
   *   - Standard loopback aliases: localhost, 127.0.0.1, ::1
   *   - Any LAN/WLAN IP currently assigned to a local network interface
   *     (e.g. 192.168.178.23 when the router listens on port 11434)
   *
   * Note: URL.hostname returns '[fd00::1]' for IPv6 literals (RFC 3986
   * bracket notation). networkInterfaces() stores addresses without brackets.
   * We strip leading '[' and trailing ']' before the Set lookup.
   */
  _isLocalhost(host: string): boolean {
    if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?/.test(host)) return true
    try {
      const hostname = new URL(host).hostname.replace(/^\[|\]$/g, '')
      return this.selfAddresses.has(hostname)
    } catch {
      return false
    }
  }

  _determineNextScanInterval(): number {
    return this.isConnectedToNetworkNodes()
      ? this.networkScanIntervalActive
      : this.networkScanInterval
  }

  getScanStatus(): ScanStatus {
    const lastScanAgo = this._lastScanMs === 0 ? -1 : Date.now() - this._lastScanMs
    return { inProgress: this._scanInProgress, lastScanMs: this._lastScanMs, lastScanAgo, lastError: this._lastScanError }
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
      if (key.endsWith('.context_length') && typeof val === 'number') { contextLength = val; break }
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
      capabilities, parameters, contextLength, architecture, embeddingDim,
      supportsTools: capabilities.has('tools'),
      supportsVision: capabilities.has('vision'),
      supportsAudio: capabilities.has('audio'),
      supportsThinking: capabilities.has('thinking'),
      isEmbedding: capabilities.has('embedding'),
    })
  }

  markNodeUnreachable(nodeHost: string): void {
    const node = this.inventory.get(nodeHost)
    if (!node || !node.reachable || node.cloud) return
    node.reachable = false
    node.failures++
    node.lastFailure = Date.now()
    logger.warn({ nodeHost }, 'Node marked unreachable due to connection failure')
  }

  async initialize(): Promise<number> {
    logger.info('Initializing DiscoveryManager')

    if (this.metricsStore) {
      const { knownNodes, cloudModels, metrics } = this.metricsStore.load()
      for (const host of knownNodes) {
        if (!this.inventory.has(host)) {
          logger.info({ host }, 'Restoring known node from persistence')
          this.inventory.set(host, new NodeInfo(host))
        }
      }
      for (const name of cloudModels) {
        if (!this.cloudModels.includes(name)) {
          ;(this.cloudModels as string[]).push(name)
        }
      }
      if (cloudModels.length > 0) logger.info({ cloudModels }, 'Restored cloud models from persistence')
      this._pendingMetrics = metrics.size > 0 ? metrics : null
    }

    // Must run after metrics restore so model list is populated
    await this.registerCloudNode()

    // Probe known/configured nodes first so they become available quickly,
    // then run the slow network scan for new nodes in the background.
    await this.performProbe()
    if (this.autoDiscover) await this.discoverNetworkNodes()

    if (this._pendingMetrics) {
      this._applyLoadedMetrics(this._pendingMetrics)
      this._pendingMetrics = null
    }

    return this.getReachableNodeCount()
  }

  private _applyLoadedMetrics(metrics: Map<string, Map<string, PersistedModelMetrics>>): void {
    for (const [host, modelMetrics] of metrics) {
      const node = this.inventory.get(host)
      if (!node) continue
      for (const [name, m] of modelMetrics) {
        const model = node.models.get(name)
        if (!model) continue
        model.recentLatency = m.recentLatency
        model.recentTps = m.recentTps
        model.failures = m.failures
        model.totalRequests = m.totalRequests
        model.lastRoutedAt = m.lastRoutedAt
        model.lastRoutingEndpoint = m.lastRoutingEndpoint
      }
    }
  }

  persistMetrics(): void {
    this.metricsStore?.persist(this.inventory, this.cloudModels)
  }

  removeNode(host: string): boolean {
    if (!this.inventory.has(host)) return false
    this.inventory.delete(host)
    logger.info({ host }, 'Node manually removed from inventory')
    this.persistMetrics()
    return true
  }

  startPeriodicProbe(): void {
    if (this.probeTimer) return
    this.probeTimer = setInterval(
      () => this.performProbe().catch((err: Error) => logger.warn({ err: err.message }, 'Periodic probe failed')),
      this.discoveryInterval,
    )
    if (this.autoDiscover) {
      this.scanTimer = setInterval(
        () => this.discoverNetworkNodes().catch((err: Error) => logger.warn({ err: err.message }, 'Periodic scan failed')),
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
    const probes = Array.from(this.inventory.entries())
      .filter(([, node]) => !node.cloud)
      .map(([host]) =>
        this._probeNode(host).catch((err: Error) => logger.warn({ host, err: err.message }, 'Node probe failed')),
      )
    await Promise.allSettled(probes)
    this.inventoryUpdateHandler?.(this.inventory)
    this.persistMetrics()
  }

  private async _probeNode(host: string): Promise<void> {
    const node = this.inventory.get(host)
    if (!node) return
    try {
      const { request } = await import('undici')
      const tagsResp = await request(`${host}/api/tags`, { headersTimeout: 5000, bodyTimeout: 5000 })
      if (tagsResp.statusCode !== 200) { this.markNodeUnreachable(host); return }
      const tagsData = (await tagsResp.body.json()) as { models?: Array<Record<string, unknown>> }
      const apiModels = tagsData.models ?? []

      node.reachable = true
      node.lastSeen = Date.now()
      node.failures = 0

      const seenNames = new Set<string>()
      const newModelNames: string[] = []
      for (const raw of apiModels) {
        const name = raw.name as string
        seenNames.add(name)
        if (!node.models.has(name)) {
          const details = (raw.details ?? {}) as Record<string, unknown>
          node.models.set(name, new ModelInfo(
            name,
            (details.family as string) ?? '',
            (raw.size as number) ?? 0,
            new ModelProfile(),
          ))
          newModelNames.push(name)
        }
        node.models.get(name)!.lastSeen = Date.now()
      }
      if (newModelNames.length > 0) {
        await Promise.allSettled(newModelNames.map(async (name) => {
          try {
            const showResp = await request(`${host}/api/show`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name }),
              headersTimeout: 5000,
              bodyTimeout: 10000,
            })
            if (showResp.statusCode === 200) {
              const showData = await showResp.body.json()
              const profile = this.buildModelProfile(showData)
              const model = node.models.get(name)
              if (model) {
                model.profile = profile
                if (!model.family && profile.architecture) model.family = profile.architecture
              }
            } else {
              await showResp.body.dump()
            }
          } catch { /* keep default profile */ }
        }))
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
      if (!existing) { this.inventory.set(host, freshNode); continue }
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

  updateModelMetrics(nodeHost: string, modelName: string, latencyMs: number, tokens: number, endpoint?: string): void {
    const node = this.inventory.get(nodeHost)
    const model = node?.models.get(modelName)
    if (!model) return
    if (model.totalRequests === 0) {
      model.recentLatency = latencyMs
      model.recentTps = tokens > 0 ? (tokens / latencyMs) * 1000 : 0
    } else {
      model.recentLatency = EMA_ALPHA * latencyMs + (1 - EMA_ALPHA) * model.recentLatency
      if (tokens > 0) {
        model.recentTps = EMA_ALPHA * ((tokens / latencyMs) * 1000) + (1 - EMA_ALPHA) * model.recentTps
      }
    }
    model.totalRequests++
    model.lastRoutedAt = Date.now()
    if (endpoint) model.lastRoutingEndpoint = endpoint
  }

  recordModelFailure(nodeHost: string, modelName: string, err: NodeJS.ErrnoException): void {
    const node = this.inventory.get(nodeHost)
    const model = node?.models.get(modelName)
    if (model) model.failures++
    if (err?.code === 'ECONNREFUSED' || err?.code === 'ECONNRESET') this.markNodeUnreachable(nodeHost)
  }
}
