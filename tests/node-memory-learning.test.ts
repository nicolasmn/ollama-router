import { describe, it, expect } from '@jest/globals'
import {
  DEFAULT_MAX_LOADED_MODELS,
  effectiveLoadedLimit,
  observeLoadedSnapshot,
  resolveNodeMemory,
} from '../src/node-memory.js'
import { computeEvictionSignal } from '../src/routing-score.js'
import { NodeInfo, ModelInfo, ModelProfile } from '../src/models.js'
import type { LoadedModel } from '../src/models.js'

const GB = 1024 ** 3
const NOW = 1_700_000_000_000

function loaded(name: string, sizeGb: number, expiresInMs = 4 * 60_000, vramGb = sizeGb): LoadedModel {
  return { name, size: sizeGb * GB, sizeVram: vramGb * GB, expiresAt: NOW + expiresInMs }
}

function freshMemory() {
  return new NodeInfo('http://node:11434').memory
}

describe('observeLoadedSnapshot', () => {
  it('tracks the largest total and count seen loaded together', () => {
    const mem = freshMemory()
    observeLoadedSnapshot(mem, [loaded('a', 8), loaded('b', 4)], NOW)
    observeLoadedSnapshot(mem, [loaded('a', 8)], NOW + 15_000)
    expect(mem.fitBytes).toBe(12 * GB)
    expect(mem.maxSeenLoaded).toBe(2)
    expect(mem.noFitBytes).toBe(0)
  })

  it('learns noFitBytes when a load evicts a still-live model and the total exceeds anything seen', () => {
    const mem = freshMemory()
    observeLoadedSnapshot(mem, [loaded('a', 8), loaded('b', 4)], NOW)
    // c (10 GB) arrived, a vanished although it had 4 min left: 8 + 4 + 10 = 22 GB did not fit.
    observeLoadedSnapshot(mem, [loaded('b', 4), loaded('c', 10)], NOW + 15_000)
    expect(mem.noFitBytes).toBe(22 * GB)
    expect(mem.maxLoaded).toBe(0)
    expect(mem.fitBytes).toBe(14 * GB)
  })

  it('keeps the smallest noFitBytes across events', () => {
    const mem = freshMemory()
    observeLoadedSnapshot(mem, [loaded('a', 8)], NOW)
    observeLoadedSnapshot(mem, [loaded('c', 20)], NOW + 15_000) // 28 did not fit
    observeLoadedSnapshot(mem, [loaded('d', 12)], NOW + 30_000) // 20 + 12 = 32, larger → no change
    expect(mem.noFitBytes).toBe(28 * GB)
  })

  it('learns maxLoaded when an eviction happened although that much had fitted before', () => {
    const mem = freshMemory()
    observeLoadedSnapshot(mem, [loaded('big', 9, 10_000)], NOW) // expires on its own; 9 GB demonstrably fitted
    observeLoadedSnapshot(mem, [loaded('a', 2), loaded('b', 2), loaded('c', 2)], NOW + 15_000)
    // d arrived, a vanished early: 6 + 2 = 8 GB ≤ 9 GB seen → not memory, the 3-model limit.
    observeLoadedSnapshot(mem, [loaded('b', 2), loaded('c', 2), loaded('d', 2)], NOW + 30_000)
    expect(mem.maxLoaded).toBe(3)
    expect(mem.noFitBytes).toBe(0)
  })

  it('ignores a vanished model without a new one (ollama stop / keep_alive 0)', () => {
    const mem = freshMemory()
    observeLoadedSnapshot(mem, [loaded('a', 8), loaded('b', 4)], NOW)
    observeLoadedSnapshot(mem, [loaded('b', 4)], NOW + 15_000)
    expect(mem.noFitBytes).toBe(0)
    expect(mem.maxLoaded).toBe(0)
  })

  it('ignores a model that vanished because its keep-alive expired', () => {
    const mem = freshMemory()
    observeLoadedSnapshot(mem, [loaded('a', 8, 10_000)], NOW)
    observeLoadedSnapshot(mem, [loaded('c', 20)], NOW + 15_000)
    expect(mem.noFitBytes).toBe(0)
    expect(mem.maxLoaded).toBe(0)
  })

  it('does not compare across a failed probe', () => {
    const mem = freshMemory()
    observeLoadedSnapshot(mem, [loaded('a', 8)], NOW)
    mem.lastSnapshot = null // what a failed probe does
    observeLoadedSnapshot(mem, [loaded('c', 20)], NOW + 15_000)
    expect(mem.noFitBytes).toBe(0)
    expect(mem.fitBytes).toBe(20 * GB)
  })

  it('learns noFitBytes from partial GPU offload as Σ sizeVram of the snapshot', () => {
    const mem = freshMemory()
    observeLoadedSnapshot(mem, [loaded('a', 8), loaded('b', 10, 60_000, 6)], NOW)
    expect(mem.noFitBytes).toBe(14 * GB)
    // Σ size includes the CPU-resident part, so it is no evidence of what fits.
    expect(mem.fitBytes).toBe(0)
  })

  it('learns nothing from an eviction while the node is at its loaded-model limit', () => {
    const mem = freshMemory()
    observeLoadedSnapshot(mem, [loaded('a', 2), loaded('b', 2), loaded('c', 2)], NOW)
    // d pushed out a with 3 of 3 loaded: 8 GB exceeds anything seen, but the limit alone explains it.
    observeLoadedSnapshot(mem, [loaded('b', 2), loaded('c', 2), loaded('d', 2)], NOW + 15_000)
    expect(mem.noFitBytes).toBe(0)
    expect(mem.maxLoaded).toBe(0)
  })

  it('forgets noFitBytes once a total that large is seen loaded together', () => {
    const mem = freshMemory()
    observeLoadedSnapshot(mem, [loaded('a', 8), loaded('b', 4)], NOW)
    observeLoadedSnapshot(mem, [loaded('b', 4), loaded('c', 10)], NOW + 15_000) // 22 GB did not fit
    expect(mem.noFitBytes).toBe(22 * GB)
    observeLoadedSnapshot(mem, [loaded('b', 4), loaded('c', 10), loaded('e', 9)], NOW + 30_000) // 23 GB fits
    expect(mem.noFitBytes).toBe(0)
    expect(mem.fitBytes).toBe(23 * GB)
  })
})

