// request-router.ts - Selects optimal Ollama node/model for each request
import { RequestAnalyzer, bodyHasImages } from './request-analyzer.js'
import type { AnalysisResult } from './request-analyzer.js'
import { createLogger } from './logger.js'
import type { DiscoveryManager } from './discovery-manager.js'
import type { LoadManager } from './load-manager.js'
import type { ModelInfo, NodeInfo } from './models.js'
import { forceModelStore } from './force-model-store.js'
import { disabledModelsStore } from './disabled-models-store.js'
import { ROUTER_FALLBACK_TO_AUTO } from './config.js'
import { cloudUsageStore } from './cloud-usage.js'
import {
  NEUTRAL_ANALYSIS,
  TaskProfile,
  annotateRanking,
  cloudUsagePressure,
  computeEvictionSignal,
  computeWarmSignal,
  fitsContext,
  scoreCandidate,
} from './routing-score.js'
import type { ScoreBreakdown } from './routing-score.js'

const logger = createLogger('router')

/** Virtual model aliases exposed in catalog and used by ollama.ts */
export const VIRTUAL_MODELS = new Set<string>([
  'auto',
  'auto-fast',
  'auto-think',
  'auto-local',
])

const STALE_SCAN_THRESHOLD_MS = 5 * 60 * 1000

/** Bounded cache of routing decisions keyed by routing signature, so running
 *  threads (and similar requests) skip re-analysis and full candidate
 *  re-scoring on every turn. Entries expire after TTL and are evicted oldest-first. */
const ROUTING_CACHE_MAX = 256
const ROUTING_CACHE_TTL_MS = 60_000
/** Token-count bucket width — small context growth keeps the cache hot; large
 *  growth busts it so a model isn't reused past its comfortable context window. */
const ROUTING_TOKEN_BUCKET = 4096

/** Conversation-fast-path cache TTL. Running threads that send a stable
 *  conversation_id reuse the previous routing decision without re-analyzing
 *  the (often large) request body on every turn. */
const ROUTING_CONV_TTL_MS = 5 * 60 * 1000

/** Best-effort conversation id from common request fields. Cheap — only reads
 *  top-level / metadata keys, never scans message text. */
function extractConversationId(reqBody: Record<string, unknown>): string | null {
  const idKeys = [
    'conversation_id', 'conversationId', 'thread_id', 'threadId',
    'session_id', 'sessionId', 'chat_id', 'chatId',
  ]
  for (const key of idKeys) {
    const value = reqBody[key]
    if (typeof value === 'string' && value) return value
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  const metadata = reqBody?.metadata
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    for (const key of idKeys) {
      const value = (metadata as Record<string, unknown>)[key]
      if (typeof value === 'string' && value) return value
      if (typeof value === 'number' && Number.isFinite(value)) return String(value)
    }
  }
  return null
}

/** Cheap capability signals that can be read without scanning message text. */
function cheapSignals(reqBody: Record<string, unknown>): {
  stream: boolean
  maxTokensBucket: number
  tools: boolean
  messageCount: number
  needsVision: boolean
  needsAudio: boolean
} {
  const stream = Boolean(reqBody.stream)
  const maxTokens = Number(
    (reqBody.max_completion_tokens as number) ?? (reqBody.max_tokens as number),
  ) || 0
  const maxTokensBucket = Math.floor(maxTokens / ROUTING_TOKEN_BUCKET) * ROUTING_TOKEN_BUCKET
  const tools = Array.isArray(reqBody.tools) && (reqBody.tools as unknown[]).length > 0
  const messages = Array.isArray(reqBody.messages) ? (reqBody.messages as unknown[]) : []
  let needsVision = false
  let needsAudio = false
  for (const msg of messages) {
    const content = (msg as Record<string, unknown> | null | undefined)?.content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      const p = part as Record<string, unknown> | null | undefined
      const type = p?.type
      if (type === 'image_url' || type === 'image') needsVision = true
      if (type === 'input_audio' || type === 'audio') needsAudio = true
      if (needsVision && needsAudio) break
    }
    if (needsVision && needsAudio) break
  }
  // Native Ollama sends images as top-level / per-message arrays, not as
  // OpenAI-style content parts — use the shared scan so all shapes are covered.
  if (bodyHasImages(reqBody)) needsVision = true
  return { stream, maxTokensBucket, tools, messageCount: messages.length, needsVision, needsAudio }
}

