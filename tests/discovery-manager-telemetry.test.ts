import { describe, it, expect } from '@jest/globals'
import { DiscoveryManager } from '../src/discovery-manager.js'
import { NodeInfo, ModelInfo, ModelProfile } from '../src/models.js'

function makePopulatedDm(...modelNames: string[]): DiscoveryManager {
  const dm = new DiscoveryManager({ ollamaNodes: [] })
  const node = new NodeInfo('http://node-a:11434')
  node.reachable = true
  for (const name of modelNames) {
    node.models.set(name, new ModelInfo(name, 'test', 1e9, new ModelProfile()))
  }
  dm.inventory.set('http://node-a:11434', node)
  return dm
}

describe('DiscoveryManager – markNodeUnreachable', () => {
  it('sets reachable=false and increments failures', () => {
    const dm = makePopulatedDm('gemma4:e4b')
    dm.markNodeUnreachable('http://node-a:11434')
    const node = dm.inventory.get('http://node-a:11434')!
    expect(node.reachable).toBe(false)
    expect(node.failures).toBe(1)
    expect(node.lastFailure).toBeGreaterThan(0)
  })

  it('is a no-op when node already unreachable (single-fire design)', () => {
    const dm = makePopulatedDm('gemma4:e4b')
    dm.markNodeUnreachable('http://node-a:11434')
    dm.markNodeUnreachable('http://node-a:11434')
    expect(dm.inventory.get('http://node-a:11434')!.failures).toBe(1)
  })

  it('is a no-op for unknown host', () => {
    const dm = makePopulatedDm()
    expect(() => dm.markNodeUnreachable('http://ghost:11434')).not.toThrow()
  })
})

describe('DiscoveryManager – updateModelMetrics', () => {
  it('records first latency and tps verbatim', () => {
    const dm = makePopulatedDm('gemma4:e4b')
    dm.updateModelMetrics('http://node-a:11434', 'gemma4:e4b', 800, 12)
    const m = dm.inventory.get('http://node-a:11434')!.models.get('gemma4:e4b')!
    expect(m.recentLatency).toBe(800)
    expect(m.recentTps).toBe(15)
    expect(m.totalRequests).toBe(1)
  })

  it('blends subsequent samples via EMA (value moves, not equal)', () => {
    const dm = makePopulatedDm('gemma4:e4b')
    dm.updateModelMetrics('http://node-a:11434', 'gemma4:e4b', 800, 12)
    dm.updateModelMetrics('http://node-a:11434', 'gemma4:e4b', 200, 40)
    const m = dm.inventory.get('http://node-a:11434')!.models.get('gemma4:e4b')!
    expect(m.recentLatency).not.toBe(800)
    expect(m.recentLatency).not.toBe(200)
    expect(m.recentLatency).toBeGreaterThan(200)
    expect(m.recentLatency).toBeLessThan(800)
    expect(m.totalRequests).toBe(2)
  })

  it('stores last routing endpoint', () => {
    const dm = makePopulatedDm('gemma4:e4b')
    dm.updateModelMetrics('http://node-a:11434', 'gemma4:e4b', 500, 10, '/v1/chat/completions')
    const m = dm.inventory.get('http://node-a:11434')!.models.get('gemma4:e4b')!
    expect(m.lastRoutingEndpoint).toBe('/v1/chat/completions')
  })

  it('is a no-op for unknown host', () => {
    const dm = makePopulatedDm()
    expect(() => dm.updateModelMetrics('http://ghost:11434', 'x', 100, 5)).not.toThrow()
    expect(() => dm.updateModelMetrics('http://ghost:11434', 'x', 100, 5, '/api/chat', { ttftMs: 50, loadMs: 500, decodeMs: 100 })).not.toThrow()
  })

  it('measures TPS against the provided decode window, not wall clock', () => {
    const dm = makePopulatedDm('gemma4:e4b')
    // 90 tokens, 40 s wall clock, but the upstream reports a 3 s eval window
    dm.updateModelMetrics('http://node-a:11434', 'gemma4:e4b', 40_000, 90, undefined, { decodeMs: 3_000 })
    const m = dm.inventory.get('http://node-a:11434')!.models.get('gemma4:e4b')!
    expect(m.recentTps).toBeCloseTo(30, 5)
  })

  it('subtracts model load from wall clock when no decode stats are available', () => {
    const dm = makePopulatedDm('gemma4:e4b')
    dm.updateModelMetrics('http://node-a:11434', 'gemma4:e4b', 10_000, 200, undefined, { loadMs: 9_000 })
    const m = dm.inventory.get('http://node-a:11434')!.models.get('gemma4:e4b')!
    expect(m.recentTps).toBeCloseTo(200, 5) // 200 tokens over the 1 s decode window
  })

  it('records TTFT and load EMA from per-request telemetry', () => {
    const dm = makePopulatedDm('gemma4:e4b')
    dm.updateModelMetrics('http://node-a:11434', 'gemma4:e4b', 8_800, 12, undefined, { ttftMs: 400, loadMs: 8_000 })
    const m = dm.inventory.get('http://node-a:11434')!.models.get('gemma4:e4b')!
    expect(m.recentTtft).toBe(400)
    expect(m.recentLoadMs).toBe(8_000)
    // Second request: warm load, faster TTFT → EMA blends toward the new values
    dm.updateModelMetrics('http://node-a:11434', 'gemma4:e4b', 2_800, 12, undefined, { ttftMs: 200, loadMs: 3_000 })
    expect(m.recentTtft).toBeGreaterThan(200)
    expect(m.recentTtft).toBeLessThan(400)
    expect(m.recentLoadMs).toBeGreaterThan(3_000)
    expect(m.recentLoadMs).toBeLessThan(8_000)
  })

  it('streaming without token counts leaves recentTps untouched', () => {
    const dm = makePopulatedDm('gemma4:e4b')
    dm.updateModelMetrics('http://node-a:11434', 'gemma4:e4b', 500, 20)
    dm.updateModelMetrics('http://node-a:11434', 'gemma4:e4b', 1_500, 0, undefined, { ttftMs: 120 })
    const m = dm.inventory.get('http://node-a:11434')!.models.get('gemma4:e4b')!
    expect(m.recentTps).toBeGreaterThan(0)
    expect(m.recentTtft).toBe(120)
  })
})

