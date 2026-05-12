// request-router.ts - Selects optimal Ollama node/model for each request
import { RequestAnalyzer } from './request-analyzer.js'
import type { AnalysisResult } from './request-analyzer.js'
import { createLogger } from './logger.js'
import type { DiscoveryManager } from './discovery-manager.js'
import type { LoadManager } from './load-manager.js'
import type { ModelInfo } from './models.js'

const logger = createLogger('router')

/** Virtual model aliases exposed in catalog and used by ollama.ts */
export const VIRTUAL_MODELS = new Set<string>(['auto', 'auto-fast', 'auto-think', 'auto-cloud'])

/**
 * Score penalty applied to cloud node candidates.
 * Ensures local candidates win when both local and cloud have the same model.
 * Cloud wins only when it is the sole node with that model.
 */
const CLOUD_SCORE_PENALTY = 50

const STALE_SCAN_THRESHOLD_MS = 5 * 60 * 1000

export interface RoutingCandidate {
  nodeHost: string
  modelName: string
  modelInfo: ModelInfo
  score: number
}

export interface ModelCatalogEntry {
  id: string
  object: string
  owned_by: string
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

  async selectForChat(
    reqBody: Record<string, unknown>,
  ): Promise<RoutingCandidate | RoutingCandidate[] | null> {
    await this._performOnRequestScan()
    const analysis = this.analyzer.analyze(reqBody, 'chat')
    const model = (reqBody.model as string) || 'auto'
    logger.debug({ model, ...analysis }, 'Chat routing analysis')
    return this._selectCandidates(model, analysis, reqBody)
  }

  async selectForEmbeddings(
    reqBody: Record<string, unknown>,
  ): Promise<RoutingCandidate | RoutingCandidate[] | null> {
    await this._performOnRequestScan()
    const model = (reqBody.model as string) || 'auto'
    const analysis = this.analyzer.analyze(reqBody, 'embeddings')
    return this._selectCandidates(model, analysis, reqBody)
  }

  async selectForResponses(
    reqBody: Record<string, unknown>,
  ): Promise<RoutingCandidate | RoutingCandidate[] | null> {
    await this._performOnRequestScan()
    const analysis = this.analyzer.analyze(reqBody, 'responses')
    const model = (reqBody.model as string) || 'auto'
    logger.debug({ model, ...analysis }, 'Responses routing analysis')
    return this._selectCandidates(model, analysis, reqBody)
  }

  getModelCatalog(): ModelCatalogEntry[] {
    const seen = new Set<string>()
    const models: ModelCatalogEntry[] = []
    for (const node of this.discovery.getNodes().values()) {
      if (!node.reachable) continue
      for (const modelName of node.models.keys()) {
        if (!seen.has(modelName)) {
          seen.add(modelName)
          models.push({ id: modelName, object: 'model', owned_by: node.cloud ? 'ollama-cloud' : 'ollama' })
        }
      }
    }
    for (const alias of VIRTUAL_MODELS) {
      models.push({ id: alias, object: 'model', owned_by: 'ollama-router' })
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
    return this._selectConcrete(model, isStreaming)
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

      // For auto-cloud: include all nodes (local + cloud).
      // For other virtual models: skip cloud nodes — they are only for explicit auto-cloud routing.
      if (alias !== 'auto-cloud' && node.cloud) continue

      if (!this.load.canAcceptRequest(nodeHost)) continue

      for (const [modelName, modelInfo] of node.models) {
        const { profile } = modelInfo
        if (analysis.needsEmbeddings) {
          if (!profile.isEmbedding) continue
        } else {
          if (profile.isEmbedding) continue
        }
        if (analysis.needsTools && !profile.supportsTools) continue
        if (analysis.needsVision && !profile.supportsVision) continue
        if (alias === 'auto-think' && !profile.supportsThinking) continue
        const baseScore = this._scoreModel(modelInfo, analysis, alias)
        const score = node.cloud ? baseScore - CLOUD_SCORE_PENALTY : baseScore
        candidates.push({ nodeHost, modelName, modelInfo, score })
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
      const loadPenalty = this.load.getCurrentLoad(nodeHost) * 2
      const latencyScore = modelInfo.recentLatency
        ? Math.max(0, 20 - modelInfo.recentLatency / 500)
        : 10
      // Apply same cloud penalty as _selectVirtual: local wins when both nodes
      // have the model, cloud wins only when it is the sole provider.
      const score = node.cloud
        ? latencyScore - loadPenalty - CLOUD_SCORE_PENALTY
        : latencyScore - loadPenalty
      candidates.push({ nodeHost, modelName: model, modelInfo, score })
    }

    if (candidates.length === 0) {
      let modelExists = false
      for (const node of nodes.values()) {
        if (node.models.has(model)) { modelExists = true; break }
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
  ): number {
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

    const loadPenalty = this.load.getCurrentLoad(modelInfo.name || '') * 2

    let sizeFit = 0
    if (alias === 'auto-fast' || requirements.preferFast) {
      if (params >= 3 && params <= 9) sizeFit += 14
      else if (params > 0 && params < 3) sizeFit += 12
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
      if (params >= 3 && params <= 8) sizeFit += 12
      else if (params > 0 && params < 3) sizeFit += 7
      else if (params <= 15) sizeFit += 6
      else sizeFit += 2
    }

    const thinkingBonus = profile.supportsThinking
      ? requirements.preferReasoning
        ? 8
        : requirements.preferFast || alias === 'auto-fast'
          ? 6
          : 0
      : 0

    return baseScore + contextMargin + sizeFit + thinkingBonus - loadPenalty
  }
}
