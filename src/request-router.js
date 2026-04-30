// request-router.js - Selects optimal Ollama node/model for each request
import { RequestAnalyzer } from './request-analyzer.js'
import { createLogger } from './logger.js'

const logger = createLogger('router')

// Virtual model aliases exposed in the catalog
const VIRTUAL_MODELS = ['auto', 'auto-fast', 'auto-think']
const STALE_SCAN_THRESHOLD_MS = 5 * 60 * 1000 // 5 minutes

export class RequestRouter {
  constructor(discoveryManager, loadManager) {
    this.discovery = discoveryManager
    this.load = loadManager
    this.analyzer = new RequestAnalyzer()
  }

  /**
   * Analyze a request body without performing routing.
   * @param {Object} reqBody
   * @param {string} endpointType - 'chat'|'completions'|'embeddings'|'responses'
   * @returns {Object} analysis result
   */
  analyzeRequest(reqBody, endpointType) {
    return this.analyzer.analyze(reqBody, endpointType)
  }

  /**
   * Select candidates for a chat completion request.
   * @param {Object} reqBody
   * @returns {Promise<Array|Object|null>}
   */
  async selectForChat(reqBody) {
    await this._performOnRequestScan()
    const analysis = this.analyzer.analyze(reqBody, 'chat')
    const model = reqBody.model || 'auto'
    logger.debug({ model, ...analysis }, 'Chat routing analysis')
    return this._selectCandidates(model, analysis, reqBody)
  }

  /**
   * Select candidates for an embeddings request.
   * @param {Object} reqBody
   * @returns {Promise<Array|null>}
   */
  async selectForEmbeddings(reqBody) {
    await this._performOnRequestScan()
    const model = reqBody.model || 'auto'
    const analysis = { needsEmbedding: true }
    return this._selectCandidates(model, analysis, reqBody)
  }

  /**
   * Select candidates for a /v1/responses request.
   * @param {Object} reqBody
   * @returns {Promise<Array|Object|null>}
   */
  async selectForResponses(reqBody) {
    await this._performOnRequestScan()
    const analysis = this.analyzer.analyze(reqBody, 'responses')
    const model = reqBody.model || 'auto'
    logger.debug({ model, ...analysis }, 'Responses routing analysis')
    return this._selectCandidates(model, analysis, reqBody)
  }

  /**
   * Select candidates for a /v1/messages request.
   * @param {Object} reqBody
   * @returns {Promise<Array|Object|null>}
   */
  async selectForMessages(reqBody) {
    await this._performOnRequestScan()
    const analysis = this.analyzer.analyze(reqBody, 'messages')
    const model = reqBody.model || 'auto'
    logger.debug({ model, ...analysis }, 'Messages routing analysis')
    return this._selectCandidates(model, analysis, reqBody)
  }

  /**
   * Select candidates for an Ollama-native /api/generate or /api/chat request.
   * @param {Object} reqBody
   * @param {'generate'|'chat'} ollamaEndpoint
   * @returns {Promise<Array|Object|null>}
   */
  async selectForOllama(reqBody, ollamaEndpoint) {
    await this._performOnRequestScan()
    const analysis = this.analyzer.analyze(reqBody, 'chat')
    const model = reqBody.model || 'auto'
    logger.debug({ model, ollamaEndpoint, ...analysis }, 'Ollama routing analysis')
    return this._selectCandidates(model, analysis, reqBody)
  }

  /**
   * Build the public model catalog: one entry per unique model name + virtual aliases.
   * @returns {Array<{ id: string, object: string, owned_by: string }>}
   */
  getModelCatalog() {
    const seen = new Set()
    const models = []

    for (const node of this.discovery.getNodes().values()) {
      if (!node.reachable) continue
      for (const modelName of node.models.keys()) {
        if (!seen.has(modelName)) {
          seen.add(modelName)
          models.push({ id: modelName, object: 'model', owned_by: 'ollama' })
        }
      }
    }

    for (const alias of VIRTUAL_MODELS) {
      models.push({ id: alias, object: 'model', owned_by: 'ollama-router' })
    }

    return models
  }

  // ─── private ──────────────────────────────────────────────────────────────

  /**
   * Trigger an on-request network scan if inventory is stale and no scan is running.
   * Fire-and-forget — never blocks the routing path.
   * @private
   */
  async _performOnRequestScan() {
    if (!this.discovery.autoDiscover) return
    const { inProgress, lastScanMs } = this.discovery.getScanStatus()
    const stale = Date.now() - lastScanMs > STALE_SCAN_THRESHOLD_MS
    if (!inProgress && stale) {
      logger.debug('On-request network scan triggered (stale inventory)')
      this.discovery.discoverNetworkNodes().catch((err) => {
        logger.warn({ err: err.message }, 'On-request scan failed')
      })
    }
  }

  /**
   * Select one or more routing candidates.
   * @param {string} model - requested model name or virtual alias
   * @param {Object} analysis - from RequestAnalyzer
   * @param {Object} reqBody
   * @returns {Array|Object|null}
   * @private
   */
  _selectCandidates(model, analysis, reqBody) {
    const isVirtual = VIRTUAL_MODELS.includes(model)
    const isStreaming = Boolean(reqBody?.stream)

    if (isVirtual) {
      return this._selectVirtual(model, analysis, isStreaming)
    }
    return this._selectConcrete(model, isStreaming)
  }

