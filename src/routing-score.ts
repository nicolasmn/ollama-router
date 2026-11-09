// routing-score.ts - Explainable candidate scoring for virtual model aliases.
//
// Every candidate is scored as a sum of independent factors:
//
//     points(factor) = value(−1..1) × weight(profile)
//     total          = Σ points                      (positive weights sum to 100)
//
// Factors are normalized *before* weighting, so the numbers shown in the
// dashboard are exactly the numbers that decided the routing — nothing else
// is added on the side. Unmeasured models are scored from a size-based prior
// (never a free full-marks default) and blended with real measurements as
// samples accumulate.

import type { AnalysisResult } from './request-analyzer.js'
import type { LoadedState, ModelInfo } from './models.js'
import type { CloudUsage } from './cloud-usage.js'

export type ProfileKind = 'fast' | 'chat' | 'complex' | 'reasoning'

export type FactorId =
  | 'quality'
  | 'latency'
  | 'throughput'
  | 'context'
  | 'warm'
  | 'eviction'
  | 'thinking'
  | 'load'
  | 'reliability'
  | 'cloudCost'
  | 'cloudUsage'

/** Where a factor's input came from. */
export type EvidenceSource = 'measured' | 'blended' | 'estimated' | 'live' | 'static'

export type FactorWeights = Readonly<Record<FactorId, number>>

export interface ScoreFactor {
  id: FactorId
  label: string
  /** Normalized value, −1..1 (penalties are negative). */
  value: number
  /** Maximum points this factor can contribute under the active profile. */
  weight: number
  /** value × weight — the exact contribution to the total. */
  points: number
  source: EvidenceSource
  /** Human-readable evidence with the real figures behind `value`. */
  detail: string
}

export interface ProfileSummary {
  kind: ProfileKind
  /** Capability the task demands of a model, 0..1. */
  demand: number
  /** Why this profile was chosen, e.g. "alias auto-fast". */
  reason: string
  tags: string[]
  weights: FactorWeights
}

/** How this candidate compares with the best (or, for the winner, second-best) one. */
export interface RankingInfo {
  rank: number
  of: number
  /** Winner: lead over runner-up (≥ 0). Others: deficit to winner (< 0). */
  gap: number
  /** Label of the candidate the gap refers to. */
  against: string
  /** Factor responsible for most of the gap, from this candidate's perspective. */
  decisive: FactorId | null
  decisiveDelta: number
}

export interface ScoreBreakdown {
  profile: ProfileSummary
  factors: ScoreFactor[]
  total: number
  ranking?: RankingInfo
}

export interface WarmSignal {
  /** −1 (switch cost) .. 1 (hot in VRAM). */
  value: number
  detail: string
}

export interface EvictionSignal {
  /** −1 (would evict a hot model / cannot fit) .. 0 (free to load). */
  value: number
  detail: string
}

export interface ScoreInput {
  modelInfo: ModelInfo
  profile: TaskProfile
  analysis: AnalysisResult
  isCloud: boolean
  /** Node utilization, 0..1. */
  utilization: number
  warm: WarmSignal
  eviction: EvictionSignal
  /** Cloud quota pressure, 0..1 (see cloudUsagePressure). */
  cloudUsagePressure: number
}

// ─── Constants ──────────────────────────────────────────────────────

const PENALTY_WEIGHTS = {
  load: 15,
  reliability: 15,
  cloudCost: 8,
  cloudUsage: 20,
  eviction: 20,
} as const

const PROFILE_WEIGHTS: Readonly<Record<ProfileKind, FactorWeights>> = {
  fast: { quality: 15, latency: 40, throughput: 30, context: 5, warm: 10, thinking: 6, ...PENALTY_WEIGHTS },
  chat: { quality: 35, latency: 30, throughput: 20, context: 5, warm: 10, thinking: 0, ...PENALTY_WEIGHTS },
  complex: { quality: 50, latency: 20, throughput: 15, context: 5, warm: 10, thinking: 4, ...PENALTY_WEIGHTS },
  reasoning: { quality: 60, latency: 10, throughput: 15, context: 5, warm: 10, thinking: 10, ...PENALTY_WEIGHTS },
}

const PROFILE_DEMAND: Readonly<Record<ProfileKind, number>> = {
  fast: 0.25,
  chat: 0.5,
  complex: 0.7,
  reasoning: 0.85,
}

