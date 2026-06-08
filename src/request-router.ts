// request-router.ts - Selects optimal Ollama node/model for each request
import { RequestAnalyzer } from './request-analyzer.js'
import type { AnalysisResult } from './request-analyzer.js'
import { createLogger } from './logger.js'
import type { DiscoveryManager } from './discovery-manager.js'
import type { LoadManager } from './load-manager.js'
import type { ModelInfo } from './models.js'
import { forceModelStore } from './force-model-store.js'
import { disabledModelsStore } from './disabled-models-store.js'
import { ROUTER_FALLBACK_TO_AUTO } from './config.js'

const logger = createLogger('router')

/** Virtual model aliases exposed in catalog and used by ollama.ts */
export const VIRTUAL_MODELS = new Set<string>([
  'auto',
  'auto-fast',
  'auto-think',
  'auto-local',
])

/**
 * Small preference bonus for local nodes over cloud candidates.
 * Cloud nodes compete on measured latency/TPS merit and win when materially faster or better.
 * Only overridden by `auto-local` which excludes cloud entirely.
 */
const CLOUD_COST_PREFERENCE = 8

/**
 * Maximum load penalty points at 100 % node utilisation.
 * Scaled by getUtilization() so partially-loaded nodes receive proportional penalties.
 */
const LOAD_PENALTY_MAX = 15

/** Bonus when a model is the most recently active on its node (likely warm in VRAM). */
const WARM_MODEL_BONUS = 8

/** Penalty when a different model was more recently active on the same node (likely needs eviction). */
const MODEL_SWITCH_PENALTY = 5

const WARM_RECENT_MS = 2 * 60 * 1000    // < 2 min → full warm bonus
const WARM_ACTIVE_MS = 5 * 60 * 1000    // < 5 min → half warm bonus
const WARM_INACTIVE_MS = 10 * 60 * 1000 // < 10 min → small warm signal

const STALE_SCAN_THRESHOLD_MS = 5 * 60 * 1000

/**
 * Computes a warm-model bias for a candidate on a given node.
 * Returns a positive bonus when this model is likely warm in VRAM, or a negative
 * penalty when a different model was more recently active and the node probably
 * needs to evict the old one before loading this one.
 */
function computeWarmBonus(model: ModelInfo, nodeModels: Map<string, ModelInfo>): number {
  const now = Date.now()

  // Find the most recently routed model on this node
  let mostRecentlyRouted: ModelInfo | null = null
  let maxRoutedAt = 0
  for (const m of nodeModels.values()) {
    if (m.lastRoutedAt > maxRoutedAt) {
      maxRoutedAt = m.lastRoutedAt
      mostRecentlyRouted = m
    }
  }

  if (mostRecentlyRouted === null || maxRoutedAt === 0) return 0

  const recentModelAge = now - maxRoutedAt

  if (mostRecentlyRouted === model) {
    // This model is the most recently used on this node → likely warm in VRAM
    const age = now - model.lastRoutedAt
    if (age < WARM_RECENT_MS) return WARM_MODEL_BONUS
    if (age < WARM_ACTIVE_MS) return Math.round(WARM_MODEL_BONUS / 2)
    if (age < WARM_INACTIVE_MS) return 2
    return 0
  }

  // A different model is more recently active → this model likely needs loading (eviction penalty)
  if (recentModelAge < WARM_ACTIVE_MS) return -MODEL_SWITCH_PENALTY
  return 0
}

export interface RoutingRationale {
  latencyScore: number
  tpsScore: number
  sizeFit: number
  warmBonus: number
  loadPenalty: number
  cloudPenalty: number
  thinkingBonus: number
  contextMargin: number
  totalScore: number
  sizeReason: string
}

export interface RoutingCandidate {
  nodeHost: string
  modelName: string
  modelInfo: ModelInfo
  score: number
  forcedModel?: boolean
  rationale?: RoutingRationale
}

export interface ModelCatalogEntry {
  id: string
  object: string
  owned_by: string
  capabilities: string[] | null
}

/** Error shape used at both throw and catch sites. Fields optional for safe narrowing. */
export interface RouterError extends Error {
  statusCode?: number
  code?: string
}

export class RequestRouter {
  readonly discovery: DiscoveryManager
  readonly load: LoadManager
  private readonly analyzer: RequestAnalyzer

  constructor(discoveryManager: DiscoveryManager, loadManager: LoadManager) {
    this.discovery = discoveryManager
    this.load = loadManager
    this.analyzer = new RequestAnalyzer()
  }