  /**
   * Resolve a virtual alias ('auto', 'auto-fast', 'auto-think') to ranked candidates.
   * @private
   */
  _selectVirtual(alias, analysis, isStreaming) {
    const nodes = this.discovery.getNodes()
    const candidates = []

    for (const [nodeHost, node] of nodes) {
      if (!node.reachable) continue
      if (this.load.isAtCapacity(nodeHost)) continue

      for (const [modelName, modelInfo] of node.models) {
        const { profile } = modelInfo
        if (profile.isEmbedding) continue

        if (analysis.needsTools && !profile.supportsTools) continue
        if (analysis.needsVision && !profile.supportsVision) continue

        // For auto-think, only include thinking-capable models
        if (alias === 'auto-think' && !profile.supportsThinking) continue

        const score = this._scoreModel(modelInfo, analysis, alias)
        candidates.push({ nodeHost, modelName, modelInfo, score })
      }
    }

    if (candidates.length === 0) {
      if (analysis.needsTools || analysis.needsVision) return null
      return null
    }

    candidates.sort((a, b) => b.score - a.score)

    logger.debug(
      candidates.slice(0, 3).map((c) => ({
        model: c.modelName,
        node: c.nodeHost,
        score: Math.round(c.score * 10) / 10,
      })),
      'Top routing candidates',
    )

    return isStreaming ? candidates[0] : candidates
  }

  /**
   * Resolve a concrete model name to one or more candidates across nodes.
   * @private
   */
  _selectConcrete(model, isStreaming) {
    const nodes = this.discovery.getNodes()
    const candidates = []

    for (const [nodeHost, node] of nodes) {
      if (!node.reachable) continue
      if (this.load.isAtCapacity(nodeHost)) continue

      const modelInfo = node.models.get(model)
      if (!modelInfo) continue

      const loadPenalty = this.load.getCurrentLoad(nodeHost) * 2
      const latencyScore = modelInfo.recentLatency
        ? Math.max(0, 20 - modelInfo.recentLatency / 500)
        : 10
      const score = latencyScore - loadPenalty
      candidates.push({ nodeHost, modelName: model, modelInfo, score })
    }

    if (candidates.length === 0) {
      // Check if model simply doesn't exist anywhere
      let modelExists = false
      for (const node of nodes.values()) {
        if (node.models.has(model)) { modelExists = true; break }
      }
      if (!modelExists) {
        const err = new Error(`Model not found: ${model}`)
        err.statusCode = 404
        err.code = 'MODEL_NOT_FOUND'
        throw err
      }
      return null
    }

    candidates.sort((a, b) => b.score - a.score)
    return isStreaming ? candidates[0] : candidates
  }

  /**
   * Score a model candidate for virtual routing.
   * Higher is better.
   * @private
   */
  _scoreModel(modelInfo, requirements, alias) {
    const { profile } = modelInfo
    const params = profile.parameters || 0
    const contextLength = profile.contextLength || 4096
    const messageCount = requirements.messageCount || 0
    const estimatedTokens = requirements.estimatedTokens || 0

    // Base score from observed performance (prefer fast + low-latency)
    const latencyScore = modelInfo.recentLatency
      ? Math.max(0, 20 - modelInfo.recentLatency / 500)
      : 10
    const tpsScore = modelInfo.recentTps
      ? Math.min(10, modelInfo.recentTps / 5)
      : 5
    const baseScore = latencyScore + tpsScore

    // Context fit: penalise models with < 2× the estimated token budget
    const contextMargin =
      contextLength > estimatedTokens * 2
        ? 5
        : contextLength > estimatedTokens
          ? 2
          : 0

    // Load penalty
    const loadPenalty = this.load.getCurrentLoad(modelInfo.nodeHost || '') * 2

    // Size-fit heuristic driven by task requirements
    let sizeFit = 0
    if (alias === 'auto-fast' || requirements.preferFast) {
      if (params <= 4) sizeFit += 14
      else if (params <= 9) sizeFit += 8
      else sizeFit += 1
    } else if (requirements.preferReasoning) {
      if (params >= 20) sizeFit += 14
      else if (params >= 10) sizeFit += 6
      else sizeFit += 1
    } else if (requirements.hasCodeSignals || messageCount > 10) {
      if (params >= 20 && params <= 35) sizeFit += 14
      else if (params >= 10) sizeFit += 6
      else sizeFit += 1
    } else {
      // Default: small capable models for everyday use
      if (params > 0 && params <= 8) sizeFit += 10
      else if (params <= 15) sizeFit += 6
      else sizeFit += 2
    }

    // Thinking bonus: extra weight for models that support structured reasoning
    const thinkingBonus = profile.supportsThinking
      ? requirements.preferReasoning
        ? 8
        : requirements.preferFast
          ? 4
          : 0
      : 0

    const total = baseScore + contextMargin + sizeFit + thinkingBonus - loadPenalty
    return total
  }
}
