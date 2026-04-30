import { describe, it, expect, beforeEach, jest } from '@jest/globals'
import { RequestRouter } from '../src/request-router.js'
import { LoadManager } from '../src/load-manager.js'
import { DiscoveryManager } from '../src/discovery-manager.js'
import { ModelInfo, ModelProfile, NodeInfo } from '../src/models.js'
import type { ModelProfileData } from '../src/models.js'

function makeDiscovery(
  nodes: Record<string, Record<string, ModelProfileData>>,
): DiscoveryManager {
  const dm = new DiscoveryManager({ ollamaNodes: [] })
  ;(dm as any).getScanStatus = () => ({ inProgress: false, lastScanMs: Date.now(), lastScanAgo: 0 })
  ;(dm as any).discoverNetworkNodes = jest.fn(async () => {})
  for (const [host, models] of Object.entries(nodes)) {
    const node = new NodeInfo(host)
    node.reachable = true
    for (const [name, profileData] of Object.entries(models)) {
      const profile = new ModelProfile(profileData)
      node.models.set(name, new ModelInfo(name, 'test', 1e9, profile))
    }
    dm.inventory.set(host, node)
  }
  return dm
}

describe('RequestRouter', () => {
  let loadManager: LoadManager
  let router: RequestRouter

  beforeEach(() => {
    loadManager = new LoadManager({ maxConcurrentPerNode: 3 })
    const discovery = makeDiscovery({
      'http://node-a:11434': {
        'gemma4:e4b': {
          supportsTools: true, supportsVision: true, supportsAudio: true,
          supportsThinking: true, parameters: 4.5, contextLength: 128000,
        },
        'gemma4:26b': {
          supportsTools: true, supportsVision: true, supportsThinking: true,
          parameters: 26, contextLength: 128000,
        },
        'qwen2.5:1.5b': { supportsTools: false, parameters: 1.5, contextLength: 32000 },
      },
      'http://node-b:11434': {
        'nomic-embed-text:latest': { isEmbedding: true, parameters: 0.1, contextLength: 8192 },
        'gemma4:26b': { supportsTools: true, parameters: 26, contextLength: 128000 },
      },
    })
    router = new RequestRouter(discovery, loadManager)
  })

  describe('selectForChat', () => {
    it('returns candidates for simple request', async () => {
      const result = await router.selectForChat({
        model: 'auto',
        messages: [{ role: 'user', content: 'hi' }],
      })
      expect(Array.isArray(result)).toBe(true)
      expect((result as unknown[]).length).toBeGreaterThan(0)
      expect((result as any)[0]).toMatchObject({ nodeHost: expect.any(String), modelName: 'gemma4:e4b' })
    })

    it('returns single candidate for streaming request', async () => {
      const result = await router.selectForChat({
        model: 'auto',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      })
      expect(result).not.toBeNull()
      expect(Array.isArray(result)).toBe(false)
      expect(result).toMatchObject({ nodeHost: expect.any(String), modelName: expect.any(String) })
    })

    it('filters to tool-capable models when tools present', async () => {
      const result = await router.selectForChat({
        model: 'auto',
        messages: [{ role: 'user', content: 'use a tool' }],
        tools: [{ type: 'function', function: { name: 'get_time' } }],
      }) as any[]
      expect(Array.isArray(result)).toBe(true)
      expect(result.length).toBeGreaterThan(0)
      for (const c of result) expect(c.modelInfo.profile.supportsTools).toBe(true)
    })

    it('prefers capable small thinking models for day-to-day reasoning prompts', async () => {
      const result = await router.selectForChat({
        model: 'auto',
        messages: [{ role: 'user', content: 'Erkläre bitte die Unterschiede zwischen Caching im Browser und im CDN und gib mir eine kurze Empfehlung.' }],
      }) as any[]
      expect(Array.isArray(result)).toBe(true)
      expect(result[0].modelName).toBe('gemma4:e4b')
    })

    it('still prefers larger thinking models for code-heavy reasoning', async () => {
      const result = await router.selectForChat({
        model: 'auto',
        messages: [{ role: 'user', content: 'Please debug this function and explain the bug: function add(a, b) { return a - b }' }],
      }) as any[]
      expect(Array.isArray(result)).toBe(true)
      expect(result[0].modelName).toBe('gemma4:26b')
    })

    it('returns null when no tool-capable model available', async () => {
      const discovery = makeDiscovery({
        'http://node-c:11434': {
          'small-model': { supportsTools: false, parameters: 1, contextLength: 4096 },
        },
      })
      const r = new RequestRouter(discovery, new LoadManager({ maxConcurrentPerNode: 3 }))
      const result = await r.selectForChat({
        model: 'auto',
        messages: [{ role: 'user', content: 'use tool' }],
        tools: [{ type: 'function', function: { name: 'x' } }],
      })
      expect(result).toBeNull()
    })

    it('resolves concrete model name', async () => {
      const result = await router.selectForChat({
        model: 'qwen2.5:1.5b',
        messages: [{ role: 'user', content: 'hi' }],
      }) as any[]
      expect(Array.isArray(result)).toBe(true)
      expect(result[0].modelName).toBe('qwen2.5:1.5b')
    })

    it('throws 404 for unknown model', async () => {
      await expect(
        router.selectForChat({ model: 'does-not-exist', messages: [] }),
      ).rejects.toMatchObject({ statusCode: 404, code: 'MODEL_NOT_FOUND' })
    })

    it('prefers 26B for long conversations regardless of message complexity', async () => {
      const messages = Array.from({ length: 12 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: 'hi',
      }))
      const result = await router.selectForChat({ model: 'auto', messages }) as any[]
      expect(Array.isArray(result)).toBe(true)
      expect(result[0].modelName).toBe('gemma4:26b')
    })

    it('excludes embedding models from chat requests', async () => {
      const result = await router.selectForChat({
        model: 'auto',
        messages: [{ role: 'user', content: 'hi' }],
      }) as any[]
      for (const c of result) expect(c.modelInfo.profile.isEmbedding).toBe(false)
    })
  })

  describe('selectForEmbeddings', () => {
    it('routes to embedding model', async () => {
      const result = await router.selectForEmbeddings({ model: 'auto', input: 'hello' }) as any[]
      expect(Array.isArray(result)).toBe(true)
      expect(result.length).toBeGreaterThan(0)
      for (const c of result) expect(c.modelInfo.profile.isEmbedding).toBe(true)
    })
  })

  describe('auto-fast alias', () => {
    it('prefers small models for auto-fast', async () => {
      const result = await router.selectForChat({
        model: 'auto-fast',
        messages: [{ role: 'user', content: 'hi' }],
      }) as any
      expect(result).not.toBeNull()
      expect(result[0].modelName).toBe('gemma4:e4b')
    })
  })

  describe('capacity handling', () => {
    it('excludes saturated nodes', async () => {
      loadManager.incrementLoad('http://node-a:11434')
      loadManager.incrementLoad('http://node-a:11434')
      loadManager.incrementLoad('http://node-a:11434')
      const result = await router.selectForChat({
        model: 'auto',
        messages: [{ role: 'user', content: 'hi' }],
      }) as any[]
      for (const c of result) expect(c.nodeHost).not.toBe('http://node-a:11434')
    })
  })

  describe('getModelCatalog', () => {
    it('returns all models including virtual ones', () => {
      const catalog = router.getModelCatalog()
      const ids = catalog.map((m) => m.id)
      expect(ids).toContain('auto')
      expect(ids).toContain('auto-fast')
      expect(ids).toContain('auto-think')
      expect(ids).toContain('gemma4:e4b')
      expect(ids).toContain('gemma4:26b')
      expect(ids).toContain('qwen2.5:1.5b')
      expect(ids).toContain('nomic-embed-text:latest')
    })

    it('deduplicates models across nodes', () => {
      const catalog = router.getModelCatalog()
      const gemmaEntries = catalog.filter((m) => m.id === 'gemma4:26b')
      expect(gemmaEntries.length).toBe(1)
    })
  })
})