/** Parameter count assumed for models that do not report one. */
const DEFAULT_PARAMS_B = 8
/** Parameter count (billions) that maps to capacity 1.0. */
const CAPACITY_CEILING_B = 64
/** Capability every model has regardless of size. */
const BASELINE_CAPACITY = 0.15
const THINKING_CAPACITY_BUMP = 0.1

/** Measured samples needed before a measurement outweighs the prior 50/50. */
const PRIOR_STRENGTH = 3
/** TTFT at which the latency factor is 0.5. */
const TTFT_HALF_MS = 1500
/** Throughput (tok/s) at which the throughput factor is 0.5. */
const TPS_HALF = 40

const MIN_SAMPLES_FOR_RELIABILITY = 3
const LONG_CONTEXT_TOKENS = 12_000
const COMPLEX_INPUT_TOKENS = 3_000
const DEFAULT_OUTPUT_TOKENS = 1_024

const WARM_RECENT_MS = 2 * 60 * 1000
const WARM_ACTIVE_MS = 5 * 60 * 1000
const WARM_INACTIVE_MS = 10 * 60 * 1000
const MODEL_SWITCH_VALUE = -0.6

/** Safety factor on disk size when a model has never been seen loaded: the
 *  in-memory footprint also holds the KV cache. */
export const FOOTPRINT_DISK_FACTOR = 1.3
/** Ollama's default keep_alive; used to infer last use from /api/ps expires_at. */
export const DEFAULT_KEEP_ALIVE_MS = 5 * 60 * 1000
const GB = 1024 ** 3

export const NEUTRAL_ANALYSIS: AnalysisResult = {
  endpointType: 'chat',
  needsEmbeddings: false,
  needsVision: false,
  needsAudio: false,
  needsTools: false,
  estimatedInputTokens: 0,
  maxOutputTokens: 0,
  isStreaming: false,
  preferReasoning: false,
  preferFast: false,
  hasCodeSignals: false,
  messageCount: 0,
}

// ─── Task profile ───────────────────────────────────────────────────

export class TaskProfile {
  readonly kind: ProfileKind
  readonly demand: number
  readonly reason: string
  readonly tags: readonly string[]
  readonly weights: FactorWeights

  private constructor(
    kind: ProfileKind,
    reason: string,
    tags: readonly string[],
    weights: FactorWeights,
  ) {
    this.kind = kind
    this.demand = PROFILE_DEMAND[kind]
    this.reason = reason
    this.tags = tags
    this.weights = weights
  }

  /** Derives the profile from the request content and the requested alias. */
  static from(analysis: AnalysisResult, alias: string): TaskProfile {
    const tokens = analysis.estimatedInputTokens || 0
    const turns = analysis.messageCount || 0

    let kind: ProfileKind
    let reason: string
    if (alias === 'auto-fast') {
      kind = 'fast'
      reason = 'alias auto-fast'
    } else if (analysis.preferReasoning) {
      kind = 'reasoning'
      reason = analysis.hasCodeSignals ? 'code / analytical content' : 'analytical content'
    } else if (analysis.hasCodeSignals || turns > 10 || tokens > COMPLEX_INPUT_TOKENS) {
      kind = 'complex'
      reason = analysis.hasCodeSignals
        ? 'code content'
        : turns > 10
          ? `long conversation (${turns} messages)`
          : `large prompt (~${formatTokens(tokens)} tokens)`
    } else if (analysis.preferFast) {
      kind = 'fast'
      reason = 'short, simple prompt'
    } else {
      kind = 'chat'
      reason = 'general chat'
    }

    const tags: string[] = []
    if (analysis.needsVision) tags.push('vision')
    if (analysis.needsAudio) tags.push('audio')
    if (analysis.needsTools) tags.push('tools')
    if (analysis.hasCodeSignals) tags.push('code')
    if (tokens > LONG_CONTEXT_TOKENS) tags.push('long-context')
    if (turns > 10) tags.push('multi-turn')

    // auto-think already filters to thinking-capable models, so the factor
    // cannot discriminate between candidates.
    const base = PROFILE_WEIGHTS[kind]
    const weights: FactorWeights = alias === 'auto-think' ? { ...base, thinking: 0 } : base
    return new TaskProfile(kind, reason, tags, weights)
  }

