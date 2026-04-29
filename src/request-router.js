// request-router.js - Selects the best Ollama node/model for each request
import { RequestAnalyzer } from './request-analyzer.js'

const AUTO_MODEL = 'auto'
const AUTO_FAST_MODEL = 'auto-fast'
const AUTO_THINK_MODEL = 'auto-think'
export const VIRTUAL_MODELS = new Set([AUTO_MODEL, AUTO_FAST_MODEL, AUTO_THINK_MODEL])

export class RequestRouter {
  constructor(discoveryManager, loadManager) {
    this.discovery = discoveryManager
    this.loadManager = loadManager
    this.requestAnalyzer = new RequestAnalyzer()
  }

  /**
   * Select the best model(s) for a request.
   * For streaming: returns single best candidate.
   * For non-streaming: returns ordered list of top 3 candidates for retry logic.
   *
   * @param {Object} requirements - from RequestAnalyzer.analyze()
   * @param {Object} options
   * @param {(candidate: Object) => boolean} [options.candidateFilter]
   * @returns {Object|Array|null}
   */
  selectModel(requirements, options = {}) {
    const candidates = this._collectCandidates(requirements, options)

    if (candidates.length === 0) {
      return null
    }

    candidates.sort((a, b) => b.score - a.score)

    if (requirements.isStreaming) {
      return candidates[0]
    } else {
      return candidates.slice(0, 3)
    }
  }

  _collectCandidates(requirements, options = {}) {
    const candidates = []
    const candidateFilter =
      typeof options.candidateFilter === 'function'
        ? options.candidateFilter
        : () => true

    for (const [nodeHost, node] of this.discovery.getNodes()) {
      const nodeCandidates = this._collectNodeCandidates(
        nodeHost,
        node,
        requirements,
        candidateFilter,
      )
      if (nodeCandidates.length === 0) continue
      candidates.push(...nodeCandidates)
    }

    return candidates
  }

  _collectNodeCandidates(nodeHost, node, requirements, candidateFilter) {
    if (!this._isNodeEligible(node)) return []

    const nodeCandidates = []
    for (const [modelName, modelInfo] of node.models) {
      const candidate = this._buildCandidate(
        nodeHost,
        modelName,
        modelInfo,
        requirements,
      )
      if (!candidate) continue
      if (!candidateFilter(candidate)) continue

      nodeCandidates.push(candidate)
    }

    return nodeCandidates
  }

  _buildCandidate(nodeHost, modelName, modelInfo, requirements) {
    if (!this._meetsRequirements(modelInfo, requirements)) return null
    if (this.loadManager.isAtCapacity(nodeHost)) return null

    const score = this._scoreModel(nodeHost, modelInfo, requirements)
    return { nodeHost, modelName, score, modelInfo }
  }

  _isNodeEligible(node) {
    return node.reachable && node.models.size > 0
  }

  /**
   * Check if a model satisfies the hard capability requirements of a request.
   * @param {ModelInfo} modelInfo
   * @param {RequestRequirements} requirements
   * @returns {boolean}
   */
  _meetsRequirements(modelInfo, requirements) {
    const { profile } = modelInfo

    if (requirements.needsVision && !profile.supportsVision) return false
    if (requirements.needsAudio && !profile.supportsAudio) return false
    if (requirements.needsTools && !profile.supportsTools) return false
    if (requirements.needsThinking && !profile.supportsThinking) return false
    if (requirements.needsEmbeddings && !profile.isEmbedding) return false

    // Exclude embedding-only models from non-embedding requests
    if (!requirements.needsEmbeddings && profile.isEmbedding) return false

    // Exclude models whose context window is too small (leave 20% headroom for output)
    if (
      requirements.estimatedInputTokens > 0 &&
      requirements.estimatedInputTokens > profile.contextLength * 0.8
    ) {
      return false
    }

    return true
  }

  _recordRoutingMetadata(candidates, requirements) {
    const routedAt = Date.now()
    const endpoint = requirements.endpointType || null
    for (const candidate of candidates) {
      if (!candidate?.modelInfo) continue
      candidate.modelInfo.lastRoutingEndpoint = endpoint
      candidate.modelInfo.lastRoutedAt = routedAt
    }
  }

  /**
   * Normalize a model name to the canonical form used in the inventory.
   * If the name has no tag and is not found, try appending ':latest'.
   * @param {string} modelName
   * @returns {string} resolved model name
   */
  _resolveModelName(modelName) {
    if (modelName.includes(':')) return modelName

    for (const node of this.discovery.getNodes().values()) {
      if (node.models.has(modelName)) return modelName
    }

    const withLatest = `${modelName}:latest`
    for (const node of this.discovery.getNodes().values()) {
      if (node.models.has(withLatest)) return withLatest
    }

    return modelName
  }

