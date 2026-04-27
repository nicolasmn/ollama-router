// discovery-manager.js - Manages discovery of Ollama nodes and their models
import { request } from 'undici'
import pino from 'pino'
import { NodeInfo, ModelInfo, ModelProfile } from './models.js'
import { NetworkScanner } from './network-scanner.js'
import { loadMetrics, saveMetrics } from './metrics-store.js'

const logger = pino()

export class DiscoveryManager {
  constructor(config = {}) {
    this.OLLAMA_NODES = config.ollamaNodes || []
    this.DISCOVERY_INTERVAL = config.discoveryInterval || 15000
    this.autoDiscover = config.autoDiscover ?? false
    this.NETWORK_SCAN_INTERVAL = config.networkScanInterval || 60000
    this.onInventoryUpdated = config.onInventoryUpdated || null
    this.metricsFile = config.metricsFile || null
    this.inventory = new Map() // Maps nodeHost -> NodeInfo
    this.periodicProbeHandle = null
    this.networkScanHandle = null
    this.metricsFlushHandle = null
    this.networkScanner = new NetworkScanner()
    this._persistedMetrics = this.metricsFile
      ? loadMetrics(this.metricsFile)
      : new Map()
  }

  notifyInventoryUpdated() {
    if (typeof this.onInventoryUpdated === 'function') {
      this.onInventoryUpdated(this.inventory)
    }
  }

  setInventoryUpdateHandler(handler) {
    this.onInventoryUpdated = handler
  }

  normalizeBaseUrl(host) {
    if (host.startsWith('http')) return host
    return `http://${host}`
  }

