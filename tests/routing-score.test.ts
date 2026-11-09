import { describe, it, expect } from '@jest/globals'
import {
  TaskProfile,
  NEUTRAL_ANALYSIS,
  FOOTPRINT_DISK_FACTOR,
  fitsContext,
  annotateRanking,
  estimateFootprint,
  computeEvictionSignal,
  scoreCandidate,
} from '../src/routing-score.js'
import type { ScoreBreakdown } from '../src/routing-score.js'
import { ModelInfo, ModelProfile } from '../src/models.js'
import type { LoadedState } from '../src/models.js'

const POSITIVE_FACTORS = ['quality', 'latency', 'throughput', 'context', 'warm', 'thinking'] as const

describe('TaskProfile', () => {
  it('maps auto-fast to the fast profile', () => {
    expect(TaskProfile.from(NEUTRAL_ANALYSIS, 'auto-fast').kind).toBe('fast')
  })

  it('maps code content to complex and reasoning preference to reasoning', () => {
    expect(TaskProfile.from({ ...NEUTRAL_ANALYSIS, hasCodeSignals: true }, 'auto').kind).toBe('complex')
    expect(TaskProfile.from({ ...NEUTRAL_ANALYSIS, preferReasoning: true }, 'auto').kind).toBe('reasoning')
  })

  it('uses chat for neutral requests', () => {
    expect(TaskProfile.from(NEUTRAL_ANALYSIS, 'auto').kind).toBe('chat')
  })

  it('keeps positive weights at 100 for every profile', () => {
    const analyses = [
      TaskProfile.from(NEUTRAL_ANALYSIS, 'auto-fast'),
      TaskProfile.from(NEUTRAL_ANALYSIS, 'auto'),
      TaskProfile.from({ ...NEUTRAL_ANALYSIS, hasCodeSignals: true }, 'auto'),
      TaskProfile.from({ ...NEUTRAL_ANALYSIS, preferReasoning: true }, 'auto'),
    ]
    for (const p of analyses) {
      const w = p.weights as unknown as Record<string, number>
      const sum = POSITIVE_FACTORS.filter((f) => f !== 'thinking').reduce((s, f) => s + Math.abs(w[f] ?? 0), 0)
      expect(sum).toBe(100)
    }
  })

  it('zeroes the thinking weight for auto-think', () => {
    const p = TaskProfile.from(NEUTRAL_ANALYSIS, 'auto-think')
    expect((p.weights as unknown as Record<string, number>).thinking).toBe(0)
  })
})

describe('fitsContext', () => {
  it('rejects prompts larger than the context window', () => {
    expect(fitsContext(4096, { ...NEUTRAL_ANALYSIS, estimatedInputTokens: 8000 })).toBe(false)
    expect(fitsContext(8192, { ...NEUTRAL_ANALYSIS, estimatedInputTokens: 8000 })).toBe(true)
  })

  it('treats unknown context length as fitting', () => {
    expect(fitsContext(0, { ...NEUTRAL_ANALYSIS, estimatedInputTokens: 8000 })).toBe(true)
  })
})

describe('annotateRanking', () => {
  const breakdown = (total: number, latencyPts: number): ScoreBreakdown => ({
    profile: TaskProfile.from(NEUTRAL_ANALYSIS, 'auto').toSummary(),
    factors: [
      { id: 'latency', label: 'Latency', value: 0, weight: 30, points: latencyPts, source: 'measured', detail: '' },
      { id: 'quality', label: 'Quality', value: 0, weight: 35, points: total - latencyPts, source: 'estimated', detail: '' },
    ],
    total,
  })

  it('records rank, gap and the decisive factor', () => {
    const candidates = [
      { modelName: 'a', nodeHost: 'h1', score: 70, rationale: breakdown(70, 30) },
      { modelName: 'b', nodeHost: 'h1', score: 60, rationale: breakdown(60, 10) },
    ] as any[]
    annotateRanking(candidates)
    expect(candidates[0].rationale.ranking.rank).toBe(1)
    expect(candidates[1].rationale.ranking.rank).toBe(2)
    expect(Math.abs(candidates[1].rationale.ranking.gap)).toBeCloseTo(10)
    expect(candidates[0].rationale.ranking.decisive).toBe('latency')
  })
})

// ─── Eviction-aware scoring ─────────────────────────────────────────

const GB = 1024 ** 3
const NOW = 1_700_000_000_000

function model(name: string, diskGb: number, extra: Partial<ModelInfo> = {}): ModelInfo {
  const info = new ModelInfo(name, 'test', diskGb * GB, new ModelProfile({ parameters: 8, contextLength: 32_000 }))
  return Object.assign(info, extra)
}