  toSummary(): ProfileSummary {
    return {
      kind: this.kind,
      demand: this.demand,
      reason: this.reason,
      tags: [...this.tags],
      weights: this.weights,
    }
  }
}

// ─── Filters (run before scoring) ───────────────────────────────────

/** True when the prompt fits the model's context window at all. */
export function fitsContext(contextLength: number, analysis: AnalysisResult): boolean {
  if (contextLength <= 0) return true
  return (analysis.estimatedInputTokens || 0) <= contextLength
}

// ─── Signals ────────────────────────────────────────────────────────

export function cloudUsagePressure(usage: CloudUsage | null): number {
  if (!usage || usage.stale || usage.fetchedAt === 0) return 0
  const pct = Math.max(usage.sessionPct, usage.weeklyPct)
  if (pct < 70) return 0
  return clamp01((pct - 70) / 30)
}

export function computeWarmSignal(
  model: ModelInfo,
  nodeModels: Map<string, ModelInfo>,
  isCloud: boolean,
  now: number = Date.now(),
): WarmSignal {
  if (isCloud) return { value: 0, detail: 'cloud node manages model loading itself' }

  let mostRecent: ModelInfo | null = null
  let mostRecentAt = 0
  for (const m of nodeModels.values()) {
    if (m.lastRoutedAt > mostRecentAt) {
      mostRecentAt = m.lastRoutedAt
      mostRecent = m
    }
  }
  if (mostRecent === null) return { value: 0, detail: 'no routing history on this node' }

  const age = now - mostRecentAt
  if (mostRecent === model) {
    if (age < WARM_RECENT_MS) return { value: 1, detail: `most recent model on this node (${formatAge(age)} ago)` }
    if (age < WARM_ACTIVE_MS) return { value: 0.5, detail: `most recent model on this node (${formatAge(age)} ago)` }
    if (age < WARM_INACTIVE_MS) return { value: 0.2, detail: `last used ${formatAge(age)} ago` }
    return { value: 0, detail: `idle for ${formatAge(age)}` }
  }
  if (age < WARM_ACTIVE_MS) {
    return { value: MODEL_SWITCH_VALUE, detail: `node served ${mostRecent.name} ${formatAge(age)} ago — switching reloads` }
  }
  return { value: 0, detail: 'no model is currently hot on this node' }
}

/** In-memory bytes a model will need: measured via /api/ps once seen loaded, else disk size × safety factor. */
export function estimateFootprint(model: ModelInfo): { bytes: number; measured: boolean } {
  if (model.measuredFootprint > 0) return { bytes: model.measuredFootprint, measured: true }
  return { bytes: model.size * FOOTPRINT_DISK_FACTOR, measured: false }
}

/**
 * Penalizes loading a cold model that does not fit next to the models already
 * resident on the node — either because free memory (configured or learned
 * capacity minus the loaded models' sizes) is too small, or because the node
 * already holds `loadedLimit` models. Ollama unloads the first idle runner
 * ordered by keep-alive duration, not by recency, so any idle loaded model may
 * go: the penalty follows the most recently used loaded model — protected
 * inside the recent window, fading to 0 once everything has been idle.
 * `loadedLimit` defaults to "no limit" for callers that do not know it.
 */
