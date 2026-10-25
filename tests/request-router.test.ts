import { describe, it, expect, beforeEach, jest } from '@jest/globals'
import { RequestRouter } from '../src/request-router.js'
import { LoadManager } from '../src/load-manager.js'
import { DiscoveryManager } from '../src/discovery-manager.js'
import { ModelInfo, ModelProfile, NodeInfo } from '../src/models.js'
import type { ModelProfileData } from '../src/models.js'

function makeDiscovery(
  nodes: Record<string, Record<string, ModelProfileData>>,
  cloudHosts: string[] = [],
  metricsOverrides: Record<
    string,
    Record<
      string,
      Partial<{
        recentLatency: number
        recentTps: number
        lastRoutedAt: number
      }>
    >
  > = {},
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
      const overrides = metricsOverrides[host]?.[name]
      if (overrides) {
        if (overrides.recentLatency !== undefined)
          info.recentLatency = overrides.recentLatency
        if (overrides.recentTps !== undefined)
          info.recentTps = overrides.recentTps
        if (overrides.lastRoutedAt !== undefined)
          info.lastRoutedAt = overrides.lastRoutedAt
      }
      node.models.set(name, info)
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

    it('returns array even for streaming request', async () => {
      const result = await router.selectForChat({
        model: 'auto',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      })
      expect(result).not.toBeNull()
      expect(Array.isArray(result)).toBe(true)
      expect((result as any)[0]).toMatchObject({ nodeHost: expect.any(String), modelName: expect.any(String) })
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

    it('routes native top-level-images chat requests to vision-capable models only', async () => {
      const result = await router.selectForChat({
        model: 'auto',
        messages: [{ role: 'user', content: 'what is in this image?' }],
        images: ['iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='],
      }) as any[]
      expect(Array.isArray(result)).toBe(true)
      expect(result.length).toBeGreaterThan(0)
      for (const c of result) expect(c.modelInfo.profile.supportsVision).toBe(true)
    })

    it('routes native per-message image chat requests to vision-capable models', async () => {
      const result = await router.selectForChat({
        model: 'auto',
        messages: [
          { role: 'user', content: 'what is in this image?', images: ['iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='] },
        ],
      }) as any[]
      expect(Array.isArray(result)).toBe(true)
      for (const c of result) expect(c.modelInfo.profile.supportsVision).toBe(true)
    })

    it('routes Responses API image input to vision-capable models', async () => {
      const result = await router.selectForResponses({
        model: 'auto',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: 'what is in this image?' },
              { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=' },
            ],
          },
        ],
      }) as any[]
      expect(Array.isArray(result)).toBe(true)
      for (const c of result) expect(c.modelInfo.profile.supportsVision).toBe(true)
    })

    it('reuses cached routing decision for similar requests', async () => {
      const body = {
        model: 'auto',
        messages: [{ role: 'user', content: 'running thread turn one' }],
      }
      const first = (await router.selectForChat(body)) as any[]
      const second = (await router.selectForChat(body)) as any[]
      expect(second).not.toBeNull()
      expect(second[0].modelName).toBe(first[0].modelName)
      expect(second[0].nodeHost).toBe(first[0].nodeHost)
    })

    it('does not collide cache entries across different models', async () => {
      const a = (await router.selectForChat({
        model: 'auto',
        messages: [{ role: 'user', content: 'hi' }],
      })) as any[]
      const b = (await router.selectForChat({
        model: 'qwen2.5:1.5b',
        messages: [{ role: 'user', content: 'hi' }],
      })) as any[]
      expect(b[0].modelName).toBe('qwen2.5:1.5b')
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
      }) as any[]
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
      expect(ids).toContain('auto-local')
      expect(ids).not.toContain('auto-cloud')
      expect(ids).toContain('auto-local')
      expect(ids).not.toContain('auto-cloud')
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

  describe('cloud routing', () => {
    it('auto includes cloud candidates', async () => {
      const discovery = makeDiscovery(
        {
          'http://local:11434': {
            'gemma4:e4b': {
              supportsTools: true,
              parameters: 4,
              contextLength: 8192,
            },
          },
          'http://cloud:11434': {
            'gemma4:27b': {
              supportsTools: true,
              parameters: 27,
              contextLength: 128000,
            },
          },
        },
        ['http://cloud:11434'],
      )
      const lm = new LoadManager({ maxConcurrentPerNode: 3 })
      lm.setUnlimited('http://cloud:11434')
      const r = new RequestRouter(discovery, lm)
      const result = (await r.selectForChat({
        model: 'auto',
        messages: [{ role: 'user', content: 'hi' }],
      })) as any[]
      const hosts = result.map((c: any) => c.nodeHost)
      expect(hosts).toContain('http://cloud:11434')
    })

    it('auto-local excludes cloud candidates', async () => {
      const discovery = makeDiscovery(
        {
          'http://local:11434': {
            'gemma4:e4b': {
              supportsTools: true,
              parameters: 4,
              contextLength: 8192,
            },
          },
          'http://cloud:11434': {
            'gemma4:27b': {
              supportsTools: true,
              parameters: 27,
              contextLength: 128000,
            },
          },
        },
        ['http://cloud:11434'],
      )
      const lm = new LoadManager({ maxConcurrentPerNode: 3 })
      lm.setUnlimited('http://cloud:11434')
      const r = new RequestRouter(discovery, lm)
      const result = (await r.selectForChat({
        model: 'auto-local',
        messages: [{ role: 'user', content: 'hi' }],
      })) as any[]
      for (const c of result) expect(c.nodeHost).not.toBe('http://cloud:11434')
    })

    it('auto-local throws 404 when only cloud nodes are available', async () => {
      const discovery = makeDiscovery(
        {
          'http://cloud:11434': {
            'gemma4:27b': {
              supportsTools: true,
              parameters: 27,
              contextLength: 128000,
            },
          },
        },
        ['http://cloud:11434'],
      )
      const lm = new LoadManager({ maxConcurrentPerNode: 3 })
      lm.setUnlimited('http://cloud:11434')
      const r = new RequestRouter(discovery, lm)
      const result = await r.selectForChat({
        model: 'auto-local',
        messages: [{ role: 'user', content: 'hi' }],
      })
      expect(result).toBeNull()
    })

    it('cloud wins auto routing when measured latency and TPS is materially better', async () => {
      const discovery = makeDiscovery(
        {
          'http://local:11434': {
            'gemma4:e4b': {
              supportsTools: true,
              parameters: 4,
              contextLength: 8192,
            },
          },
          'http://cloud:11434': {
            'gemma4:e4b': {
              supportsTools: true,
              parameters: 4,
              contextLength: 8192,
            },
          },
        },
        ['http://cloud:11434'],
        {
          'http://local:11434': {
            'gemma4:e4b': { recentLatency: 5000, recentTps: 3 },
          },
          'http://cloud:11434': {
            'gemma4:e4b': { recentLatency: 150, recentTps: 90 },
          },
        },
      )
      const lm = new LoadManager({ maxConcurrentPerNode: 3 })
      lm.setUnlimited('http://cloud:11434')
      const r = new RequestRouter(discovery, lm)
      const result = (await r.selectForChat({
        model: 'auto',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      })) as any[]
      expect(result[0].nodeHost).toBe('http://cloud:11434')
    })

    it('local wins in near-tie due to cloud cost preference', async () => {
      const discovery = makeDiscovery(
        {
          'http://local:11434': {
            'gemma4:e4b': {
              supportsTools: true,
              parameters: 4,
              contextLength: 8192,
            },
          },
          'http://cloud:11434': {
            'gemma4:e4b': {
              supportsTools: true,
              parameters: 4,
              contextLength: 8192,
            },
          },
        },
        ['http://cloud:11434'],
        {
          'http://local:11434': {
            'gemma4:e4b': { recentLatency: 500, recentTps: 20 },
          },
          'http://cloud:11434': {
            'gemma4:e4b': { recentLatency: 300, recentTps: 25 },
          },
        },
      )
      const lm = new LoadManager({ maxConcurrentPerNode: 3 })
      lm.setUnlimited('http://cloud:11434')
      const r = new RequestRouter(discovery, lm)
      const result = (await r.selectForChat({
        model: 'auto',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      })) as any[]
      expect(result[0].nodeHost).toBe('http://local:11434')
    })

    it('auto-think includes cloud thinking-capable models', async () => {
      const discovery = makeDiscovery(
        {
          'http://local:11434': {
            'small:7b': {
              supportsTools: true,
              supportsThinking: false,
              parameters: 7,
              contextLength: 8192,
            },
          },
          'http://cloud:11434': {
            'think:32b': {
              supportsTools: true,
              supportsThinking: true,
              parameters: 32,
              contextLength: 128000,
            },
          },
        },
        ['http://cloud:11434'],
      )
      const lm = new LoadManager({ maxConcurrentPerNode: 3 })
      lm.setUnlimited('http://cloud:11434')
      const r = new RequestRouter(discovery, lm)
      const result = (await r.selectForChat({
        model: 'auto-think',
        messages: [{ role: 'user', content: 'think hard' }],
      })) as any[]
      expect(result).not.toBeNull()
      expect(result.length).toBeGreaterThan(0)
      for (const c of result)
        expect(c.modelInfo.profile.supportsThinking).toBe(true)
    })
  })

  describe('load penalty', () => {
    it('busy node is penalized and idle node of equal quality is preferred', async () => {
      const discovery = makeDiscovery({
        'http://node-busy:11434': {
          'gemma4:e4b': {
            supportsTools: true,
            parameters: 4,
            contextLength: 8192,
          },
        },
        'http://node-idle:11434': {
          'gemma4:e4b': {
            supportsTools: true,
            parameters: 4,
            contextLength: 8192,
          },
        },
      })
      const lm = new LoadManager({ maxConcurrentPerNode: 3 })
      lm.incrementLoad('http://node-busy:11434')
      lm.incrementLoad('http://node-busy:11434') // utilisation = 2/3
      const r = new RequestRouter(discovery, lm)
      const result = (await r.selectForChat({
        model: 'auto',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      })) as any[]
      expect(result[0].nodeHost).toBe('http://node-idle:11434')
    })

    it('saturated node is excluded entirely regardless of model quality', async () => {
      const discovery = makeDiscovery({
        'http://node-full:11434': {
          'gemma4:27b': {
            supportsTools: true,
            parameters: 27,
            contextLength: 128000,
          },
        },
        'http://node-free:11434': {
          'gemma4:e4b': {
            supportsTools: true,
            parameters: 4,
            contextLength: 8192,
          },
        },
      })
      const lm = new LoadManager({ maxConcurrentPerNode: 3 })
      lm.incrementLoad('http://node-full:11434')
      lm.incrementLoad('http://node-full:11434')
      lm.incrementLoad('http://node-full:11434') // at hard cap
      const r = new RequestRouter(discovery, lm)
      const result = (await r.selectForChat({
        model: 'auto',
        messages: [{ role: 'user', content: 'hi' }],
      })) as any[]
      for (const c of result)
        expect(c.nodeHost).not.toBe('http://node-full:11434')
    })
  })

  describe('warm-model affinity', () => {
    it('recently routed model gets warm bonus over cold model on same node', async () => {
      const now = Date.now()
      const discovery = makeDiscovery(
        {
          'http://node-a:11434': {
            'model-warm': {
              supportsTools: true,
              parameters: 7,
              contextLength: 8192,
            },
            'model-cold': {
              supportsTools: true,
              parameters: 7,
              contextLength: 8192,
            },
          },
        },
        [],
        {
          'http://node-a:11434': {
            'model-warm': { lastRoutedAt: now - 60_000 }, // 1 min ago
            'model-cold': { lastRoutedAt: 0 },
          },
        },
      )
      const lm = new LoadManager({ maxConcurrentPerNode: 3 })
      const r = new RequestRouter(discovery, lm)
      const result = (await r.selectForChat({
        model: 'auto',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      })) as any[]
      expect(result[0].modelName).toBe('model-warm')
    })

    it('warm model on one node beats same model on cold node', async () => {
      const now = Date.now()
      const discovery = makeDiscovery(
        {
          'http://node-warm:11434': {
            'gemma4:e4b': {
              supportsTools: true,
              parameters: 4,
              contextLength: 8192,
            },
          },
          'http://node-cold:11434': {
            'gemma4:e4b': {
              supportsTools: true,
              parameters: 4,
              contextLength: 8192,
            },
          },
        },
        [],
        {
          'http://node-warm:11434': {
            'gemma4:e4b': { lastRoutedAt: now - 30_000 },
          }, // 30s ago
          'http://node-cold:11434': { 'gemma4:e4b': { lastRoutedAt: 0 } },
        },
      )
      const lm = new LoadManager({ maxConcurrentPerNode: 3 })
      const r = new RequestRouter(discovery, lm)
      const result = (await r.selectForChat({
        model: 'auto',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      })) as any[]
      expect(result[0].nodeHost).toBe('http://node-warm:11434')
    })

    it('switch penalty applies when a different model is warm on the same node', async () => {
      const now = Date.now()
      const discovery = makeDiscovery(
        {
          'http://node-a:11434': {
            'model-hot': {
              supportsTools: true,
              parameters: 7,
              contextLength: 8192,
            },
            'model-needs-load': {
              supportsTools: true,
              parameters: 7,
              contextLength: 8192,
            },
          },
          'http://node-b:11434': {
            'model-needs-load': {
              supportsTools: true,
              parameters: 7,
              contextLength: 8192,
            },
          },
        },
        [],
        {
          'http://node-a:11434': {
            'model-hot': { lastRoutedAt: now - 60_000 }, // warm on node-a
            'model-needs-load': { lastRoutedAt: 0 }, // cold — would need eviction
          },
          'http://node-b:11434': {
            'model-needs-load': { lastRoutedAt: 0 }, // cold but no eviction needed
          },
        },
      )
      const lm = new LoadManager({ maxConcurrentPerNode: 3 })
      const r = new RequestRouter(discovery, lm)
      // Requesting model-needs-load: node-b should win because node-a needs to evict model-hot first
      const result = (await r.selectForChat({
        model: 'model-needs-load',
        messages: [{ role: 'user', content: 'hi' }],
      })) as any[]
      expect(result[0].nodeHost).toBe('http://node-b:11434')
    })
  })
})