  /**
   * Fetch detailed model information from /api/show
   * @param {string} base - normalized base URL
   * @param {string} modelName - model name
   * @returns {Promise<Object|null>} - model details or null if failed
   * @private
   */
  async getModelDetails(base, modelName) {
    try {
      const resp = await request(`${base}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelName }),
        timeout: 5000,
      })
      if (resp.statusCode !== 200) return null
      return await resp.body.json()
    } catch {
      logger.debug({ modelName }, 'Failed to fetch /api/show details')
      return null
    }
  }

  /**
   * Build a ModelProfile from /api/show response data.
   * Uses only what the API tells us — no heuristics.
   * @param {Object|null} showData - response from /api/show
   * @returns {ModelProfile}
   */
  buildModelProfile(showData) {
    const capabilities = new Set(
      (showData?.capabilities || []).map((c) => String(c).toLowerCase()),
    )

    let parameters = 0
    let contextLength = 4096
    let architecture = ''
    let embeddingDim = 0

    if (showData?.model_info && typeof showData.model_info === 'object') {
      const info = showData.model_info

      // Extract total parameter count (in billions)
      const rawParams = info['general.parameter_count']
      if (typeof rawParams === 'number' && rawParams > 0) {
        parameters = rawParams / 1e9
      }

      architecture =
        typeof info['general.architecture'] === 'string'
          ? info['general.architecture']
          : ''

      // Find context length: different model families use different key names
      const contextKey = Object.keys(info).find((k) =>
        k.endsWith('.context_length'),
      )
      if (contextKey && typeof info[contextKey] === 'number') {
        contextLength = info[contextKey]
      }

      if (architecture) {
        const dimVal = info[`${architecture}.embedding_length`]
        if (typeof dimVal === 'number' && dimVal > 0) {
          embeddingDim = dimVal
        }
      }
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
      isEmbedding:
        capabilities.has('embedding') || capabilities.has('embeddings'),
    })
  }

  /**
   * Populate node models by fetching /api/show for each model in parallel.
   * @param {string} base - normalized base URL
   * @param {Array} modelsData - from /api/tags
   * @returns {Promise<Map<string, ModelInfo>>}
   * @private
   */
  async populateNodeModelsEnriched(base, modelsData) {
    const models = new Map()

    const detailsPromises = modelsData.map((mdata) =>
      this.getModelDetails(base, mdata.name).then((showData) => ({
        mdata,
        showData,
      })),
    )

    const results = await Promise.allSettled(detailsPromises)

    for (const result of results) {
      if (result.status !== 'fulfilled') continue

      const { mdata, showData } = result.value
      const name = mdata.name
      const family = mdata.details?.family || showData?.details?.family || ''
      const size = mdata.size || 0

      const profile = this.buildModelProfile(showData)
      logger.debug({ name, profile: profile.toJSON() }, 'Model profile built')
      models.set(name, new ModelInfo(name, family, size, profile))
    }

    return models
  }

  /**
   * Probe a single node for availability and models
   * @param {string} host - hostname or IP (e.g., 'localhost:11434' or 'http://localhost:11434')
   * @returns {Promise<NodeInfo>}
   */
  async probeNode(host) {
    const base = this.normalizeBaseUrl(host)
    const node = new NodeInfo(base)
    logger.debug(`Probing ${host}`)

    try {
      // Version check
      const versionResp = await request(`${base}/api/version`, {
        timeout: 5000,
      })
      if (versionResp.statusCode !== 200) {
        throw new Error(`Version ${versionResp.statusCode}`)
      }
      logger.debug(`${host} version OK`)

      // Get model list
      const tagsResp = await request(`${base}/api/tags`, {
        timeout: 10000,
      })
      if (tagsResp.statusCode !== 200) {
        throw new Error(`Tags ${tagsResp.statusCode}`)
      }

      const tagsData = await tagsResp.body.json()
      logger.debug(
        { host, models: tagsData.models?.length || 0 },
        'Models fetched',
      )

      // Enrich models with /api/show details in parallel
      const enrichedModels = await this.populateNodeModelsEnriched(
        base,
        tagsData.models || [],
      )
      for (const [name, modelInfo] of enrichedModels) {
        node.models.set(name, modelInfo)
      }

      node.reachable = true
      node.lastSeen = Date.now()
    } catch (err) {
      logger.warn(`${host} failed:`, err.message)
      node.reachable = false
    }

    return node
  }

  /**
   * Merge auto-discovered node URLs into OLLAMA_NODES, skipping duplicates.
   * @param {string[]} discoveredUrls
   * @private
   */
  mergeDiscoveredNodes(discoveredUrls) {
    const existingNormalized = new Set(
      this.OLLAMA_NODES.map((n) => this.normalizeBaseUrl(n)),
    )
    for (const url of discoveredUrls) {
      const normalized = this.normalizeBaseUrl(url)
      if (!existingNormalized.has(normalized)) {
        this.OLLAMA_NODES.push(url)
        existingNormalized.add(normalized)
        logger.info({ url }, 'Auto-discovered Ollama node added')
      }
    }
  }

  /**
   * Run a network scan and merge any newly found nodes, then probe them.
   */
  async discoverNetworkNodes() {
    const discovered = await this.networkScanner.scanLocalNetwork()
    if (discovered.length > 0) {
      this.mergeDiscoveredNodes(discovered)
    }
  }

  /**
   * Initialize discovery by probing all configured nodes
   * @returns {Promise<number>} number of reachable nodes
   */
  async initialize() {
    if (this.autoDiscover) {
      await this.discoverNetworkNodes()
    }

    logger.debug('Initializing discovery with nodes:', this.OLLAMA_NODES)
    const initialTasks = this.OLLAMA_NODES.map((host) => this.probeNode(host))
    const initialResults = await Promise.allSettled(initialTasks)

    let reachableCount = 0
    for (const res of initialResults) {
      if (res.status === 'fulfilled') {
        this.inventory.set(res.value.host, res.value)
        if (res.value.reachable) {
          reachableCount++
        }
      }
    }

    logger.info(
      `Discovery initialized: ${reachableCount}/${this.inventory.size} nodes reachable`,
    )
    this.notifyInventoryUpdated()
    return reachableCount
  }

  /**
   * Start periodic discovery probe and optional network scan
   */
  startPeriodicProbe() {
    if (this.periodicProbeHandle) {
      logger.warn('Periodic probe already running')
      return
    }

    logger.info(`Starting periodic probe every ${this.DISCOVERY_INTERVAL}ms`)

    this.periodicProbeHandle = setInterval(async () => {
      await this.performProbe()
    }, this.DISCOVERY_INTERVAL)

    if (this.metricsFile) {
      this.metricsFlushHandle = setInterval(() => {
        saveMetrics(this.metricsFile, this.inventory)
      }, 60_000)
      this.metricsFlushHandle.unref()
    }

    if (this.autoDiscover) {
      logger.info(
        `Starting periodic network scan every ${this.NETWORK_SCAN_INTERVAL}ms`,
      )
      this.networkScanHandle = setInterval(async () => {
        await this.discoverNetworkNodes()
      }, this.NETWORK_SCAN_INTERVAL)
    }
  }

  /**
   * Perform a single discovery probe cycle
   * @private
   */
  async performProbe() {
    const tasks = this.OLLAMA_NODES.map((host) => this.probeNode(host))
    const results = await Promise.allSettled(tasks)

    const newInventory = new Map()
    for (const res of results) {
      if (res.status === 'fulfilled') {
        newInventory.set(res.value.host, res.value)
      }
    }

    this.mergeInventory(newInventory)

    this.notifyInventoryUpdated()

    logger.debug(`Probe cycle complete: ${newInventory.size} nodes`)
  }

  /**
   * Merge fresh probe data while preserving runtime routing telemetry.
   * @param {Map<string, NodeInfo>} newInventory
   * @private
   */
  mergeInventory(newInventory) {
    const merged = new Map()

    for (const [host, freshNode] of newInventory) {
      const previousNode = this.inventory.get(host)

      if (previousNode && freshNode.reachable) {
        // Node is reachable — reset failure counters and carry over runtime
        // telemetry so routing scores remain stable across probe cycles.
        freshNode.failures = 0
        freshNode.lastFailure = previousNode.lastFailure ?? 0

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
        // Newly discovered node — seed from persisted metrics
        for (const [modelName, freshModel] of freshNode.models) {
          this._applyPersistedMetrics(host, modelName, freshModel)
        }
      } else if (previousNode) {
        // Node is unreachable — update failure tracking and preserve the last
        // known model list so telemetry survives the outage and is available
        // once the node recovers.
        freshNode.failures = (previousNode.failures ?? 0) + 1
        freshNode.lastFailure = Date.now()
        freshNode.lastSeen = previousNode.lastSeen
        freshNode.models = previousNode.models
      }

      merged.set(host, freshNode)
    }

    this.inventory = merged
  }

  /**
   * Seed a fresh ModelInfo with persisted metrics if it has none yet.
   * @private
   */
  _applyPersistedMetrics(host, modelName, freshModel) {
    const persisted = this._persistedMetrics.get(host)?.get(modelName)
    if (!persisted) return
    if (freshModel.recentLatency === 0 && persisted.recentLatency > 0) {
      freshModel.recentLatency = persisted.recentLatency
    }
    if (freshModel.recentTps === 0 && persisted.recentTps > 0) {
      freshModel.recentTps = persisted.recentTps
    }
    if (freshModel.failures === 0 && persisted.failures > 0) {
      freshModel.failures = persisted.failures
    }
    if (freshModel.totalRequests === 0 && persisted.totalRequests > 0) {
      freshModel.totalRequests = persisted.totalRequests
    }
  }

  /**
   * Stop periodic discovery probe and network scan
   */
  stopPeriodicProbe() {
    if (this.periodicProbeHandle) {
      clearInterval(this.periodicProbeHandle)
      this.periodicProbeHandle = null
      logger.info('Periodic probe stopped')
    }
    if (this.networkScanHandle) {
      clearInterval(this.networkScanHandle)
      this.networkScanHandle = null
      logger.info('Periodic network scan stopped')
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

  /**
   * Get all discovered nodes
   * @returns {Map<string, NodeInfo>}
   */
  getNodes() {
    return this.inventory
  }

  /**
   * Immediately mark a node as unreachable without waiting for the next probe cycle.
   * The next successful probe will restore reachable=true.
   * @param {string} nodeHost - normalized host URL
   */
  markNodeUnreachable(nodeHost) {
    const node = this.inventory.get(nodeHost)
    if (!node || !node.reachable) return

    node.reachable = false
    node.failures = (node.failures || 0) + 1
    node.lastFailure = Date.now()
    logger.warn(
      { nodeHost },
      'Node marked unreachable due to connection failure',
    )
    this.notifyInventoryUpdated()
  }

  /**
   * Get count of reachable nodes
   * @returns {number}
   */
  getReachableNodeCount() {
    let count = 0
    for (const node of this.inventory.values()) {
      if (node.reachable) {
        count++
      }
    }
    return count
  }

  /**
   * Update model performance metrics after a successful request.
   * Uses exponential moving average to smooth latency and throughput.
   * @param {string} nodeHost
   * @param {string} modelName
   * @param {number} latency - milliseconds
   * @param {number} tokensGenerated
   */
  updateModelMetrics(nodeHost, modelName, latency, tokensGenerated = 0) {
    const node = this.inventory.get(nodeHost)
    if (!node) return
    const modelInfo = node.models.get(modelName)
    if (!modelInfo) return

    modelInfo.recentLatency = 0.9 * modelInfo.recentLatency + 0.1 * latency
    const tps = latency > 0 ? tokensGenerated / (latency / 1000) : 0
    modelInfo.recentTps = 0.9 * modelInfo.recentTps + 0.1 * tps
    modelInfo.totalRequests = (modelInfo.totalRequests || 0) + 1
    modelInfo.lastSeen = Date.now()
  }

  /**
   * Record a request failure for a model.
   * If the error is a connection-level failure, the node is immediately marked
   * unreachable without waiting for the next probe cycle.
   * @param {string} nodeHost
   * @param {string} modelName
   * @param {Error} [err]
   */
  recordModelFailure(nodeHost, modelName, err) {
    const node = this.inventory.get(nodeHost)
    if (!node) return
    const modelInfo = node.models.get(modelName)
    if (!modelInfo) return

    modelInfo.failures = (modelInfo.failures || 0) + 1

    if (err && this._isConnectionFailure(err)) {
      this.markNodeUnreachable(nodeHost)
    }
  }

  /**
   * Returns true when the error indicates the node itself is unreachable
   * (connection refused, reset, DNS failure, timeout).
   * @param {Error} err
   * @returns {boolean}
   */
  _isConnectionFailure(err) {
    const connectionCodes = new Set([
      'ECONNREFUSED',
      'ECONNRESET',
      'ETIMEDOUT',
      'ENOTFOUND',
      'ENETUNREACH',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_SOCKET',
      'UND_ERR_BODY_TIMEOUT',
    ])
    return connectionCodes.has(err?.code)
  }
}