describe('resolveNodeMemory', () => {
  it('prefers configured memory over learned', () => {
    const mem = freshMemory()
    mem.noFitBytes = 22 * GB
    expect(resolveNodeMemory(mem, 64 * GB)).toEqual({ bytes: 64 * GB, source: 'config' })
  })

  it('falls back to learned noFitBytes, then to unknown', () => {
    const mem = freshMemory()
    expect(resolveNodeMemory(mem, null)).toEqual({ bytes: null, source: null })
    mem.noFitBytes = 22 * GB
    expect(resolveNodeMemory(mem, null)).toEqual({ bytes: 22 * GB, source: 'learned' })
  })
})

describe('effectiveLoadedLimit', () => {
  it('defaults to Ollama\'s 3 and rises with the most models ever seen together', () => {
    const mem = freshMemory()
    expect(effectiveLoadedLimit(mem)).toBe(DEFAULT_MAX_LOADED_MODELS)
    observeLoadedSnapshot(mem, [loaded('a', 1), loaded('b', 1), loaded('c', 1), loaded('d', 1)], NOW)
    expect(effectiveLoadedLimit(mem)).toBe(4)
  })

  it('uses the learned limit when known', () => {
    const mem = freshMemory()
    mem.maxLoaded = 2
    expect(effectiveLoadedLimit(mem)).toBe(2)
  })
})

describe('computeEvictionSignal — loaded-model limit', () => {
  const model = (name: string, diskGb: number, lastRoutedAt = 0) => {
    const info = new ModelInfo(name, 'test', diskGb * GB, new ModelProfile())
    info.lastRoutedAt = lastRoutedAt
    return info
  }
  const hot = model('hot:7b', 4, NOW - 10_000)
  const nodeModels = new Map([[hot.name, hot]])
  const state = {
    updatedAt: NOW,
    models: [loaded('hot:7b', 4), loaded('b', 1), loaded('c', 1)],
  }

  it('penalizes a cold model that fits in memory when the node is at its limit', () => {
    const small = model('small:1b', 1)
    const signal = computeEvictionSignal(small, nodeModels, state, 64 * GB, false, NOW, 3)
    expect(signal.value).toBe(-1)
    expect(signal.detail).toContain('already holds 3 of max 3 models')
    expect(signal.detail).toContain('hot:7b')
  })

  it('penalizes at the limit even when no memory is known', () => {
    expect(computeEvictionSignal(model('small:1b', 1), nodeModels, state, null, false, NOW, 3).value).toBe(-1)
  })

  it('is 0 below the limit, or once the limit has been raised', () => {
    const small = model('small:1b', 1)
    expect(computeEvictionSignal(small, nodeModels, state, 64 * GB, false, NOW, 4).value).toBe(0)
    expect(computeEvictionSignal(small, nodeModels, state, null, false, NOW, 4).value).toBe(0)
  })

  it('does not penalize a model that is already loaded', () => {
    expect(computeEvictionSignal(hot, nodeModels, state, null, false, NOW, 3).value).toBe(0)
  })
})