  _findModelAnywhere(modelName) {
    for (const node of this.discovery.getNodes().values()) {
      if (node.models.has(modelName)) return true
    }
    return false
  }

  _createModelNotFoundError(modelName) {
    const err = new Error(`Model ${modelName} not found`)
    err.statusCode = 404
    err.code = 'MODEL_NOT_FOUND'
    return err
  }

  /**
   * Determine whether an on-request scan should be blocking or async.
   * Hybrid strategy: block only if last scan was > 5 minutes ago, with 3-sec timeout.
   * @returns {{ shouldBlock: boolean, timeoutMs: number }}
   * @private
   */
  _shouldScanForRequest() {
    const RECENCY_THRESHOLD = 5 * 60 * 1000 // 5 minutes
    const SCAN_TIMEOUT = 3000 // 3 seconds

    const scanStatus = this.discovery.getScanStatus()
    const lastScanMs = scanStatus.lastScanMs
    const now = Date.now()

    // If last scan is fresh (< 5 min ago), use async
    if (lastScanMs > 0 && now - lastScanMs < RECENCY_THRESHOLD) {
      return { shouldBlock: false, timeoutMs: 0 }
    }

    // If last scan is stale (> 5 min) or never run, block with timeout
    return { shouldBlock: true, timeoutMs: SCAN_TIMEOUT }
  }