function nodeWith(...models: ModelInfo[]): Map<string, ModelInfo> {
  return new Map(models.map((m) => [m.name, m]))
}

function loadedState(...entries: Array<[string, number, number?]>): LoadedState {
  return {
    updatedAt: NOW,
    models: entries.map(([name, sizeGb, expiresInMs]) => ({
      name,
      size: sizeGb * GB,
      sizeVram: sizeGb * GB,
      expiresAt: expiresInMs === undefined ? 0 : NOW + expiresInMs,
    })),
  }
}

describe('estimateFootprint', () => {
  it('uses disk size × 1.3 before the model has been seen loaded', () => {
    const fp = estimateFootprint(model('big:20b', 10))
    expect(fp.measured).toBe(false)
    expect(fp.bytes).toBeCloseTo(10 * GB * FOOTPRINT_DISK_FACTOR)
  })

  it('uses the measured /api/ps size once known', () => {
    const fp = estimateFootprint(model('gemma:e2b', 5.4, { measuredFootprint: 7.4 * GB }))
    expect(fp).toEqual({ bytes: 7.4 * GB, measured: true })
  })
})

describe('computeEvictionSignal', () => {
  const incoming = model('gpt-oss:20b', 10) // ≈13 GB estimated
  const hot = model('nimble-v3:9b', 9, { lastRoutedAt: NOW - 30_000 })
  const cold = model('old:7b', 9, { lastRoutedAt: NOW - 30 * 60_000 })

  it('is 0 when the node is cloud', () => {
    expect(computeEvictionSignal(incoming, nodeWith(hot), loadedState(['nimble-v3:9b', 9]), 16 * GB, true, NOW).value).toBe(0)
  })

  it('is 0 when capacity is not configured', () => {
    expect(computeEvictionSignal(incoming, nodeWith(hot), loadedState(['nimble-v3:9b', 9]), null, false, NOW).value).toBe(0)
  })

  it('is 0 when the loaded state is unknown', () => {
    expect(computeEvictionSignal(incoming, nodeWith(hot), null, 16 * GB, false, NOW).value).toBe(0)
  })

  it('is 0 when the model is already loaded', () => {
    const state = loadedState(['gpt-oss:20b', 13], ['nimble-v3:9b', 9])
    expect(computeEvictionSignal(incoming, nodeWith(hot), state, 24 * GB, false, NOW).value).toBe(0)
  })

  it('is 0 when the footprint fits in the free memory', () => {
    const small = model('gemma4:e2b', 4) // ≈5.2 GB
    const signal = computeEvictionSignal(small, nodeWith(hot), loadedState(['nimble-v3:9b', 9.3]), 32 * GB, false, NOW)
    expect(signal.value).toBe(0)
    expect(signal.detail).toContain('fits')
  })

  it('is close to −1 when loading would evict a model that served traffic recently', () => {
    const signal = computeEvictionSignal(incoming, nodeWith(hot), loadedState(['nimble-v3:9b', 9.3]), 16 * GB, false, NOW)
    expect(signal.value).toBe(-1)
    expect(signal.detail).toContain('nimble-v3:9b')
  })

  it('is near 0 when the only victim has been idle past the inactivity window', () => {
    const signal = computeEvictionSignal(incoming, nodeWith(cold), loadedState(['old:7b', 9.3]), 16 * GB, false, NOW)
    expect(signal.value).toBeGreaterThan(-0.05)
    expect(signal.value).toBeLessThanOrEqual(0)
  })

  it('ramps between the recent and inactive windows', () => {
    const mid = model('mid:7b', 9, { lastRoutedAt: NOW - 6 * 60_000 })
    const signal = computeEvictionSignal(incoming, nodeWith(mid), loadedState(['mid:7b', 9.3]), 16 * GB, false, NOW)
    expect(signal.value).toBeLessThan(-0.3)
    expect(signal.value).toBeGreaterThan(-0.7)
  })

  it('stays protective when a hot and a cold model are loaded, even if only the cold one\'s room is needed', () => {
    const idleSmall = model('idle:1b', 2, { lastRoutedAt: NOW - 60 * 60_000 })
    const hotBig = model('hot:9b', 9, { lastRoutedAt: NOW - 10_000 })
    const state = loadedState(['hot:9b', 9], ['idle:1b', 2])
    // 12 GB capacity leaves 1 GB free; a ≈2.6 GB model would fit once idle:1b goes,
    // but Ollama may just as well unload hot:9b, so the hot model drives the penalty.
    const needsLittle = model('fits-after-idle:2b', 2)
    const signal = computeEvictionSignal(needsLittle, nodeWith(idleSmall, hotBig), state, 12 * GB, false, NOW)
    expect(signal.value).toBe(-1)
    expect(signal.detail).toContain('Ollama may unload any idle model')
    expect(signal.detail).toContain('hot:9b')
  })

  it('is ≈ 0 when every loaded model has been idle past the window', () => {
    const a = model('a:7b', 9, { lastRoutedAt: NOW - 20 * 60_000 })
    const b = model('b:7b', 2, { lastRoutedAt: NOW - 60 * 60_000 })
    const state = loadedState(['a:7b', 9], ['b:7b', 2])
    const signal = computeEvictionSignal(incoming, nodeWith(a, b), state, 14 * GB, false, NOW)
    expect(signal.value).toBeGreaterThan(-0.05)
    expect(signal.value).toBeLessThanOrEqual(0)
  })

  it('falls back to /api/ps expiry when the router has no history', () => {
    const a = model('a:7b', 9)
    const b = model('b:7b', 9)
    // a expires soon (idle), b has a full keep_alive left (just used) → b is the at-risk hot model.
    const state = loadedState(['a:7b', 9, 10_000], ['b:7b', 9, 5 * 60_000])
    const signal = computeEvictionSignal(incoming, nodeWith(a, b), state, 22 * GB, false, NOW)
    expect(signal.value).toBe(-1)
    expect(signal.detail).toContain('b:7b')
  })

  it('gives the maximum penalty to a model larger than the whole node', () => {
    const huge = model('huge:70b', 40)
    const signal = computeEvictionSignal(huge, nodeWith(), loadedState(), 32 * GB, false, NOW)
    expect(signal.value).toBe(-1)
    expect(signal.detail).toContain('more than')
  })

  it('uses the measured footprint instead of the disk estimate', () => {
    const measured = model('gemma4:e2b', 5.4, { measuredFootprint: 7.4 * GB })
    const state = loadedState(['nimble-v3:9b', 9.3])
    // 16.5 GB leaves 7.2 GB free: the disk estimate (7.0 GB) fits, the measured 7.4 GB does not.
    expect(computeEvictionSignal(measured, nodeWith(hot), state, 16.5 * GB, false, NOW).value).toBe(-1)
    const unmeasured = model('gemma4:e2b', 5.4)
    expect(computeEvictionSignal(unmeasured, nodeWith(hot), state, 16.5 * GB, false, NOW).value).toBe(0)
  })
})

