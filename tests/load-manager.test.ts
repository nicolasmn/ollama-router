import { describe, it, expect, beforeEach } from '@jest/globals'
import { LoadManager } from '../src/load-manager.js'

describe('LoadManager', () => {
  let lm: LoadManager

  beforeEach(() => {
    lm = new LoadManager({ maxConcurrentPerNode: 3 })
  })

  it('starts at zero load', () => {
    expect(lm.getCurrentLoad('node-a')).toBe(0)
    expect(lm.isAtCapacity('node-a')).toBe(false)
  })

  it('increments and decrements load', () => {
    lm.incrementLoad('node-a')
    expect(lm.getCurrentLoad('node-a')).toBe(1)
    lm.decrementLoad('node-a')
    expect(lm.getCurrentLoad('node-a')).toBe(0)
  })

  it('throws when at capacity', () => {
    lm.incrementLoad('node-a')
    lm.incrementLoad('node-a')
    lm.incrementLoad('node-a')
    expect(() => lm.incrementLoad('node-a')).toThrow()
  })

  it('reports at capacity correctly', () => {
    lm.incrementLoad('node-a')
    lm.incrementLoad('node-a')
    expect(lm.isAtCapacity('node-a')).toBe(false)
    lm.incrementLoad('node-a')
    expect(lm.isAtCapacity('node-a')).toBe(true)
  })

  it('does not underflow below zero on decrement', () => {
    lm.decrementLoad('node-a')
    expect(lm.getCurrentLoad('node-a')).toBe(0)
  })

  it('tracks multiple nodes independently', () => {
    lm.incrementLoad('node-a')
    lm.incrementLoad('node-a')
    lm.incrementLoad('node-b')
    expect(lm.getCurrentLoad('node-a')).toBe(2)
    expect(lm.getCurrentLoad('node-b')).toBe(1)
    expect(lm.isAtCapacity('node-a')).toBe(false)
    expect(lm.isAtCapacity('node-b')).toBe(false)
  })

  it('cleans up orphaned nodes', () => {
    lm.incrementLoad('node-a')
    lm.incrementLoad('node-b')
    lm.cleanupOrphanedNodes(new Set(['node-a']))
    expect(lm.getCurrentLoad('node-a')).toBe(1)
    expect(lm.getCurrentLoad('node-b')).toBe(0)
  })

  it('returns max concurrent per node', () => {
    expect(lm.getMaxConcurrentPerNode()).toBe(3)
  })

  it('computes utilization per node', () => {
    lm.incrementLoad('node-a')
    expect(lm.getUtilization('node-a')).toBeCloseTo(1 / 3, 6)
    lm.incrementLoad('node-a')
    expect(lm.getUtilization('node-a')).toBeCloseTo(2 / 3, 6)
  })
})
