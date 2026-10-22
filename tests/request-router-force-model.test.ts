import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { RequestRouter } from '../src/request-router.js'
import { LoadManager } from '../src/load-manager.js'
import { DiscoveryManager } from '../src/discovery-manager.js'
import { ModelInfo, ModelProfile, NodeInfo } from '../src/models.js'
import { forceModelStore } from '../src/force-model-store.js'
import type { ModelProfileData } from '../src/models.js'
import { jest } from '@jest/globals'

function makeDiscovery(
  nodes: Record<string, Record<string, ModelProfileData>>,
): DiscoveryManager {
  const dm = new DiscoveryManager({ ollamaNodes: [] })
  ;(dm as any).getScanStatus = () => ({
    inProgress: false,
    lastScanMs: Date.now(),
    lastScanAgo: 0,
  })
  ;(dm as any).discoverNetworkNodes = jest.fn(async () => {})
  for (const [host, models] of Object.entries(nodes)) {
    const node = new NodeInfo(host, false)
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

describe('RequestRouter — force-model override', () => {
  let router: RequestRouter

  beforeEach(() => {
    forceModelStore.clear()
    const discovery = makeDiscovery({
      'http://node-a:11434': {
        'gemma4:e4b': {
          supportsTools: true,
          parameters: 4.5,
          contextLength: 128000,
        },
        'qwen2.5:7b': {
          supportsTools: true,
          parameters: 7,
          contextLength: 32000,
        },
      },
      'http://node-b:11434': {
        'nomic-embed-text:latest': {
          isEmbedding: true,
          parameters: 0.1,
          contextLength: 8192,
        },
      },
    })
    router = new RequestRouter(
      discovery,
      new LoadManager({ maxConcurrentPerNode: 3 }),
    )
  })

  afterEach(() => {
    forceModelStore.clear()
  })

  describe('selectForChat with override', () => {
    it('uses forced model instead of normal scoring result', async () => {
      // Without override, auto routing would pick gemma4:e4b (higher capability score).
      // Force qwen2.5:7b instead.
      forceModelStore.set('qwen2.5:7b')
      const result = (await router.selectForChat({
        model: 'auto',
        messages: [{ role: 'user', content: 'hi' }],
      })) as any[]
      expect(Array.isArray(result)).toBe(true)
      expect(result.length).toBeGreaterThan(0)
      for (const c of result) expect(c.modelName).toBe('qwen2.5:7b')
    })

    it('clears override after first selectForChat call — one-shot', async () => {
      forceModelStore.set('qwen2.5:7b')
      // First call consumes the override
      await router.selectForChat({
        model: 'auto',
        messages: [{ role: 'user', content: 'hi' }],
      })
      // Override must be gone now
      expect(forceModelStore.get()).toBeNull()
    })

    it('second call after override consumed uses normal routing', async () => {
      forceModelStore.set('qwen2.5:7b')
      await router.selectForChat({
        model: 'auto',
        messages: [{ role: 'user', content: 'hi' }],
      })
      // Second request — normal scoring should pick gemma4:e4b
      const result = (await router.selectForChat({
        model: 'auto',
        messages: [{ role: 'user', content: 'hi' }],
      })) as any[]
      expect(result[0].modelName).toBe('gemma4:e4b')
    })

    it('override with unknown model still returns null (model not in inventory)', async () => {
      forceModelStore.set('does-not-exist:latest')
      const result = await router.selectForChat({
        model: 'auto',
        messages: [{ role: 'user', content: 'hi' }],
      })
      // Router treats unknown forced model same as unknown explicit model → null or 404
      expect(result === null || (result as any).length === 0).toBe(true)
    })

    it('no override set → normal routing unchanged', async () => {
      const result = (await router.selectForChat({
        model: 'auto',
        messages: [{ role: 'user', content: 'hi' }],
      })) as any[]
      expect(result[0].modelName).toBe('gemma4:e4b')
    })
  })

  describe('selectForEmbeddings with override', () => {
    it('override does not bleed into embeddings path — consumed per-call', async () => {
      forceModelStore.set('qwen2.5:7b')
      // If router applies override in embeddings selection, qwen2.5:7b is not an embedding model.
      // Expect either null (no embedding model matched) or the actual embedding model.
      // Either way, the key assertion: override is consumed and gone afterwards.
      await router
        .selectForEmbeddings({ model: 'auto', input: 'hello' })
        .catch(() => {})
      expect(forceModelStore.get()).toBeNull()
    })
  })
})
