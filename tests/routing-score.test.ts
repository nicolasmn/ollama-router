import { describe, it, expect } from '@jest/globals'
import { TaskProfile, NEUTRAL_ANALYSIS, fitsContext, annotateRanking } from '../src/routing-score.js'
import type { ScoreBreakdown } from '../src/routing-score.js'

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
