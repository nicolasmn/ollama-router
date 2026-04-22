// request-router.js - Encapsulates request routing logic
import pino from 'pino'
import { RequestAnalyzer } from './request-analyzer.js'

const logger = pino()
const AUTO_MODEL = 'auto'
const AUTO_FAST_MODEL = 'auto-fast'
const AUTO_THINK_MODEL = 'auto-think'
const VIRTUAL_MODELS = new Set([AUTO_MODEL, AUTO_FAST_MODEL, AUTO_THINK_MODEL])

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

    if (candidates.length === 0) return null

    candidates.sort((a, b) => b.score - a.score)

    if (requirements.isStreaming) {
      const best = candidates[0]
      this._recordRoutingMetadata([best], requirements)
      return best
    } else {
      const top = candidates.slice(0, 3)
      this._recordRoutingMetadata(top, requirements)
      return top
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

  _resolveByAlias(modelName, requirements) {
    if (modelName === AUTO_MODEL) {
      return this.selectModel(requirements)
    }

    if (modelName === AUTO_FAST_MODEL) {
      const fastSelection = this.selectModel(requirements, {
        candidateFilter: ({ modelInfo }) => {
          const params = modelInfo.profile?.parameters || 0
          return params > 0 && params <= 4
        },
      })

      return fastSelection || this.selectModel(requirements)
    }

    if (modelName === AUTO_THINK_MODEL) {
      return this.selectModel(requirements, {
        candidateFilter: ({ modelInfo }) =>
          Boolean(modelInfo.profile?.supportsThinking),
      })
    }

    return null
  }

  selectForRequest(reqBody, endpointType) {
    const requirements = this.requestAnalyzer.analyze(reqBody, endpointType)
    const requestedModel = reqBody?.model

    if (!requestedModel) {
      return this.selectModel(requirements)
    }

    if (VIRTUAL_MODELS.has(requestedModel)) {
      return this._resolveByAlias(requestedModel, requirements)
    }

    if (!this._findModelAnywhere(requestedModel)) {
      throw this._createModelNotFoundError(requestedModel)
    }

    return this.selectModel(requirements, {
      candidateFilter: ({ modelName }) => modelName === requestedModel,
    })
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
            this._toOpenAiModelObject(modelName, created, nodeHost, contextLength),
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
    let sizeFit = 0
    if (requirements.preferReasoning && profile.parameters >= 14) sizeFit += 15
    if (
      requirements.preferFast &&
      profile.parameters > 0 &&
      profile.parameters <= 4
    )
      sizeFit += 12

    // Thinking-capable models get a bonus for complex requests
    const thinkingBonus =
      requirements.preferReasoning && profile.supportsThinking ? 20 : 0

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

  /**
   * Update model metrics after a successful request
   * @param {string} nodeHost - node host
   * @param {string} modelName - model name
   * @param {number} latency - latency in milliseconds
   * @param {number} tokensGenerated - number of tokens generated
   */
  updateModelMetrics(nodeHost, modelName, latency, tokensGenerated = 0) {
    const node = this.discovery.getNodes().get(nodeHost)
    if (!node) {
      logger.warn({ nodeHost }, 'Node not found for metrics update')
      return
    }

    const modelInfo = node.models.get(modelName)
    if (!modelInfo) {
      logger.warn({ nodeHost, modelName }, 'Model not found for metrics update')
      return
    }

    // Update latency with exponential moving average
    modelInfo.recentLatency = 0.9 * modelInfo.recentLatency + 0.1 * latency

    // Update tokens per second
    const tps = latency > 0 ? tokensGenerated / (latency / 1000) : 0
    modelInfo.recentTps = 0.9 * modelInfo.recentTps + 0.1 * tps

    // Update last seen
    modelInfo.lastSeen = Date.now()
  }

  /**
   * Record a failure for a model
   * @param {string} nodeHost - node host
   * @param {string} modelName - model name
   */
  recordModelFailure(nodeHost, modelName) {
    const node = this.discovery.getNodes().get(nodeHost)
    if (!node) return

    const modelInfo = node.models.get(modelName)
    if (!modelInfo) return

    modelInfo.failures = (modelInfo.failures || 0) + 1
    logger.debug(
      { nodeHost, modelName, failures: modelInfo.failures },
      'Model failure recorded',
    )
  }
}