describe('scoreCandidate — eviction factor', () => {
  const profile = TaskProfile.from(NEUTRAL_ANALYSIS, 'auto')
  const score = (modelInfo: ModelInfo, eviction: { value: number; detail: string }) =>
    scoreCandidate({
      modelInfo,
      profile,
      analysis: NEUTRAL_ANALYSIS,
      isCloud: false,
      utilization: 0,
      warm: { value: 0, detail: '' },
      eviction,
      cloudUsagePressure: 0,
    })

  const hot = model('nimble-v3:9b', 9.3, { lastRoutedAt: NOW - 20_000 })
  const state = loadedState(['nimble-v3:9b', 9.3])

  it('prefers the node with room for a big cold model when a hot model occupies the other node', () => {
    const big = model('gpt-oss:20b', 13.8)
    const crowded = score(big, computeEvictionSignal(big, nodeWith(hot), state, 20 * GB, false, NOW))
    const roomy = score(big, computeEvictionSignal(big, nodeWith(), loadedState(), 32 * GB, false, NOW))
    expect(roomy.total).toBeGreaterThan(crowded.total)
    expect(roomy.total - crowded.total).toBeCloseTo(profile.weights.eviction, 0)
  })

  it('leaves a small cold model that fits alongside unaffected', () => {
    const small = model('gemma4:e2b', 3)
    const withHot = score(small, computeEvictionSignal(small, nodeWith(hot), state, 32 * GB, false, NOW))
    const empty = score(small, computeEvictionSignal(small, nodeWith(), loadedState(), 32 * GB, false, NOW))
    expect(withHot.total).toBe(empty.total)
  })

  it('reports the eviction factor as a live signal with its detail', () => {
    const big = model('gpt-oss:20b', 13.8)
    const breakdown = score(big, computeEvictionSignal(big, nodeWith(hot), state, 20 * GB, false, NOW))
    const factor = breakdown.factors.find((f) => f.id === 'eviction')
    expect(factor?.source).toBe('live')
    expect(factor?.points).toBeLessThan(0)
    expect(factor?.detail).toContain('nimble-v3:9b')
  })

  it('contributes zero points when nothing is configured', () => {
    const big = model('gpt-oss:20b', 13.8)
    const breakdown = score(big, computeEvictionSignal(big, nodeWith(hot), null, null, false, NOW))
    expect(breakdown.factors.find((f) => f.id === 'eviction')?.points).toBe(0)
  })
})