export function computeEvictionSignal(
  model: ModelInfo,
  nodeModels: Map<string, ModelInfo>,
  loaded: LoadedState | null,
  capacityBytes: number | null,
  isCloud: boolean,
  now: number = Date.now(),
  loadedLimit: number = Infinity,
): EvictionSignal {
  if (isCloud) return { value: 0, detail: 'cloud node manages model loading itself' }
  if (loaded === null) return { value: 0, detail: 'loaded models unknown' }
  if (loaded.models.some((m) => m.name === model.name)) return { value: 0, detail: 'already loaded on this node' }

  const footprint = estimateFootprint(model)
  const need = `${formatGb(footprint.bytes)} GB${footprint.measured ? '' : ' (estimated)'}`
  const known = capacityBytes !== null && capacityBytes > 0
  if (known && footprint.bytes > capacityBytes) {
    return { value: -1, detail: `needs ${need} — more than the node's ${formatGb(capacityBytes)} GB` }
  }

  const used = loaded.models.reduce((sum, m) => sum + m.size, 0)
  const free = known ? Math.max(0, capacityBytes - used) : Infinity
  const tooBig = footprint.bytes > free
  const atLimit = loaded.models.length >= loadedLimit
  if (!tooBig && !atLimit) {
    return {
      value: 0,
      detail: known
        ? `needs ${need}, ${formatGb(free)} GB free — fits alongside loaded models`
        : 'node memory unknown and below the loaded-model limit',
    }
  }
  const reasons: string[] = []
  if (tooBig) reasons.push(`only ${formatGb(free)} GB free`)
  if (atLimit) reasons.push(`already holds ${loaded.models.length} of max ${loadedLimit} models`)

  let atRisk = { name: '', lastUsed: 0 }
  for (const m of loaded.models) {
    const lastUsed = lastUsedAt(m.name, m.expiresAt, nodeModels, now)
    if (atRisk.name === '' || lastUsed > atRisk.lastUsed) atRisk = { name: m.name, lastUsed }
  }

  const age = now - atRisk.lastUsed
  const protection =
    age <= WARM_RECENT_MS ? 1 : age >= WARM_INACTIVE_MS ? 0 : 1 - (age - WARM_RECENT_MS) / (WARM_INACTIVE_MS - WARM_RECENT_MS)
  const recency = atRisk.lastUsed > 0 ? `last used ${formatAge(age)} ago` : 'no recent use'
  return {
    value: -protection,
    detail: `needs ${need}, ${reasons.join(' and ')} — Ollama may unload any idle model, incl. ${atRisk.name} (${recency})`,
  }
}

/** Epoch ms a loaded model was last used: router history first, else inferred from /api/ps expiry; 0 = unknown. */
function lastUsedAt(
  name: string,
  expiresAt: number,
  nodeModels: Map<string, ModelInfo>,
  now: number,
): number {
  const routed = nodeModels.get(name)?.lastRoutedAt ?? 0
  if (routed > 0) return routed
  return expiresAt > 0 ? Math.min(now, expiresAt - DEFAULT_KEEP_ALIVE_MS) : 0
}

// ─── Scoring ────────────────────────────────────────────────────────

export function scoreCandidate(input: ScoreInput): ScoreBreakdown {
  const { modelInfo, profile, analysis, isCloud, utilization, warm, eviction, cloudUsagePressure: usage } = input
  const w = profile.weights
  const factors: ScoreFactor[] = [
    qualityFactor(modelInfo, profile, w.quality),
    latencyFactor(modelInfo, isCloud, w.latency),
    throughputFactor(modelInfo, isCloud, w.throughput),
    contextFactor(modelInfo, analysis, w.context),
    makeFactor('warm', 'Warm model', warm.value, w.warm, 'live', warm.detail),
    makeFactor('eviction', 'Eviction cost', eviction.value, w.eviction, 'live', eviction.detail),
    thinkingFactor(modelInfo, profile, w.thinking),
    makeFactor(
      'load', 'Node load', -clamp01(utilization), w.load, 'live',
      utilization > 0 ? `${Math.round(utilization * 100)}% of node slots busy` : 'node idle',
    ),
    reliabilityFactor(modelInfo, w.reliability),
    makeFactor(
      'cloudCost', 'Cloud preference', isCloud ? -1 : 0, w.cloudCost, 'static',
      isCloud ? 'local nodes are preferred in near-ties' : 'local node',
    ),
    makeFactor(
      'cloudUsage', 'Cloud quota', isCloud ? -usage : 0, w.cloudUsage, 'live',
      isCloud
        ? usage > 0 ? `quota pressure ${Math.round(usage * 100)}% (ramps from 70% usage)` : 'quota comfortable'
        : 'local node',
    ),
  ]
  const total = round(factors.reduce((sum, f) => sum + f.value * f.weight, 0), 2)
  return { profile: profile.toSummary(), factors, total }
}

/**
 * Annotates each candidate with its rank and what separated it from the
 * winner (or, for the winner, from the runner-up). `sorted` must already be
 * ordered best-first.
 */
export function annotateRanking<
  T extends { modelName: string; nodeHost: string; score: number; rationale?: ScoreBreakdown },
