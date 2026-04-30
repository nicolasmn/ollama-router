import { describe, it, expect } from '@jest/globals'
import { DiscoveryManager } from '../src/discovery-manager.js'
import { NodeInfo, ModelInfo, ModelProfile } from '../src/models.js'

function makePopulatedDm(...modelNames) {
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
    const node = dm.inventory.get('http://node-a:11434')
    expect(node.reachable).toBe(false)
    expect(node.failures).toBe(1)
    expect(node.lastFailure).toBeGreaterThan(0)
  })

  it('is a no-op when node already unreachable (single-fire design)', () => {
    const dm = makePopulatedDm('gemma4:e4b')
    dm.markNodeUnreachable('http://node-a:11434') // fires
    dm.markNodeUnreachable('http://node-a:11434') // no-op
    expect(dm.inventory.get('http://node-a:11434').failures).toBe(1)
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
    const m = dm.inventory.get('http://node-a:11434').models.get('gemma4:e4b')
    expect(m.recentLatency).toBe(800)
    expect(m.recentTps).toBe(12)
    expect(m.totalRequests).toBe(1)
  })

  it('blends subsequent samples via EMA (value moves, not equal)', () => {
    const dm = makePopulatedDm('gemma4:e4b')
    dm.updateModelMetrics('http://node-a:11434', 'gemma4:e4b', 800, 12)
    dm.updateModelMetrics('http://node-a:11434', 'gemma4:e4b', 200, 40)
    const m = dm.inventory.get('http://node-a:11434').models.get('gemma4:e4b')
    expect(m.recentLatency).not.toBe(800)
    expect(m.recentLatency).not.toBe(200)
    expect(m.recentLatency).toBeGreaterThan(200)
    expect(m.recentLatency).toBeLessThan(800)
    expect(m.totalRequests).toBe(2)
  })

  it('stores last routing endpoint', () => {
    const dm = makePopulatedDm('gemma4:e4b')
    dm.updateModelMetrics('http://node-a:11434', 'gemma4:e4b', 500, 10, '/v1/chat/completions')
    const m = dm.inventory.get('http://node-a:11434').models.get('gemma4:e4b')
    expect(m.lastRoutingEndpoint).toBe('/v1/chat/completions')
  })

  it('is a no-op for unknown host', () => {
    const dm = makePopulatedDm()
    expect(() => dm.updateModelMetrics('http://ghost:11434', 'x', 100, 5)).not.toThrow()
  })
})

describe('DiscoveryManager – recordModelFailure', () => {
  it('increments model failure count', () => {
    const dm = makePopulatedDm('gemma4:e4b')
    dm.recordModelFailure('http://node-a:11434', 'gemma4:e4b', new Error('oops'))
    const m = dm.inventory.get('http://node-a:11434').models.get('gemma4:e4b')
    expect(m.failures).toBe(1)
  })

  it('marks node unreachable on ECONNREFUSED', () => {
    const dm = makePopulatedDm('gemma4:e4b')
    const err = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })
    dm.recordModelFailure('http://node-a:11434', 'gemma4:e4b', err)
    expect(dm.inventory.get('http://node-a:11434').reachable).toBe(false)
  })

  it('marks node unreachable on ECONNRESET', () => {
    const dm = makePopulatedDm('gemma4:e4b')
    const err = Object.assign(new Error('reset'), { code: 'ECONNRESET' })
    dm.recordModelFailure('http://node-a:11434', 'gemma4:e4b', err)
    expect(dm.inventory.get('http://node-a:11434').reachable).toBe(false)
  })

  it('does NOT mark node unreachable for HTTP 503 (model busy, node fine)', () => {
    const dm = makePopulatedDm('gemma4:e4b')
    const err = Object.assign(new Error('HTTP 503'), { statusCode: 503 })
    dm.recordModelFailure('http://node-a:11434', 'gemma4:e4b', err)
    expect(dm.inventory.get('http://node-a:11434').reachable).toBe(true)
  })
})

describe('DiscoveryManager – mergeInventory', () => {
  it('preserves activeRequests and telemetry across re-probe', () => {
    const dm = makePopulatedDm('gemma4:e4b')
    const node = dm.inventory.get('http://node-a:11434')
    node.activeRequests = 3
    dm.updateModelMetrics('http://node-a:11434', 'gemma4:e4b', 600, 15)

    const freshNode = new NodeInfo('http://node-a:11434')
    freshNode.reachable = true
    freshNode.models.set('gemma4:e4b', new ModelInfo('gemma4:e4b', 'test', 1e9, new ModelProfile()))
    dm.mergeInventory(new Map([['http://node-a:11434', freshNode]]))

    const merged = dm.inventory.get('http://node-a:11434')
    expect(merged.activeRequests).toBe(3)
    expect(merged.models.get('gemma4:e4b').recentLatency).toBe(600)
    expect(merged.models.get('gemma4:e4b').totalRequests).toBe(1)
  })

  it('adds newly discovered nodes', () => {
    const dm = makePopulatedDm('gemma4:e4b')
    const newNode = new NodeInfo('http://node-b:11434')
    newNode.reachable = true
    dm.mergeInventory(new Map([['http://node-b:11434', newNode]]))
    expect(dm.inventory.has('http://node-b:11434')).toBe(true)
  })

  it('drops nodes absent from the fresh scan (not included = not probed)', () => {
    // mergeInventory only contains what performProbe returned.
    // A node absent from newInventory was simply not in OLLAMA_NODES this cycle.
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
    // If the guard is in place, the call resolves without changing _lastScanMs
    const before = dm._lastScanMs
    await dm.discoverNetworkNodes()
    expect(dm._lastScanMs).toBe(before)
    dm._scanInProgress = false
  })
})
