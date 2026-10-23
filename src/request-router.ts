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
import { cloudUsageStore } from './cloud-usage.js'
import type { CloudUsage } from './cloud-usage.js'

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

/** TTFT score scale: latency score loses 1 point per TTFT_PENALTY_SCALE_MS ms. */
const TTFT_PENALTY_SCALE_MS = 150

/** Bonus when a model is the most recently active on its node (likely warm in VRAM). */
const WARM_MODEL_BONUS = 8

/** Penalty when a different model was more recently active on the same node (likely needs loading). */
const MODEL_SWITCH_PENALTY = 5

const WARM_RECENT_MS = 2 * 60 * 1000    // < 2 min → full warm bonus
const WARM_ACTIVE_MS = 5 * 60 * 1000    // < 5 min → half warm bonus
const WARM_INACTIVE_MS = 10 * 60 * 1000 // < 10 min → small warm signal

const STALE_SCAN_THRESHOLD_MS = 5 * 60 * 1000

/** How long to wait (ms) for a WoL-triggered node to come back online. */
const WOL_WAIT_TIMEOUT_MS = 30_000
/** Polling interval (ms) while waiting for a WoL-triggered node. */
const WOL_POLL_INTERVAL_MS = 1_000

/**
 * Computes a warm-model bias for a candidate on a given node.
 * Returns a positive bonus when this model is likely warm in VRAM, or a negative
 * penalty when a different model was more recently active and the node probably
 * needs to evict the old one before loading this one.
 *
 * Cloud nodes are stateless from the router's perspective — they handle model
 * loading internally — so warm/cold VRAM state does not apply.
 */
function computeWarmBonus(model: ModelInfo, nodeModels: Map<string, ModelInfo>, isCloud: boolean): number {
  if (isCloud) return 0

  const now = Date.now()

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
    const age = now - model.lastRoutedAt
    if (age < WARM_RECENT_MS) return WARM_MODEL_BONUS
    if (age < WARM_ACTIVE_MS) return Math.round(WARM_MODEL_BONUS / 2)
    if (age < WARM_INACTIVE_MS) return 2
    return 0
  }

  if (recentModelAge < WARM_ACTIVE_MS) return -MODEL_SWITCH_PENALTY
  return 0
}

/**
 * Dynamic cloud penalty based on current usage percentage.
 * Ramps from 0 → 20 as usage crosses 70 % → 100 %.
 */
export function computeCloudUsagePenalty(usage: CloudUsage | null): number {
  if (!usage || usage.stale || usage.fetchedAt === 0) return 0
  const pct = Math.max(usage.sessionPct, usage.weeklyPct)
  if (pct < 70) return 0
  return Math.round(((pct - 70) / 30) * 20)
}