  analyzeRequest(
    reqBody: Record<string, unknown>,
    endpointType: string,
  ): AnalysisResult {
    return this.analyzer.analyze(reqBody, endpointType)
  }

  /**
   * Applies a pending force-model override to the request body.
   * Mutates reqBody.model so downstream candidate selection uses the forced model.
   * Must be called AFTER capturing the original model name for history/logging.
   * Returns the forced model name, or null if no override was active.
   */
  private _applyOverride(reqBody: Record<string, unknown>): string | null {
    const forced = forceModelStore.consume()
    if (!forced) return null
    logger.info(
      { forcedModel: forced, originalModel: reqBody.model },
      'Force-model override applied — bypassing normal routing',
    )
    reqBody.model = forced
    return forced
  }

  private _tagForced(
    result: RoutingCandidate | RoutingCandidate[] | null,
  ): void {
    if (!result) return
    if (Array.isArray(result)) result.forEach((c) => (c.forcedModel = true))
    else result.forcedModel = true
  }

  async selectForChat(
    reqBody: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<RoutingCandidate | RoutingCandidate[] | null> {
    await this._performOnRequestScan()
    if (signal?.aborted) return null
    // Capture original model BEFORE override mutates reqBody, so history reflects client intent
    const originalModel = (reqBody.model as string) || 'auto'
    const forcedModel = this._applyOverride(reqBody)
    const analysis = this.analyzer.analyze(reqBody, 'chat')
    const model = (reqBody.model as string) || 'auto'
    logger.debug({ model, originalModel, forced: !!forcedModel, ...analysis }, 'Chat routing analysis')
    let result: RoutingCandidate | RoutingCandidate[] | null
    try {
      result = this._selectCandidates(model, analysis, reqBody)
    } catch (err: unknown) {
      if (forcedModel && (err as { code?: string })?.code === 'MODEL_NOT_FOUND') return null
      throw err
    }
    if (forcedModel) this._tagForced(result)
    return result
  }

  async selectForEmbeddings(
    reqBody: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<RoutingCandidate | RoutingCandidate[] | null> {
    await this._performOnRequestScan()
    if (signal?.aborted) return null
    const originalModel = (reqBody.model as string) || 'auto'
    const forcedModel = this._applyOverride(reqBody)
    const model = (reqBody.model as string) || 'auto'
    const analysis = this.analyzer.analyze(reqBody, 'embeddings')
    logger.debug({ model, originalModel, forced: !!forcedModel }, 'Embeddings routing analysis')
    const result = this._selectCandidates(model, analysis, reqBody)
    if (forcedModel) this._tagForced(result)
    return result
  }

  async selectForResponses(
    reqBody: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<RoutingCandidate | RoutingCandidate[] | null> {
    await this._performOnRequestScan()
    if (signal?.aborted) return null
    const originalModel = (reqBody.model as string) || 'auto'
    const forcedModel = this._applyOverride(reqBody)
    const analysis = this.analyzer.analyze(reqBody, 'responses')
    const model = (reqBody.model as string) || 'auto'
    logger.debug({ model, originalModel, forced: !!forcedModel, ...analysis }, 'Responses routing analysis')
    const result = this._selectCandidates(model, analysis, reqBody)
    if (forcedModel) this._tagForced(result)
    return result
  }

  getModelCatalog(): ModelCatalogEntry[] {
    const seen = new Map<string, ModelCatalogEntry>()
    for (const node of this.discovery.getNodes().values()) {
      if (!node.reachable) continue
      for (const [modelName, modelInfo] of node.models) {
        if (disabledModelsStore.isDisabled(node.host, modelName)) continue
        if (!seen.has(modelName)) {
          const caps: string[] = [...modelInfo.profile.capabilities]
          if (modelInfo.profile.supportsVision && !caps.includes('vision'))
            caps.push('vision')
          if (modelInfo.profile.supportsTools && !caps.includes('tools'))
            caps.push('tools')
          if (modelInfo.profile.supportsThinking && !caps.includes('thinking'))
            caps.push('thinking')
          if (modelInfo.profile.isEmbedding && !caps.includes('embedding'))
            caps.push('embedding')
          seen.set(modelName, {
            id: modelName,
            object: 'model',
            owned_by: node.cloud ? 'ollama-cloud' : 'ollama',
            capabilities: caps.length > 0 ? caps : null,
          })
        }
      }
    }
    const models = [...seen.values()]
    for (const alias of VIRTUAL_MODELS) {
      models.push({
        id: alias,
        object: 'model',
        owned_by: 'ollama-router',
        capabilities: null,
      })
    }
    return models
  }

  private async _performOnRequestScan(): Promise<void> {
    if (!this.discovery.autoDiscover) return
    const { inProgress, lastScanMs } = this.discovery.getScanStatus()
    const stale = Date.now() - lastScanMs > STALE_SCAN_THRESHOLD_MS
    if (!inProgress && stale) {
      this.discovery.discoverNetworkNodes().catch((err: Error) => {
        logger.warn({ err: err.message }, 'On-request scan failed')
      })
    }
  }

  private _selectCandidates(
    model: string,
    analysis: AnalysisResult,
    reqBody: Record<string, unknown>,
  ): RoutingCandidate | RoutingCandidate[] | null {
    const isVirtual = VIRTUAL_MODELS.has(model)
    const isStreaming = Boolean(reqBody?.stream)
    if (isVirtual) return this._selectVirtual(model, analysis, isStreaming)
    try {
      return this._selectConcrete(model, isStreaming)
    } catch (err) {
      const routerErr = err as RouterError
      if (routerErr.code === 'MODEL_NOT_FOUND' && ROUTER_FALLBACK_TO_AUTO) {
        logger.warn(
          { model },
          'Model not found — falling back to auto routing',
        )
        return this._selectVirtual('auto', analysis, isStreaming)
      }
      throw err
    }
  }

  private _selectVirtual(
    alias: string,
    analysis: AnalysisResult,
    isStreaming: boolean,
  ): RoutingCandidate | RoutingCandidate[] | null {
    const nodes = this.discovery.getNodes()
    const candidates: RoutingCandidate[] = []

    for (const [nodeHost, node] of nodes) {
      if (!node.reachable) continue

      // auto-local: local-only routing. All other virtual aliases (auto, auto-fast, auto-think) include cloud.
      if (alias === 'auto-local' && node.cloud) continue

      if (!this.load.canAcceptRequest(nodeHost)) continue

      for (const [modelName, modelInfo] of node.models) {
        if (disabledModelsStore.isDisabled(nodeHost, modelName)) continue
        const { profile } = modelInfo
        if (analysis.needsEmbeddings) {
          if (!profile.isEmbedding) continue
        } else {
          if (profile.isEmbedding) continue
        }
        if (analysis.needsTools && !profile.supportsTools) continue
        if (analysis.needsVision && !profile.supportsVision) continue
        if (alias === 'auto-think' && !profile.supportsThinking) continue
        const scored = this._scoreModel(modelInfo, analysis, alias, nodeHost)
        const warmBonus = computeWarmBonus(modelInfo, node.models)
        const cloudAdjustment = node.cloud ? -CLOUD_COST_PREFERENCE : 0
        const score = scored.baseScore + warmBonus + cloudAdjustment
        const rationale: RoutingRationale = {
          latencyScore: scored.latencyScore,
          tpsScore: scored.tpsScore,
          sizeFit: scored.sizeFit,
          warmBonus,
          loadPenalty: scored.loadPenalty,
          cloudPenalty: cloudAdjustment,
          thinkingBonus: scored.thinkingBonus,
          contextMargin: scored.contextMargin,
          totalScore: score,
          sizeReason: scored.sizeReason,
        }
        candidates.push({ nodeHost, modelName, modelInfo, score, rationale })
      }
    }

    if (candidates.length === 0) return null
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

  private _selectConcrete(
    model: string,
    isStreaming: boolean,
  ): RoutingCandidate | RoutingCandidate[] | null {
    const nodes = this.discovery.getNodes()
    const candidates: RoutingCandidate[] = []

    for (const [nodeHost, node] of nodes) {
      if (!node.reachable) continue
      if (!this.load.canAcceptRequest(nodeHost)) continue
      const modelInfo = node.models.get(model)
      if (!modelInfo) continue
      if (disabledModelsStore.isDisabled(nodeHost, model)) continue
      const scored = this._scoreModel(modelInfo, { preferFast: false } as AnalysisResult, 'auto', nodeHost)
      const warmBonus = computeWarmBonus(modelInfo, node.models)
      const cloudAdjustment = node.cloud ? -CLOUD_COST_PREFERENCE : 0
      const score = scored.baseScore + warmBonus + cloudAdjustment
      const rationale: RoutingRationale = {
        latencyScore: scored.latencyScore,
        tpsScore: scored.tpsScore,
        sizeFit: scored.sizeFit,
        warmBonus,
        loadPenalty: scored.loadPenalty,
        cloudPenalty: cloudAdjustment,
        thinkingBonus: scored.thinkingBonus,
        contextMargin: scored.contextMargin,
        totalScore: score,
        sizeReason: scored.sizeReason,
      }
      candidates.push({ nodeHost, modelName: model, modelInfo, score, rationale })
    }

    if (candidates.length === 0) {
      let modelExists = false
      for (const node of nodes.values()) {
        if (node.models.has(model)) {
          modelExists = true
          break
        }
      }
      if (!modelExists) {
        const err = Object.assign(new Error(`Model not found: ${model}`), {
          statusCode: 404,
          code: 'MODEL_NOT_FOUND',
        }) as RouterError
        throw err
      }
      return null
    }

    candidates.sort((a, b) => b.score - a.score)
    logger.debug(
      candidates.slice(0, 3).map((c) => ({
        model: c.modelName,
        node: c.nodeHost,
        score: Math.round(c.score * 10) / 10,
      })),
      'Top routing candidates (_selectConcrete)',
    )
    return isStreaming ? candidates[0] : candidates
  }

  private _scoreModel(
    modelInfo: ModelInfo,
    requirements: AnalysisResult,
    alias: string,
    nodeHost: string,
  ): {
    baseScore: number
    latencyScore: number
    tpsScore: number
    contextMargin: number
    loadPenalty: number
    sizeFit: number
    thinkingBonus: number
    sizeReason: string
  } {
    const { profile } = modelInfo
    const params = profile.parameters || 0
    const contextLength = profile.contextLength || 4096
    const messageCount = requirements.messageCount || 0
    const estimatedTokens = requirements.estimatedInputTokens || 0

    const latencyScore = modelInfo.recentLatency
      ? Math.max(0, 20 - modelInfo.recentLatency / 500)
      : 10
    const tpsScore = modelInfo.recentTps
      ? Math.min(10, modelInfo.recentTps / 5)
      : 5
    const baseScore = latencyScore + tpsScore

    const contextMargin =
      contextLength > estimatedTokens * 2
        ? 5
        : contextLength > estimatedTokens
          ? 2
          : 0

    const loadPenalty = this.load.getUtilization(nodeHost) * LOAD_PENALTY_MAX

    let sizeFit = 0
    let sizeReason: string
    if (alias === 'auto-fast' || requirements.preferFast) {
      if (params >= 3 && params <= 9) {
        sizeFit += 14
        sizeReason = 'fast path: medium model (3–9B)'
      } else if (params > 0 && params < 3) {
        sizeFit += 12
        sizeReason = 'fast path: tiny model (<3B)'
      } else {
        sizeFit += 1
        sizeReason = 'fast path: large model (fallback)'
      }
    } else if (requirements.preferReasoning) {
      if (params >= 20) {
        sizeFit += 14
        sizeReason = 'reasoning: very large model (≥20B)'
      } else if (params >= 10) {
        sizeFit += 6
        sizeReason = 'reasoning: large model (10–20B)'
      } else {
        sizeFit += 1
        sizeReason = 'reasoning: small model (fallback)'
      }
    } else if (requirements.hasCodeSignals || messageCount > 10) {
      if (params >= 20 && params <= 35) {
        sizeFit += 14
        sizeReason = 'code / long chat: 20–35B model'
      } else if (params >= 10) {
        sizeFit += 6
        sizeReason = 'code / long chat: ≥10B model'
      } else {
        sizeFit += 1
        sizeReason = 'code / long chat: small model (fallback)'
      }
    } else {
      if (params >= 3 && params <= 8) {
        sizeFit += 12
        sizeReason = 'general chat: 3–8B model'
      } else if (params > 0 && params < 3) {
        sizeFit += 7
        sizeReason = 'general chat: tiny model (<3B)'
      } else if (params <= 15) {
        sizeFit += 6
        sizeReason = 'general chat: mid model (<=15B)'
      } else {
        sizeFit += 2
        sizeReason = 'general chat: large model (fallback)'
      }
    }

    const thinkingBonus = profile.supportsThinking
      ? requirements.preferReasoning
        ? 8
        : requirements.preferFast || alias === 'auto-fast'
          ? 6
          : 0
      : 0

    return {
      baseScore: baseScore + contextMargin + sizeFit + thinkingBonus - loadPenalty,
      latencyScore,
      tpsScore,
      contextMargin,
      loadPenalty,
      sizeFit,
      thinkingBonus,
      sizeReason,
    }
  }
}