/** How long to wait (ms) for a WoL-triggered node to come back online. */
const WOL_WAIT_TIMEOUT_MS = 30_000
/** Polling interval (ms) while waiting for a WoL-triggered node. */
const WOL_POLL_INTERVAL_MS = 1_000

export interface RoutingCandidate {
  nodeHost: string
  modelName: string
  modelInfo: ModelInfo
  score: number
  forcedModel?: boolean
  rationale?: ScoreBreakdown
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

/**
 * Largest criteria set across all questions of a /v1/systemone request.
 * 0 when the request carries no measurable criteria (non-object questions).
 */
export function maxChoiceCriteria(reqBody: Record<string, unknown> | null | undefined): number {
  const questions = reqBody?.questions as unknown
  if (typeof questions !== 'object' || questions === null) return 0
  const list = Array.isArray(questions) ? questions : Object.values(questions as Record<string, unknown>)
  let max = 0
  for (const q of list) {
    if (typeof q !== 'object' || q === null) continue
    const criteria = (q as { criteria?: unknown }).criteria
    if (Array.isArray(criteria)) max = Math.max(max, criteria.length)
    else if (typeof criteria === 'object' && criteria !== null) {
      max = Math.max(max, Object.keys(criteria).length)
    }
  }
  return max
}

export interface SelectionOptions {
  decisionOnly?: boolean
  // Largest criteria set in the request, for decision-model cap filtering.
  maxCriteria?: number
}

export class RequestRouter {
  readonly discovery: DiscoveryManager
  readonly load: LoadManager
  private readonly analyzer: RequestAnalyzer
  readonly #routingCache = new Map<string, { candidates: RoutingCandidate[]; cachedAt: number }>()
  /** Conversation-fast-path cache keyed by conversation_id (+ cheap signals),
   *  so running threads skip re-analysis and re-scoring on every turn. */
  readonly #conversationCache = new Map<string, { candidates: RoutingCandidate[]; cachedAt: number }>()

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
    options: SelectionOptions = {},
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
    options: SelectionOptions = {},
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
    options?: SelectionOptions,
    /** Pre-computed analysis from the caller — skips a second full analysis pass. */
    analysis?: AnalysisResult,
  ): Promise<RoutingCandidate[] | null> {
    if (signal?.aborted) return null
    const originalModel = (reqBody.model as string) || 'auto'
    const forcedModel = this._applyOverride(reqBody)

    // Conversation fast-path: running threads with a stable conversation id
    // reuse the previous routing decision without re-analyzing the body.
    const peeked = forcedModel ? null : this.peekCachedRouting(reqBody)
    if (peeked) {
      logger.debug({ model: peeked[0]?.modelName, node: peeked[0]?.nodeHost }, 'Conversation cache hit — reusing routing decision')
      return peeked
    }

    // Signal cache hit: cheap key (no text analysis), reuse previous routing
    // decision and skip full candidate enumeration and scoring.
    const signalHit = forcedModel ? null : this.peekSignalCache(reqBody)
    if (signalHit) {
      logger.debug({ model: signalHit[0]?.modelName, node: signalHit[0]?.nodeHost }, 'Signal cache hit — reusing routing decision')
      return signalHit
    }

    await this._performOnRequestScan()
    if (signal?.aborted) return null
    const finalAnalysis = analysis ?? this.analyzer.analyze(reqBody, 'chat')
    const model = (reqBody.model as string) || 'auto'
    logger.debug({ model, originalModel, forced: !!forcedModel, ...finalAnalysis }, 'Chat routing analysis')

    let result: RoutingCandidate[] | null
    try {
      result = await this._selectWithWolFallback(model, finalAnalysis, reqBody, signal, options)
    } catch (err: unknown) {
      if (forcedModel && (err as { code?: string })?.code === 'MODEL_NOT_FOUND') return null
      throw err
    }
    if (forcedModel) this._tagForced(result)

    // Cache successful routing for reuse by similar follow-up requests.
    if (result && result.length > 0 && !forcedModel) {
      this._routingCacheSet(this._cheapRoutingCacheKey(reqBody)!, result)
      const convKey = this._conversationCacheKey(reqBody)
      if (convKey) this._conversationCacheSet(convKey, result)
    }
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
    options?: SelectionOptions,
    /** Pre-computed analysis from the caller — skips a second full analysis pass. */
    analysis?: AnalysisResult,
  ): Promise<RoutingCandidate[] | null> {
    if (signal?.aborted) return null
    const originalModel = (reqBody.model as string) || 'auto'
    const forcedModel = this._applyOverride(reqBody)

    const peeked = forcedModel ? null : this.peekCachedRouting(reqBody)
    if (peeked) {
      logger.debug({ model: peeked[0]?.modelName, node: peeked[0]?.nodeHost }, 'Conversation cache hit — reusing routing decision')
      return peeked
    }

    const signalHit = forcedModel ? null : this.peekSignalCache(reqBody)
    if (signalHit) {
      logger.debug({ model: signalHit[0]?.modelName, node: signalHit[0]?.nodeHost }, 'Signal cache hit — reusing routing decision')
      return signalHit
    }

    await this._performOnRequestScan()
    if (signal?.aborted) return null
    const finalAnalysis = analysis ?? this.analyzer.analyze(reqBody, 'embeddings')
    const model = (reqBody.model as string) || 'auto'
    logger.debug({ model, originalModel, forced: !!forcedModel }, 'Embeddings routing analysis')

    const result = await this._selectWithWolFallback(model, finalAnalysis, reqBody, signal)
    if (forcedModel) this._tagForced(result)
    if (result && result.length > 0 && !forcedModel) {
      this._routingCacheSet(this._cheapRoutingCacheKey(reqBody)!, result)
      const convKey = this._conversationCacheKey(reqBody)
      if (convKey) this._conversationCacheSet(convKey, result)
    }
    return result
  }