export interface RoutingRationale {
  latencyScore: number
  tpsScore: number
  sizeFit: number
  warmBonus: number
  loadPenalty: number
  /** Fixed local-preference penalty, always −CLOUD_COST_PREFERENCE for cloud candidates (0 for local). */
  cloudCostPenalty: number
  /** Dynamic usage penalty, ramps 0 → 20 as cloud usage crosses 70 % → 100 %. */
  cloudUsagePenalty: number
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
  /** Advertised context window length. For virtual aliases this is the minimum
   *  across all currently-eligible real models so callers can rely on it being
   *  achievable regardless of which candidate the router ultimately picks. */
  context_length: number
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
    result: RoutingCandidate[] | null,
  ): void {
    if (!result) return
    result.forEach((c) => (c.forcedModel = true))
  }

  /**
   * Polls for up to WOL_WAIT_TIMEOUT_MS for live candidates to appear.
   * Returns the first non-null candidate list, or null if timed out.
   */
  private async _waitForWol(
    model: string,
    analysis: AnalysisResult,
    reqBody: Record<string, unknown>,
    signal?: AbortSignal,
    options: { decisionOnly?: boolean } = {},
  ): Promise<RoutingCandidate[] | null> {
    const deadline = Date.now() + WOL_WAIT_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (signal?.aborted) return null
      await new Promise<void>((r) => setTimeout(r, WOL_POLL_INTERVAL_MS))
      if (signal?.aborted) return null
      const candidates = this._selectCandidates(model, analysis, reqBody, options)
      if (candidates) {
        logger.info({ model }, 'Node came online after WoL — routing request')
        return candidates
      }
    }
    logger.warn({ model }, 'WoL wait timed out — no candidate came online within 30 s')
    return null
  }

  /**
   * Selects candidates, and if none are available triggers WoL for matching
   * offline nodes before polling up to 30 s for them to come back.
   */
  private async _selectWithWolFallback(
    model: string,
    analysis: AnalysisResult,
    reqBody: Record<string, unknown>,
    signal?: AbortSignal,
    options: { decisionOnly?: boolean } = {},
  ): Promise<RoutingCandidate[] | null> {
    const candidates = this._selectCandidates(model, analysis, reqBody, options)
    if (candidates) return candidates

    const woken = this.discovery.tryWakeNodesForRequest(model, analysis)
    if (!woken) return null

    logger.info({ model }, 'No live candidates — WoL triggered, waiting for node to wake')
    return this._waitForWol(model, analysis, reqBody, signal, options)
  }

  async selectForChat(
    reqBody: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<RoutingCandidate[] | null> {
    await this._performOnRequestScan()
    if (signal?.aborted) return null
    const originalModel = (reqBody.model as string) || 'auto'
    const forcedModel = this._applyOverride(reqBody)
    const analysis = this.analyzer.analyze(reqBody, 'chat')
    const model = (reqBody.model as string) || 'auto'
    logger.debug({ model, originalModel, forced: !!forcedModel, ...analysis }, 'Chat routing analysis')
    let result: RoutingCandidate[] | null
    try {
      result = await this._selectWithWolFallback(model, analysis, reqBody, signal)
    } catch (err: unknown) {
      if (forcedModel && (err as { code?: string })?.code === 'MODEL_NOT_FOUND') return null
      throw err
    }
    if (forcedModel) this._tagForced(result)
    return result
  }

  /**
   * /v1/systemone routes decision-model requests: only models with decision
   * capability are eligible, whether named explicitly or selected via auto.
   */
  async selectForSystemone(
    reqBody: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<RoutingCandidate[] | null> {
    await this._performOnRequestScan()
    if (signal?.aborted) return null
    const originalModel = (reqBody.model as string) || 'auto'
    const forcedModel = this._applyOverride(reqBody)
    const analysis = this.analyzer.analyze(reqBody, 'systemone')
    const model = (reqBody.model as string) || 'auto'
    logger.debug({ model, originalModel, forced: !!forcedModel, ...analysis }, 'SystemOne routing analysis')
    let result: RoutingCandidate[] | null
    try {
      result = await this._selectWithWolFallback(model, analysis, reqBody, signal, { decisionOnly: true })
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
  ): Promise<RoutingCandidate[] | null> {
    await this._performOnRequestScan()
    if (signal?.aborted) return null
    const originalModel = (reqBody.model as string) || 'auto'
    const forcedModel = this._applyOverride(reqBody)
    const model = (reqBody.model as string) || 'auto'
    const analysis = this.analyzer.analyze(reqBody, 'embeddings')
    logger.debug({ model, originalModel, forced: !!forcedModel }, 'Embeddings routing analysis')
    const result = await this._selectWithWolFallback(model, analysis, reqBody, signal)
    if (forcedModel) this._tagForced(result)
    return result
  }

  async selectForResponses(
    reqBody: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<RoutingCandidate[] | null> {
    await this._performOnRequestScan()
    if (signal?.aborted) return null
    const originalModel = (reqBody.model as string) || 'auto'
    const forcedModel = this._applyOverride(reqBody)
    const analysis = this.analyzer.analyze(reqBody, 'responses')
    const model = (reqBody.model as string) || 'auto'
    logger.debug({ model, originalModel, forced: !!forcedModel, ...analysis }, 'Responses routing analysis')
    const result = await this._selectWithWolFallback(model, analysis, reqBody, signal)
    if (forcedModel) this._tagForced(result)
    return result
  }

  /**
   * Returns the minimum context_length across all models that are eligible
   * candidates for the given virtual alias.
   */
  private _minContextForAlias(alias: string): number {
    const nodes = this.discovery.getNodes()
    let min = Infinity
    for (const [, node] of nodes) {
      if (!node.reachable) continue
      if (alias === 'auto-local' && node.cloud) continue
      for (const [, modelInfo] of node.models) {
        const { profile } = modelInfo
        if (profile.isEmbedding) continue
        if (alias === 'auto-think' && !profile.supportsThinking) continue
        const ctx = profile.contextLength || 0
        if (ctx > 0 && ctx < min) min = ctx
      }
    }
    return min === Infinity ? 0 : min
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
          if (modelInfo.profile.supportsDecision && !caps.includes('decision'))
            caps.push('decision')
          seen.set(modelName, {
            id: modelName,
            object: 'model',
            owned_by: node.cloud ? 'ollama-cloud' : 'ollama',
            capabilities: caps.length > 0 ? caps : null,
            context_length: modelInfo.profile.contextLength || 0,
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
        context_length: this._minContextForAlias(alias),
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
    options: { decisionOnly?: boolean } = {},
  ): RoutingCandidate[] | null {
    const isVirtual = VIRTUAL_MODELS.has(model)
    if (isVirtual) return this._selectVirtual(model, analysis, options)
    try {
      return this._selectConcrete(model, options)
    } catch (err) {
      const routerErr = err as RouterError
      if (routerErr.code === 'MODEL_NOT_FOUND' && ROUTER_FALLBACK_TO_AUTO) {
        logger.warn(
          { model },
          'Model not found — falling back to auto routing',
        )
        return this._selectVirtual('auto', analysis, options)
      }
      throw err
    }
  }

  private _selectVirtual(
    alias: string,
    analysis: AnalysisResult,
    options: { decisionOnly?: boolean } = {},
  ): RoutingCandidate[] | null {
    const nodes = this.discovery.getNodes()
    const candidates: RoutingCandidate[] = []
    const usagePenalty = computeCloudUsagePenalty(cloudUsageStore.get())
    const { decisionOnly = false } = options

    for (const [nodeHost, node] of nodes) {
      if (!node.reachable) continue
      if (alias === 'auto-local' && node.cloud) continue
      if (!this.load.canAcceptRequest(nodeHost)) continue

      for (const [modelName, modelInfo] of node.models) {
        if (disabledModelsStore.isDisabled(nodeHost, modelName)) continue
        const { profile } = modelInfo
        if (decisionOnly) {
          if (!profile.supportsDecision) continue
        } else if (profile.supportsDecision) {
          continue
        }
        if (analysis.needsEmbeddings) {
          if (!profile.isEmbedding) continue
        } else {
          if (profile.isEmbedding) continue
        }
        if (analysis.needsTools && !profile.supportsTools) continue
        if (analysis.needsVision && !profile.supportsVision) continue
        if (alias === 'auto-think' && !profile.supportsThinking) continue
        const scored = this._scoreModel(modelInfo, analysis, alias, nodeHost)
        const warmBonus = computeWarmBonus(modelInfo, node.models, node.cloud)
        const cloudCostPenalty = node.cloud ? -CLOUD_COST_PREFERENCE : 0
        const cloudUsagePenalty = node.cloud ? -usagePenalty : 0
        const score = scored.baseScore + warmBonus + cloudCostPenalty + cloudUsagePenalty
        const rationale: RoutingRationale = {
          latencyScore: scored.latencyScore,
          tpsScore: scored.tpsScore,
          sizeFit: scored.sizeFit,
          warmBonus,
          loadPenalty: scored.loadPenalty,
          cloudCostPenalty,
          cloudUsagePenalty,
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
    return candidates
  }

  private _selectConcrete(
    model: string,
    options: { decisionOnly?: boolean } = {},
  ): RoutingCandidate[] | null {
    const nodes = this.discovery.getNodes()
    const candidates: RoutingCandidate[] = []
    const usagePenalty = computeCloudUsagePenalty(cloudUsageStore.get())
    const { decisionOnly = false } = options

    for (const [nodeHost, node] of nodes) {
      if (!node.reachable) continue
      if (!this.load.canAcceptRequest(nodeHost)) continue
      const modelInfo = node.models.get(model)
      if (!modelInfo) continue
      if (disabledModelsStore.isDisabled(nodeHost, model)) continue
      if (decisionOnly) {
        if (!modelInfo.profile.supportsDecision) continue
      } else if (modelInfo.profile.supportsDecision) {
        continue
      }
      const scored = this._scoreModel(modelInfo, { preferFast: false } as AnalysisResult, 'auto', nodeHost)
      const warmBonus = computeWarmBonus(modelInfo, node.models, node.cloud)
      const cloudCostPenalty = node.cloud ? -CLOUD_COST_PREFERENCE : 0
      const cloudUsagePenalty = node.cloud ? -usagePenalty : 0
      const score = scored.baseScore + warmBonus + cloudCostPenalty + cloudUsagePenalty
      const rationale: RoutingRationale = {
        latencyScore: scored.latencyScore,
        tpsScore: scored.tpsScore,
        sizeFit: scored.sizeFit,
        warmBonus,
        loadPenalty: scored.loadPenalty,
        cloudCostPenalty,
        cloudUsagePenalty,
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
      if (decisionOnly) {
        const err = Object.assign(
          new Error(
            `Model ${model} does not support decision output — /v1/systemone requires a decision-capable model`,
          ),
          { statusCode: 400, code: 'MODEL_NOT_DECISION' },
        ) as RouterError
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
    return candidates
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

    // Prefer the real first-token latency; fall back to the legacy whole-
    // response duration (persisted data from before TTFT was measured),
    // scored on its own wall-clock scale until TTFT overwrites it.
    const legacyLatencyScore =
      modelInfo.recentLatency > 0 ? Math.max(0, 20 - modelInfo.recentLatency / 500) : 10
    const latencyScore = modelInfo.recentTtft > 0
      ? Math.max(0, 20 - modelInfo.recentTtft / TTFT_PENALTY_SCALE_MS)
      : legacyLatencyScore
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
        sizeFit += 10
        sizeReason = 'reasoning: very large model (≥20B)'
      } else if (params >= 10) {
        sizeFit += 5
        sizeReason = 'reasoning: large model (10–20B)'
      } else {
        sizeFit += 1
        sizeReason = 'reasoning: small model (fallback)'
      }
      if (profile.supportsThinking) {
        sizeFit += 6
        sizeReason += ' · thinking'
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
        ? 0
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