  /**
   * Perform on-request network scan with optional blocking behavior.
   * @param {boolean} shouldBlock - if true, wait for scan with timeout; if false, fire-and-forget
   * @param {number} timeoutMs - timeout in ms if blocking
   * @private
   */
  async _performOnRequestScan(shouldBlock, timeoutMs) {
    if (!shouldBlock) {
      // Fire-and-forget: scan in background
      this.discovery.discoverNetworkNodes().catch((err) => {
        // Log but don't throw - background scan failure shouldn't break request
        console.debug('Background on-request scan failed:', err.message)
      })
      return
    }

    // Blocking with timeout
    try {
      const scanPromise = this.discovery.discoverNetworkNodes()
      await Promise.race([
        scanPromise,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('On-request scan timeout')),
            timeoutMs,
          ),
        ),
      ])
    } catch (err) {
      // Timeout or scan error - log and continue
      // Request will proceed with current nodes
      console.debug('On-request scan failed or timed out:', err.message)
    }
  }

  _resolveByAlias(modelName, requirements) {
    if (modelName === AUTO_MODEL) {
      return this.selectModel(requirements)
    }

    if (modelName === AUTO_FAST_MODEL) {
      return this.selectModel({ ...requirements, preferFast: true })
    }

    if (modelName === AUTO_THINK_MODEL) {
      return this.selectModel(requirements, {
        candidateFilter: ({ modelInfo }) =>
          Boolean(modelInfo.profile?.supportsThinking),
      })
    }

    return null
  }

  async selectForRequest(reqBody, endpointType) {
    const requirements = this.requestAnalyzer.analyze(reqBody, endpointType)
    const requestedModel = reqBody?.model

    // Trigger on-request scan for virtual models
    if (VIRTUAL_MODELS.has(requestedModel)) {
      const { shouldBlock, timeoutMs } =
        this._shouldScanForRequest(requestedModel)
      await this._performOnRequestScan(shouldBlock, timeoutMs)
    }

    if (!requestedModel) {
      return this.selectModel(requirements)
    }

    if (VIRTUAL_MODELS.has(requestedModel)) {
      return this._resolveByAlias(requestedModel, requirements)
    }

    const resolvedModel = this._resolveModelName(requestedModel)

    if (!this._findModelAnywhere(resolvedModel)) {
      throw this._createModelNotFoundError(requestedModel)
    }

    return this.selectModel(requirements, {
      candidateFilter: ({ modelName }) => modelName === resolvedModel,
    })
  }

  analyzeRequest(reqBody, endpointType) {
    return this.requestAnalyzer.analyze(reqBody, endpointType)
  }

  selectForChat(reqBody) {
    return this.selectForRequest(reqBody, 'chat')
  }

  selectForCompletions(reqBody) {
    return this.selectForRequest(reqBody, 'completions')
  }

  selectForEmbeddings(reqBody) {
    return this.selectForRequest(reqBody, 'embeddings')
  }

  selectForResponses(reqBody) {
    return this.selectForRequest(reqBody, 'responses')
  }

  _toOpenAiModelObject(id, created, ownedBy = 'router', contextLength = 0) {
    const obj = {
      id,
      object: 'model',
      created,
      owned_by: ownedBy,
    }
    if (contextLength > 0) {
      obj.context_window = contextLength
      obj.max_context_window = contextLength
    }
    return obj
  }

  getModelCatalog() {
    const deduped = new Map()

    for (const [nodeHost, node] of this.discovery.getNodes()) {
      if (!node.reachable) continue

      for (const [modelName, modelInfo] of node.models) {
        const created = Math.floor((modelInfo.lastSeen || Date.now()) / 1000)
        const existing = deduped.get(modelName)
        if (!existing || created > existing.created) {
          const contextLength = modelInfo.profile?.contextLength ?? 0
          deduped.set(
            modelName,
            this._toOpenAiModelObject(
              modelName,
              created,
              nodeHost,
              contextLength,
            ),
          )
        }
      }
    }

    const now = Math.floor(Date.now() / 1000)
    for (const virtualModel of VIRTUAL_MODELS) {
      deduped.set(virtualModel, this._toOpenAiModelObject(virtualModel, now))
    }

    return Array.from(deduped.values()).sort((a, b) => a.id.localeCompare(b.id))
  }

  getModelById(modelId) {
    if (VIRTUAL_MODELS.has(modelId)) {
      // Virtual models span multiple real models — no single context length applies
      return this._toOpenAiModelObject(modelId, Math.floor(Date.now() / 1000))
    }

    return this.getModelCatalog().find((model) => model.id === modelId) || null
  }

  /**
   * Score a model against request requirements.
   * Higher is better. Returns -Infinity if model cannot serve request.
   * @param {string} nodeHost
   * @param {ModelInfo} modelInfo
   * @param {RequestRequirements} requirements
   * @returns {number}
   */
  _scoreModel(nodeHost, modelInfo, requirements) {
    const { profile } = modelInfo
    const params = profile.parameters || 0
    const load = this.loadManager.getCurrentLoad(nodeHost)
    const capacity = this.loadManager.getCapacityRemaining(nodeHost)

    if (capacity <= 0) return -Infinity

    // Base performance score from observed latency and throughput
    const recentLat = modelInfo.recentLatency || 2000
    const recentTps = modelInfo.recentTps || 5
    const baseScore = (50 / Math.max(recentLat, 100)) * recentTps

    // Load penalty
    const loadPenalty = load * 10

    // Size fit bonus: match model capacity to request complexity
    const messageCount = requirements.messageCount || 0
    let sizeFit = 0

    if (params > 0) {
      if (requirements.preferFast) {
        // Subagent-like or explicitly fast: prefer small models
        if (params <= 4) sizeFit += 14
        else if (params <= 8) sizeFit += 10
        else if (params <= 12) sizeFit += 2
      } else if (requirements.hasCodeSignals || messageCount > 10) {
        // Code tasks or long conversations: prefer large models
        if (params >= 20 && params <= 35) sizeFit += 14
        else if (params >= 10) sizeFit += 6
        else sizeFit += 1
      } else if (requirements.preferReasoning && messageCount <= 10) {
        // Reasoning without code in short conversations: small thinking models excel
        if (params >= 2 && params <= 8) sizeFit += 14
        else if (params > 8 && params <= 20) sizeFit += 6
        else if (params > 20) sizeFit += 2
      } else {
        // Default: prefer 26B class for general chat
        if (params >= 20 && params <= 35) sizeFit += 10
        else if (params >= 10) sizeFit += 4
      }
    }

    // Thinking-capable models get a bonus for complex requests
    const thinkingBonus = profile.supportsThinking
      ? requirements.preferReasoning
        ? 8
        : requirements.preferFast
          ? 4
          : 0
      : 0

    // Exact multimodal match bonuses
    const visionBonus =
      requirements.needsVision && profile.supportsVision ? 10 : 0
    const audioBonus = requirements.needsAudio && profile.supportsAudio ? 10 : 0

    // Context margin: prefer models with more headroom
    const contextMargin =
      profile.contextLength > 0
        ? Math.min(
            10,
            ((profile.contextLength - requirements.estimatedInputTokens) /
              profile.contextLength) *
              10,
          )
        : 0

    return (
      baseScore -
      loadPenalty +
      sizeFit +
      thinkingBonus +
      visionBonus +
      audioBonus +
      contextMargin
    )
  }
}