  async selectForResponses(
    reqBody: Record<string, unknown>,
    signal?: AbortSignal,
    options?: SelectionOptions,
    /** Pre-computed analysis from the caller — skips a second full analysis pass. */
    analysis?: AnalysisResult,
  ): Promise<RoutingCandidate[] | null> {
    if (signal?.aborted) return null
    const originalModel = (reqBody.model as string) || 'auto'
    const forcedModel = this._applyOverride(reqBody)

    const peeked = forcedModel ? null : this.peekCachedRouting(reqBody)
    if (peeked) {
      logger.debug({ model: peeked[0]?.modelName, node: peeked[0]?.nodeHost }, 'Conversation cache hit — reusing routing decision')
      return peeked
    }

    const signalHit = forcedModel ? null : this.peekSignalCache(reqBody)
    if (signalHit) {
      logger.debug({ model: signalHit[0]?.modelName, node: signalHit[0]?.nodeHost }, 'Signal cache hit — reusing routing decision')
      return signalHit
    }

    await this._performOnRequestScan()
    if (signal?.aborted) return null
    const finalAnalysis = analysis ?? this.analyzer.analyze(reqBody, 'responses')
    const model = (reqBody.model as string) || 'auto'
    logger.debug({ model, originalModel, forced: !!forcedModel, ...finalAnalysis }, 'Responses routing analysis')

    const result = await this._selectWithWolFallback(model, finalAnalysis, reqBody, signal)
    if (forcedModel) this._tagForced(result)
    if (result && result.length > 0 && !forcedModel) {
      this._routingCacheSet(this._cheapRoutingCacheKey(reqBody)!, result)
      const convKey = this._conversationCacheKey(reqBody)
      if (convKey) this._conversationCacheSet(convKey, result)
    }
    return result
  }