>(sorted: readonly T[]): void {
  if (sorted.length === 0) return
  const labels = disambiguate(sorted)
  sorted.forEach((candidate, index) => {
    const { rationale } = candidate
    if (!rationale) return
    const other = index === 0 ? sorted[1] : sorted[0]
    if (!other?.rationale) {
      rationale.ranking = { rank: index + 1, of: sorted.length, gap: 0, against: '', decisive: null, decisiveDelta: 0 }
      return
    }
    let decisive: FactorId | null = null
    let decisiveDelta = 0
    for (const factor of rationale.factors) {
      const counterpart = other.rationale.factors.find((f) => f.id === factor.id)
      const delta = factor.points - (counterpart?.points ?? 0)
      // Winner: largest advantage. Others: largest disadvantage.
      const better = index === 0 ? delta > decisiveDelta : delta < decisiveDelta
      if (better) {
        decisive = factor.id
        decisiveDelta = delta
      }
    }
    rationale.ranking = {
      rank: index + 1,
      of: sorted.length,
      gap: round(candidate.score - other.score, 2),
      against: labels[index === 0 ? 1 : 0],
      decisive,
      decisiveDelta: round(decisiveDelta, 2),
    }
  })
}

// ─── Factors ────────────────────────────────────────────────────────

function qualityFactor(modelInfo: ModelInfo, profile: TaskProfile, weight: number): ScoreFactor {
  const { profile: model } = modelInfo
  const params = model.parameters || 0
  const known = params > 0
  const capacity = capacityFromParams(params)
  const bump =
    model.supportsThinking && (profile.kind === 'reasoning' || profile.kind === 'complex')
      ? THINKING_CAPACITY_BUMP
      : 0
  const effective = capacity + BASELINE_CAPACITY + bump
  // Sufficiency, not "bigger is better": a model that covers the demand earns
  // full marks and any extra size must pay for itself through speed.
  const value = Math.min(1, effective / profile.demand)
  const size = known ? `${formatParams(params)}B` : 'size unknown'
  const verdict = value >= 1 ? 'sufficient' : `covers ${Math.round(value * 100)}% of demand`
  return makeFactor(
    'quality', 'Capability', value, weight, known ? 'static' : 'estimated',
    `${size} · capacity ${effective.toFixed(2)} vs ${profile.kind} demand ${profile.demand.toFixed(2)} → ${verdict}`,
  )
}

function latencyFactor(modelInfo: ModelInfo, isCloud: boolean, weight: number): ScoreFactor {
  const params = modelInfo.profile.parameters || 0
  const prior = isCloud ? 900 : 400 + 70 * (params > 0 ? params : DEFAULT_PARAMS_B)
  const est = blend(modelInfo.recentTtft, modelInfo.totalRequests, prior)
  const value = 1 / (1 + est.value / TTFT_HALF_MS)
  const basis = params > 0 && !isCloud ? `${formatParams(params)}B size` : isCloud ? 'cloud node' : 'default size'
  let detail: string
  if (est.source === 'estimated') detail = `TTFT ≈ ${formatMs(prior)} · not measured yet, estimated from ${basis}`
  else if (est.source === 'blended') {
    detail = `TTFT ${formatMs(est.value)} · ${est.samples} req measured (${formatMs(modelInfo.recentTtft)}) blended with ${formatMs(prior)} estimate`
  } else detail = `TTFT ${formatMs(est.value)} · measured over ${est.samples} req`
  return makeFactor('latency', 'First token', value, weight, est.source, detail)
}

function throughputFactor(modelInfo: ModelInfo, isCloud: boolean, weight: number): ScoreFactor {
  const params = modelInfo.profile.parameters || 0
  const prior = isCloud ? 60 : 150 / Math.sqrt(params > 0 ? params : DEFAULT_PARAMS_B)
  const est = blend(modelInfo.recentTps, modelInfo.totalRequests, prior)
  const value = est.value / (est.value + TPS_HALF)
  const basis = params > 0 && !isCloud ? `${formatParams(params)}B size` : isCloud ? 'cloud node' : 'default size'
  let detail: string
  if (est.source === 'estimated') detail = `${prior.toFixed(0)} tok/s · not measured yet, estimated from ${basis}`
  else if (est.source === 'blended') {
    detail = `${est.value.toFixed(0)} tok/s · ${est.samples} req measured (${modelInfo.recentTps.toFixed(0)}) blended with ${prior.toFixed(0)} estimate`
  } else detail = `${est.value.toFixed(0)} tok/s · measured over ${est.samples} req`
  return makeFactor('throughput', 'Throughput', value, weight, est.source, detail)
}

