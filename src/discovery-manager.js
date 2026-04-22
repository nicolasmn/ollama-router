// discovery-manager.js - Manages discovery of Ollama nodes and their models
import { request } from 'undici'
import pino from 'pino'
import { NodeInfo, ModelInfo, ModelProfile } from './models.js'

const logger = pino()

export class DiscoveryManager {
  constructor(config = {}) {
    this.OLLAMA_NODES = config.ollamaNodes || []
    this.DISCOVERY_INTERVAL = config.discoveryInterval || 15000
    this.onInventoryUpdated = config.onInventoryUpdated || null
    this.inventory = new Map() // Maps nodeHost -> NodeInfo
    this.periodicProbeHandle = null
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

    if (showData?.model_info && typeof showData.model_info === 'object') {
      const info = showData.model_info

      // Extract total parameter count (in billions)
      const rawParams = info['general.parameter_count']
      if (typeof rawParams === 'number' && rawParams > 0) {
        parameters = rawParams / 1e9
      }

      // Find context length: different model families use different key names
      const contextKey = Object.keys(info).find((k) =>
        k.endsWith('.context_length'),
      )
      if (contextKey && typeof info[contextKey] === 'number') {
        contextLength = info[contextKey]
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
      isEmbedding: capabilities.has('embeddings'),
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
    logger.info(`Probing ${host}`)

    try {
      // Version check
      const versionResp = await request(`${base}/api/version`, {
        timeout: 5000,
      })
      if (versionResp.statusCode !== 200) {
        throw new Error(`Version ${versionResp.statusCode}`)
      }
      logger.info(`${host} version OK`)

      // Get model list
      const tagsResp = await request(`${base}/api/tags`, {
        timeout: 10000,
      })
      if (tagsResp.statusCode !== 200) {
        throw new Error(`Tags ${tagsResp.statusCode}`)
      }

      const tagsData = await tagsResp.body.json()
      logger.info(`${host} models:`, tagsData.models?.length || 0)

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
   * Initialize discovery by probing all configured nodes
   * @returns {Promise<number>} number of reachable nodes
   */
  async initialize() {
    logger.info('Initializing discovery with nodes:', this.OLLAMA_NODES)
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
   * Start periodic discovery probe
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

      if (!previousNode) {
        merged.set(host, freshNode)
        continue
      }

      // Keep node-level failure history when the node disappears and comes back.
      freshNode.failures = previousNode.failures || 0
      freshNode.lastFailure = previousNode.lastFailure || 0

      for (const [modelName, freshModel] of freshNode.models) {
        const previousModel = previousNode.models.get(modelName)
        if (!previousModel) continue

        // Keep runtime telemetry so routing scores remain stable across probes.
        freshModel.status = previousModel.status
        freshModel.activeRequests = previousModel.activeRequests
        freshModel.recentLatency = previousModel.recentLatency
        freshModel.recentTps = previousModel.recentTps
        freshModel.failures = previousModel.failures
        freshModel.lastRoutingEndpoint = previousModel.lastRoutingEndpoint
        freshModel.lastRoutedAt = previousModel.lastRoutedAt
      }

      merged.set(host, freshNode)
    }

    this.inventory = merged
  }

  /**
   * Stop periodic discovery probe
   */
  stopPeriodicProbe() {
    if (this.periodicProbeHandle) {
      clearInterval(this.periodicProbeHandle)
      this.periodicProbeHandle = null
      logger.info('Periodic probe stopped')
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
}