  /**
   * /v1/audio/* routing: selects the best model with the capability the task
   * requires — `speech` for /v1/audio/speech, `audio` for transcription and
   * translation. Virtual aliases (auto-fast) and unknown model names both route
   * here and get rewritten to a concrete capable model by the caller.
   */
  async selectForAudio(
    taskType: 'speech' | 'transcription' | 'translation',
    reqBody: Record<string, unknown>,
    signal?: AbortSignal,
    /** Pre-computed analysis from the caller — skips a second full analysis pass. */
    analysis?: AnalysisResult,
  ): Promise<RoutingCandidate[] | null> {
    if (signal?.aborted) return null
    await this._performOnRequestScan()
    if (signal?.aborted) return null
    const requestedModel = (reqBody.model as string) || 'auto-fast'
    const finalAnalysis = analysis ?? this.analyzer.analyze(reqBody, 'audio')
    const capability = taskType === 'speech' ? 'speech' : 'audio'

    const nodes = this.discovery.getNodes()

    // Exact existing model name → direct hit on the node hosting it.
    for (const [nodeHost, node] of nodes) {
      if (!node.reachable) continue
      const modelInfo = node.models.get(requestedModel)
      if (!modelInfo) continue
      if (disabledModelsStore.isDisabled(nodeHost, requestedModel)) continue
      if (!this._modelHasCapability(modelInfo, capability, taskType)) continue
      return [{ nodeHost, modelName: requestedModel, modelInfo, score: 0 }]
    }

    // Virtual alias (or unknown) → best capable model, honouring reachability,
    // node load and the usual latency/TPS/warm scoring.
    const candidates: RoutingCandidate[] = []
    const pressure = cloudUsagePressure(cloudUsageStore.get())
    const audioProfile = TaskProfile.from(finalAnalysis, requestedModel)
    for (const [nodeHost, node] of nodes) {
      if (!node.reachable) continue
      if (!this.load.canAcceptRequest(nodeHost)) continue
      for (const [modelName, modelInfo] of node.models) {
        if (disabledModelsStore.isDisabled(nodeHost, modelName)) continue
        if (!this._modelHasCapability(modelInfo, capability, taskType)) continue
        candidates.push(this._buildCandidate(nodeHost, node, modelName, modelInfo, finalAnalysis, audioProfile, pressure))
      }
    }

    if (candidates.length === 0) {
      // No live audio-capable node — mirror the chat path: wake offline nodes
      // that host a capable model and poll for them to come back online.
      if (!this.discovery.tryWakeNodesForAudio(capability)) return null
      logger.info(
        { taskType, capability },
        'No live audio candidates — WoL triggered, waiting for node to wake',
      )
      const deadline = Date.now() + WOL_WAIT_TIMEOUT_MS
      while (Date.now() < deadline && candidates.length === 0) {
        if (signal?.aborted) return null
        await new Promise<void>((r) => setTimeout(r, WOL_POLL_INTERVAL_MS))
        if (signal?.aborted) return null
        for (const [nodeHost, node] of this.discovery.getNodes()) {
          if (!node.reachable) continue
          if (!this.load.canAcceptRequest(nodeHost)) continue
          for (const [modelName, modelInfo] of node.models) {
            if (disabledModelsStore.isDisabled(nodeHost, modelName)) continue
            if (!this._modelHasCapability(modelInfo, capability, taskType)) continue
            candidates.push(this._buildCandidate(nodeHost, node, modelName, modelInfo, finalAnalysis, audioProfile, pressure))
          }
        }
      }
      if (candidates.length === 0) {
        logger.warn(
          { taskType, capability },
          'WoL wait timed out — no audio-capable node came online',
        )
        return null
      }
      logger.info(
        { taskType, capability },
        'Audio node came online after WoL — routing request',
      )
    }
    candidates.sort((a, b) => b.score - a.score)
    annotateRanking(candidates)
    logger.debug(
      candidates.slice(0, 3).map((c) => ({
        model: c.modelName,
        node: c.nodeHost,
        score: Math.round(c.score * 10) / 10,
      })),
      'Top audio routing candidates',
    )
    return candidates
  }