function contextFactor(modelInfo: ModelInfo, analysis: AnalysisResult, weight: number): ScoreFactor {
  const contextLength = modelInfo.profile.contextLength || 0
  const need = (analysis.estimatedInputTokens || 0) + (analysis.maxOutputTokens || DEFAULT_OUTPUT_TOKENS)
  // 0 at "just fits", 1 at 2× headroom.
  const value = contextLength > 0 ? clamp01(contextLength / need - 1) : 0
  return makeFactor(
    'context', 'Context headroom', value, weight, 'static',
    contextLength > 0
      ? `window ${formatTokens(contextLength)} · request needs ~${formatTokens(need)}`
      : 'context window unknown',
  )
}

function thinkingFactor(modelInfo: ModelInfo, profile: TaskProfile, weight: number): ScoreFactor {
  const thinks = modelInfo.profile.supportsThinking
  // Thinking models spend hidden tokens before the first answer token: good
  // for hard tasks, a handicap when the goal is a fast reply.
  const sign = profile.kind === 'fast' ? -1 : 1
  const value = thinks ? sign : 0
  let detail = 'no thinking mode'
  if (thinks) detail = sign < 0 ? 'thinks before answering — slower for quick replies' : 'thinking mode helps on this task'
  return makeFactor('thinking', 'Thinking', value, weight, 'static', detail)
}

function reliabilityFactor(modelInfo: ModelInfo, weight: number): ScoreFactor {
  const { failures, totalRequests } = modelInfo
  if (totalRequests < MIN_SAMPLES_FOR_RELIABILITY) {
    return makeFactor('reliability', 'Reliability', 0, weight, 'estimated', `only ${totalRequests} request(s) so far`)
  }
  const rate = failures / totalRequests
  return makeFactor(
    'reliability', 'Reliability', -Math.min(1, rate * 2), weight, 'measured',
    `${failures}/${totalRequests} requests failed (${Math.round(rate * 100)}%)`,
  )
}

// ─── Helpers ────────────────────────────────────────────────────────

function makeFactor(
  id: FactorId,
  label: string,
  value: number,
  weight: number,
  source: EvidenceSource,
  detail: string,
): ScoreFactor {
  return {
    id,
    label,
    value: round(value, 3),
    weight,
    points: round(value * weight, 2),
    source,
    detail,
  }
}

interface Estimate {
  value: number
  samples: number
  source: Extract<EvidenceSource, 'measured' | 'blended' | 'estimated'>
}

/** Shrinks a measurement toward its prior until enough samples have accumulated. */
function blend(measured: number, totalRequests: number, prior: number): Estimate {
  if (!(measured > 0)) return { value: prior, samples: 0, source: 'estimated' }
  const samples = Math.max(1, totalRequests)
  const confidence = samples / (samples + PRIOR_STRENGTH)
  return {
    value: confidence * measured + (1 - confidence) * prior,
    samples,
    source: confidence >= 0.75 ? 'measured' : 'blended',
  }
}

function capacityFromParams(params: number): number {
  if (!(params > 0)) return 0.5
  return clamp01(Math.log2(params) / Math.log2(CAPACITY_CEILING_B))
}

function disambiguate(
  sorted: readonly { modelName: string; nodeHost: string }[],
): string[] {
  const counts = new Map<string, number>()
  for (const c of sorted) counts.set(c.modelName, (counts.get(c.modelName) ?? 0) + 1)
  return sorted.map((c) => {
    if ((counts.get(c.modelName) ?? 0) < 2) return c.modelName
    return `${c.modelName} @ ${c.nodeHost.replace(/^https?:\/\//, '')}`
  })
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n))
}

function round(n: number, digits: number): number {
  const f = 10 ** digits
  return Math.round(n * f) / f
}

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`
}

function formatAge(ms: number): string {
  const s = ms / 1000
  return s < 60 ? `${Math.round(s)} s` : `${Math.round(s / 60)} min`
}

function formatGb(bytes: number): string {
  return (bytes / GB).toFixed(1)
}

function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n))
  return n >= 10_000 ? `${Math.round(n / 1000)}k` : `${(n / 1000).toFixed(1)}k`
}

function formatParams(params: number): string {
  return params >= 10 ? params.toFixed(0) : params.toFixed(1)
}