describe('DiscoveryManager – recordModelFailure', () => {
  it('increments model failure count', () => {
    const dm = makePopulatedDm('gemma4:e4b')
    dm.recordModelFailure('http://node-a:11434', 'gemma4:e4b', new Error('oops') as NodeJS.ErrnoException)
    const m = dm.inventory.get('http://node-a:11434')!.models.get('gemma4:e4b')!
    expect(m.failures).toBe(1)
  })

  it('marks node unreachable on ECONNREFUSED', () => {
    const dm = makePopulatedDm('gemma4:e4b')
    const err = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) as NodeJS.ErrnoException
    dm.recordModelFailure('http://node-a:11434', 'gemma4:e4b', err)
    expect(dm.inventory.get('http://node-a:11434')!.reachable).toBe(false)
  })

  it('marks node unreachable on ECONNRESET', () => {
    const dm = makePopulatedDm('gemma4:e4b')
    const err = Object.assign(new Error('reset'), { code: 'ECONNRESET' }) as NodeJS.ErrnoException
    dm.recordModelFailure('http://node-a:11434', 'gemma4:e4b', err)
    expect(dm.inventory.get('http://node-a:11434')!.reachable).toBe(false)
  })

  it('does NOT mark node unreachable for HTTP 503 (model busy, node fine)', () => {
    const dm = makePopulatedDm('gemma4:e4b')
    const err = Object.assign(new Error('HTTP 503'), { statusCode: 503 }) as NodeJS.ErrnoException
    dm.recordModelFailure('http://node-a:11434', 'gemma4:e4b', err)
    expect(dm.inventory.get('http://node-a:11434')!.reachable).toBe(true)
  })
})

describe('DiscoveryManager – mergeInventory', () => {
  it('preserves activeRequests and telemetry across re-probe', () => {
    const dm = makePopulatedDm('gemma4:e4b')
    const node = dm.inventory.get('http://node-a:11434')!
    node.activeRequests = 3
    dm.updateModelMetrics('http://node-a:11434', 'gemma4:e4b', 600, 15)

    const freshNode = new NodeInfo('http://node-a:11434')
    freshNode.reachable = true
    freshNode.models.set('gemma4:e4b', new ModelInfo('gemma4:e4b', 'test', 1e9, new ModelProfile()))
    dm.mergeInventory(new Map([['http://node-a:11434', freshNode]]))

    const merged = dm.inventory.get('http://node-a:11434')!
    expect(merged.activeRequests).toBe(3)
    expect(merged.models.get('gemma4:e4b')!.recentLatency).toBe(600)
    expect(merged.models.get('gemma4:e4b')!.totalRequests).toBe(1)

    dm.updateModelMetrics('http://node-a:11434', 'gemma4:e4b', 600, 15, undefined, { ttftMs: 300, loadMs: 7_000 })
    dm.mergeInventory(new Map([['http://node-a:11434', freshNode]]))
    const remodeled = dm.inventory.get('http://node-a:11434')!.models.get('gemma4:e4b')!
    expect(remodeled.recentTtft).toBe(300)
    expect(remodeled.recentLoadMs).toBe(7_000)
  })

  it('adds newly discovered nodes', () => {
    const dm = makePopulatedDm('gemma4:e4b')
    const newNode = new NodeInfo('http://node-b:11434')
    newNode.reachable = true
    dm.mergeInventory(new Map([['http://node-b:11434', newNode]]))
    expect(dm.inventory.has('http://node-b:11434')).toBe(true)
  })

  it('drops nodes absent from the fresh scan (not included = not probed)', () => {
    const dm = makePopulatedDm('gemma4:e4b')
    dm.mergeInventory(new Map())
    expect(dm.inventory.has('http://node-a:11434')).toBe(false)
  })
})

describe('DiscoveryManager – scan concurrency guard', () => {
  it('getScanStatus.inProgress is false by default', () => {
    const dm = new DiscoveryManager({ ollamaNodes: [] })
    expect(dm.getScanStatus().inProgress).toBe(false)
  })

  it('discoverNetworkNodes returns immediately when _scanInProgress is true', async () => {
    const dm = new DiscoveryManager({ ollamaNodes: [] })
    dm._scanInProgress = true
    const before = dm._lastScanMs
    await dm.discoverNetworkNodes()
    expect(dm._lastScanMs).toBe(before)
    dm._scanInProgress = false
  })
})
