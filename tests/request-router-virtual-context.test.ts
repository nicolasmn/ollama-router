import { describe, it, expect, beforeEach, jest } from '@jest/globals'
import { RequestRouter, VIRTUAL_MODELS } from '../src/request-router.js'
import { LoadManager } from '../src/load-manager.js'
import { DiscoveryManager } from '../src/discovery-manager.js'
import { ModelInfo, ModelProfile, NodeInfo } from '../src/models.js'
import type { ModelProfileData } from '../src/models.js'

function makeDiscovery(
  nodes: Record<string, Record<string, ModelProfileData>>,
  cloudHosts: string[] = [],
): DiscoveryManager {
  const dm = new DiscoveryManager({ ollamaNodes: [] })
  ;(dm as any).getScanStatus = () => ({
    inProgress: false,
    lastScanMs: Date.now(),
    lastScanAgo: 0,
  })
  ;(dm as any).discoverNetworkNodes = jest.fn(async () => {})
  const cloudSet = new Set(cloudHosts)
  for (const [host, models] of Object.entries(nodes)) {
    const node = new NodeInfo(host, cloudSet.has(host))
    node.reachable = true
    for (const [name, profileData] of Object.entries(models)) {
      const profile = new ModelProfile(profileData)
      const info = new ModelInfo(name, 'test', 1e9, profile)
      node.models.set(name, info)
    }
    dm.inventory.set(host, node)
  }
  return dm
}

describe('Virtual model catalog context_length', () => {
  /**
   * Fixture: three non-embedding chat models across two nodes.
   *
   *   small:3b      — contextLength 8 192   (both nodes)
   *   large:27b     — contextLength 32 768  (node-a only)
   *   think:32b     — contextLength 128 000, supportsThinking (node-b only)
   *
   * Expected min-context per alias:
   *   auto        → 8 192   (min of all non-embedding models)
   *   auto-fast   → 8 192   (same pool; size scoring differs but filter is the same)
   *   auto-think  → 128 000 (only think:32b qualifies after supportsThinking filter)
   *   auto-local  → 8 192   (cloud node excluded, so same as auto pool on local node)
   */
  let router: RequestRouter

  beforeEach(() => {
    const discovery = makeDiscovery(
      {
        'http://local:11434': {
          'small:3b':  { parameters: 3,  contextLength: 8_192,   supportsTools: true },
          'large:27b': { parameters: 27, contextLength: 32_768,  supportsTools: true },
        },
        'http://cloud:11434': {
          'small:3b':  { parameters: 3,  contextLength: 8_192,   supportsTools: true },
          'think:32b': { parameters: 32, contextLength: 128_000, supportsTools: true, supportsThinking: true },
        },
      },
      ['http://cloud:11434'],
    )
    const lm = new LoadManager({ maxConcurrentPerNode: 3 })
    lm.setUnlimited('http://cloud:11434')
    router = new RequestRouter(discovery, lm)
  })

  it('auto reports min context across all non-embedding models', () => {
    const catalog = router.getModelCatalog()
    const entry = catalog.find((m) => m.id === 'auto')!
    expect(entry.context_length).toBe(8_192)
  })

  it('auto-fast reports min context (same pool as auto)', () => {
    const catalog = router.getModelCatalog()
    const entry = catalog.find((m) => m.id === 'auto-fast')!
    expect(entry.context_length).toBe(8_192)
  })

  it('auto-think reports min context of thinking-capable models only', () => {
    const catalog = router.getModelCatalog()
    const entry = catalog.find((m) => m.id === 'auto-think')!
    // Only think:32b (128 000) passes the supportsThinking filter
    expect(entry.context_length).toBe(128_000)
  })

  it('auto-local excludes cloud models from context calculation', () => {
    const catalog = router.getModelCatalog()
    const entry = catalog.find((m) => m.id === 'auto-local')!
    // Cloud node (which has think:32b with 128k) is excluded; local min is 8 192
    expect(entry.context_length).toBe(8_192)
  })

  it('all virtual models have a non-zero context_length when nodes are available', () => {
    const catalog = router.getModelCatalog()
    for (const alias of VIRTUAL_MODELS) {
      const entry = catalog.find((m) => m.id === alias)!
      expect(entry.context_length).toBeGreaterThan(0)
    }
  })

  it('returns 0 context_length for virtual models when no eligible models exist', () => {
    // auto-think with zero thinking-capable models
    const discovery = makeDiscovery({
      'http://local:11434': {
        'plain:7b': { parameters: 7, contextLength: 8_192, supportsThinking: false },
      },
    })
    const lm = new LoadManager({ maxConcurrentPerNode: 3 })
    const r = new RequestRouter(discovery, lm)
    const catalog = r.getModelCatalog()
    const entry = catalog.find((m) => m.id === 'auto-think')!
    expect(entry.context_length).toBe(0)
  })

  it('real model entries also carry context_length', () => {
    const catalog = router.getModelCatalog()
    const small = catalog.find((m) => m.id === 'small:3b')!
    const large = catalog.find((m) => m.id === 'large:27b')!
    expect(small.context_length).toBe(8_192)
    expect(large.context_length).toBe(32_768)
  })
})