  /** True when the model can serve the given audio task (speech vs audio). */
  private _modelHasCapability(
    modelInfo: ModelInfo,
    capability: string,
    taskType: 'speech' | 'transcription' | 'translation',
  ): boolean {
    const caps = [...(modelInfo.profile.capabilities ?? [])]
    if (caps.includes(capability)) return true
    // Transcription/translation consume audio input, so speech-capable
    // (LLM-asr style) models qualify for those tasks as well.
    if (taskType !== 'speech' && caps.includes('speech')) return true
    // The speech task needs a speech-generation model — an audio-input
    // (multimodal) model like gemma4 cannot synthesize speech and is rejected
    // upstream with a 400.
    return false
  }

  /**
   * Returns the minimum context_length across all models that are eligible
   * candidates for the given virtual alias.
   */
  private _minContextForAlias(alias: string): number {
    const nodes = this.discovery.getNodes()
    let min = Infinity
    for (const [, node] of nodes) {
      if (alias === 'auto-local' && node.cloud) continue
      for (const [, modelInfo] of node.models) {
        const { profile } = modelInfo
        if (profile.isEmbedding || profile.isSpeechSynthesis) continue
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
      // Include offline (sleeping) nodes — their known models are still
      // theoretically available and get woken via WoL before routing.
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

  /** Cache key from cheap, body-scanning-only signals — no full text analysis.
   *  Used to check the signal cache before running RequestAnalyzer, so a
   *  similar request can reuse the previous routing decision without
   *  re-scanning message text. Less discriminating than the full analysis key:
   *  two requests with the same cheap fields but very different text may
   *  collide and reuse a suboptimal (but still viable) model.
   */
  private _cheapRoutingCacheKey(reqBody: Record<string, unknown>): string | null {
    const model = String(reqBody.model || 'auto')
    const tools = Array.isArray(reqBody.tools) && (reqBody.tools as unknown[]).length > 0
    const messages = Array.isArray(reqBody.messages) ? (reqBody.messages as unknown[]) : []
    let needsVision = false
    let needsAudio = false
    let textLen = 0
    for (const msg of messages) {
      const content = (msg as Record<string, unknown> | null | undefined)?.content
      if (!content) continue
      if (typeof content === 'string') {
        textLen += content.length
        continue
      }
      if (Array.isArray(content)) {
        for (const part of content) {
          const p = part as Record<string, unknown> | null | undefined
          const type = p?.type
          if (type === 'image_url' || type === 'image') needsVision = true
          if (type === 'input_audio' || type === 'audio') needsAudio = true
          if (type === 'text' && typeof p?.text === 'string') textLen += p.text.length
          if (needsVision && needsAudio) break
        }
      }
      if (needsVision && needsAudio) break
    }
    const maxTokens = Number((reqBody.max_completion_tokens as number) ?? (reqBody.max_tokens as number)) || 0
    const maxTokensBucket = Math.floor(maxTokens / ROUTING_TOKEN_BUCKET) * ROUTING_TOKEN_BUCKET
    const sizeBucket = Math.floor(textLen / ROUTING_TOKEN_BUCKET) * ROUTING_TOKEN_BUCKET
    const messageCountBucket = Math.floor(messages.length / 10) * 10
    return [
      'sig', model, tools, needsVision, needsAudio, maxTokensBucket, sizeBucket, messageCountBucket,
    ].join('|')
  }

  /** Signal-cache peek: returns cached candidates for a similar request without
   *  running RequestAnalyzer. Returns null on miss. */
  peekSignalCache(reqBody: Record<string, unknown>): RoutingCandidate[] | null {
    const key = this._cheapRoutingCacheKey(reqBody)
    if (!key) return null
    const cached = this.#routingCache.get(key)
    if (!cached || Date.now() - cached.cachedAt > ROUTING_CACHE_TTL_MS) return null
    const top = cached.candidates[0]
    if (!top || !this._candidateStillViable(top)) return null
    return cached.candidates
  }

  private _routingCacheSet(key: string, candidates: RoutingCandidate[]): void {
    this.#routingCache.set(key, { candidates, cachedAt: Date.now() })
    if (this.#routingCache.size > ROUTING_CACHE_MAX) {
      const oldest = this.#routingCache.keys().next().value
      if (oldest !== undefined) this.#routingCache.delete(oldest)
    }
  }

  /** Returns true when the cached candidate is still reachable, available, and
   *  has capacity — otherwise the caller falls through to full routing. */
  private _candidateStillViable(candidate: RoutingCandidate): boolean {
    const node = this.discovery.getNodes().get(candidate.nodeHost)
    if (!node || !node.reachable) return false
    if (!node.models.has(candidate.modelName)) return false
    if (disabledModelsStore.isDisabled(candidate.nodeHost, candidate.modelName)) return false
    try {
      return this.load.canAcceptRequest(candidate.nodeHost)
    } catch {
      return false
    }
  }

  /**
   * Conversation fast-path: if the request carries a stable conversation id and
   * we previously routed a similar turn in that thread, return the cached
   * candidates without re-analyzing the request body or re-scoring candidates.
   * Returns null on miss, forcing full routing (which then repopulates the
   * cache for subsequent turns).
   *
   * shortcut: conversation content that changes model requirements mid-thread
   * (e.g. suddenly adding images or code) is not re-detected on a cache hit —
   * accepted because running threads rarely change model needs mid-conversation.
   */
  peekCachedRouting(reqBody: Record<string, unknown>): RoutingCandidate[] | null {
    const key = this._conversationCacheKey(reqBody)
    if (!key) return null
    const cached = this.#conversationCache.get(key)
    if (!cached || Date.now() - cached.cachedAt > ROUTING_CONV_TTL_MS) return null
    const top = cached.candidates[0]
    if (!top || !this._candidateStillViable(top)) return null
    return cached.candidates
  }

  private _conversationCacheKey(reqBody: Record<string, unknown>): string | null {
    const convId = extractConversationId(reqBody)
    if (!convId) return null
    const model = String(reqBody.model || 'auto')
    const { stream, maxTokensBucket, tools, messageCount, needsVision, needsAudio } =
      cheapSignals(reqBody)
    return [
      'conv', convId, model, stream, maxTokensBucket, tools, messageCount,
      needsVision, needsAudio,
    ].join('|')
  }

  private _conversationCacheSet(key: string, candidates: RoutingCandidate[]): void {
    this.#conversationCache.set(key, { candidates, cachedAt: Date.now() })
    if (this.#conversationCache.size > ROUTING_CACHE_MAX) {
      const oldest = this.#conversationCache.keys().next().value
      if (oldest !== undefined) this.#conversationCache.delete(oldest)
    }
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
    options: SelectionOptions = {},
  ): RoutingCandidate[] | null {
    const isVirtual = VIRTUAL_MODELS.has(model)
    if (isVirtual) {
      return this._selectVirtual(model, analysis, { ...options, maxCriteria: maxChoiceCriteria(reqBody) })
    }
    try {
      return this._selectConcrete(model, { ...options, maxCriteria: maxChoiceCriteria(reqBody) })
    } catch (err) {
      const routerErr = err as RouterError
      if (routerErr.code === 'MODEL_NOT_FOUND' && ROUTER_FALLBACK_TO_AUTO) {
        logger.warn(
          { model },
          'Model not found — falling back to auto routing',
        )
        return this._selectVirtual('auto', analysis, { ...options, maxCriteria: maxChoiceCriteria(reqBody) })
      }
      throw err
    }
  }

  private _selectVirtual(
    alias: string,
    analysis: AnalysisResult,
    options: SelectionOptions = {},
  ): RoutingCandidate[] | null {
    const nodes = this.discovery.getNodes()
    const candidates: RoutingCandidate[] = []
    const pressure = cloudUsagePressure(cloudUsageStore.get())
    const profile = TaskProfile.from(analysis, alias)
    const { decisionOnly = false, maxCriteria = 0 } = options

    for (const [nodeHost, node] of nodes) {
      if (!node.reachable) continue
      if (alias === 'auto-local' && node.cloud) continue
      if (!this.load.canAcceptRequest(nodeHost)) continue

      for (const [modelName, modelInfo] of node.models) {
        if (disabledModelsStore.isDisabled(nodeHost, modelName)) continue
        const { profile: caps } = modelInfo
        if (decisionOnly) {
          if (!caps.supportsDecision) continue
          // Skip decision models whose learned criteria cap can't fit this
          // request (e.g. nimble caps at 26) — they would 400 upstream.
          if (maxCriteria > 0 && modelInfo.systemoneMaxCriteria > 0 && maxCriteria > modelInfo.systemoneMaxCriteria) continue
        } else if (caps.supportsDecision) {
          continue
        }
        if (analysis.needsEmbeddings) {
          if (!caps.isEmbedding) continue
        } else {
          // Embedding and speech-synthesis models never serve text chat.
          if (caps.isEmbedding || caps.isSpeechSynthesis) continue
        }
        if (analysis.needsTools && !caps.supportsTools) continue
        if (analysis.needsVision && !caps.supportsVision) continue
        if (analysis.needsAudio && !caps.supportsAudio) continue
        if (alias === 'auto-think' && !caps.supportsThinking) continue
        if (!fitsContext(caps.contextLength, analysis)) continue
        candidates.push(this._buildCandidate(nodeHost, node, modelName, modelInfo, analysis, profile, pressure))
      }
    }

    if (candidates.length === 0) return null
    candidates.sort((a, b) => b.score - a.score)
    annotateRanking(candidates)
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
    options: SelectionOptions = {},
  ): RoutingCandidate[] | null {
    const nodes = this.discovery.getNodes()
    const candidates: RoutingCandidate[] = []
    const pressure = cloudUsagePressure(cloudUsageStore.get())
    // A concrete model is fixed, so only node-level factors (speed, load, warmth,
    // cloud) separate the candidates; rank them under a neutral chat profile.
    const profile = TaskProfile.from(NEUTRAL_ANALYSIS, 'auto')
    const { decisionOnly = false, maxCriteria = 0 } = options
    // True when a chat/responses request explicitly named a decision model —
    // those are rejected with MODEL_NOT_DECISION instead of silently finding no candidate.
    let namedDecisionModel = false

    for (const [nodeHost, node] of nodes) {
      if (!node.reachable) continue
      if (!this.load.canAcceptRequest(nodeHost)) continue
      const modelInfo = node.models.get(model)
      if (!modelInfo) continue
      if (disabledModelsStore.isDisabled(nodeHost, model)) continue
      if (decisionOnly) {
        if (!modelInfo.profile.supportsDecision) continue
        if (maxCriteria > 0 && modelInfo.systemoneMaxCriteria > 0 && maxCriteria > modelInfo.systemoneMaxCriteria) continue
      } else if (modelInfo.profile.supportsDecision) {
        namedDecisionModel = true
        continue
      }
      candidates.push(this._buildCandidate(nodeHost, node, model, modelInfo, NEUTRAL_ANALYSIS, profile, pressure))
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
      if (namedDecisionModel) {
        const err = Object.assign(
          new Error(
            `Model ${model} is a decision model — decision requests must use /v1/systemone`,
          ),
          { statusCode: 400, code: 'MODEL_NOT_DECISION' },
        ) as RouterError
        throw err
      }
      return null
    }

    candidates.sort((a, b) => b.score - a.score)
    annotateRanking(candidates)
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

  /** Single scoring entry point: every candidate list is built through here. */
  private _buildCandidate(
    nodeHost: string,
    node: NodeInfo,
    modelName: string,
    modelInfo: ModelInfo,
    analysis: AnalysisResult,
    profile: TaskProfile,
    pressure: number,
  ): RoutingCandidate {
    const rationale = scoreCandidate({
      modelInfo,
      profile,
      analysis,
      isCloud: node.cloud,
      utilization: this.load.getUtilization(nodeHost),
      warm: computeWarmSignal(modelInfo, node.models, node.cloud),
      eviction: computeEvictionSignal(
        modelInfo,
        node.models,
        node.loaded,
        this.discovery.getNodeMemory(nodeHost).bytes,
        node.cloud,
        Date.now(),
        this.discovery.getNodeLoadedLimit(nodeHost) ?? Infinity,
      ),
      cloudUsagePressure: pressure,
    })
    return { nodeHost, modelName, modelInfo, score: rationale.total, rationale }
  }
}
