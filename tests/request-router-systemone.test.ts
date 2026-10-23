// request-router-systemone.test.ts — /v1/systemone routes ONLY decision models
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

describe('selectForSystemone', () => {
  let loadManager: LoadManager
  let router: RequestRouter

  beforeEach(() => {
    loadManager = new LoadManager({ maxConcurrentPerNode: 3 })
    // node-a mixes regular chat models with a decision-capable one; node-b
    // only has a decision model, proving cross-node eligibility filtering.
    const discovery = makeDiscovery({
      'http://node-a:11434': {
        'gemma4:e4b': {
          supportsTools: true, supportsThinking: true,
          parameters: 4.5, contextLength: 128000,
        },
        'decision-base:2b': {
          supportsDecision: true, parameters: 2, contextLength: 8192,
        },
      },
      'http://node-b:11434': {
        'decision-base:2b': {
          supportsDecision: true, parameters: 2, contextLength: 8192,
        },
      },
    })
    router = new RequestRouter(discovery, loadManager)
  })

  it('routes auto to decision-capable models only', async () => {
    const result = await router.selectForSystemone({
      model: 'auto',
      state: { input: 'x' },
      questions: [{ id: 'q1', type: 'choice' }],
    }) as any[]
    expect(Array.isArray(result)).toBe(true)
    expect(result.length).toBeGreaterThan(0)
    for (const c of result) {
      expect(c.modelInfo.profile.supportsDecision).toBe(true)
    }
    expect(result.map((c) => c.modelName)).toEqual(
      expect.arrayContaining(['decision-base:2b']),
    )
    expect(result.map((c) => c.modelName)).not.toContain('gemma4:e4b')
  })

  it('rejects an explicit non-decision model with MODEL_NOT_DECISION', async () => {
    await expect(
      router.selectForSystemone({
        model: 'gemma4:e4b',
        state: { input: 'x' },
        questions: [{ id: 'q1', type: 'choice' }],
      }),
    ).rejects.toMatchObject({
      code: 'MODEL_NOT_DECISION',
      statusCode: 400,
    })
  })

  it('routes an explicit decision model to its nodes', async () => {
    const result = await router.selectForSystemone({
      model: 'decision-base:2b',
      state: { input: 'x' },
      questions: [{ id: 'q1', type: 'choice' }],
    }) as any[]
    expect(Array.isArray(result)).toBe(true)
    expect(result.length).toBeGreaterThan(0)
    for (const c of result) {
      expect(c.modelName).toBe('decision-base:2b')
      expect(c.nodeHost).toMatch(/^http:\/\/node-[ab]:11434$/)
    }
  })

  it('returns null when no decision models exist on any node', async () => {
    const discovery = makeDiscovery({
      'http://node-a:11434': {
        'gemma4:e4b': { supportsThinking: true, parameters: 4.5, contextLength: 128000 },
      },
    })
    const chatOnlyRouter = new RequestRouter(discovery, loadManager)
    const result = await chatOnlyRouter.selectForSystemone({
      model: 'auto',
      state: { input: 'x' },
      questions: [{ id: 'q1', type: 'choice' }],
    })
    expect(result).toBeNull()
  })
})

describe('selectForChat (decision capability isolation)', () => {
  it('never routes chat traffic to decision models', async () => {
    const loadManager = new LoadManager({ maxConcurrentPerNode: 3 })
    const discovery = makeDiscovery({
      'http://node-a:11434': {
        'gemma4:e4b': { supportsThinking: true, parameters: 4.5, contextLength: 128000 },
        'decision-base:2b': { supportsDecision: true, parameters: 2, contextLength: 8192 },
      },
    })
    const router = new RequestRouter(discovery, loadManager)
    const result = await router.selectForChat({
      model: 'auto',
      messages: [{ role: 'user', content: 'hi' }],
    }) as any[]
    expect(Array.isArray(result)).toBe(true)
    expect(result.length).toBeGreaterThan(0)
    for (const c of result) {
      expect(c.modelInfo.profile.supportsDecision).toBe(false)
    }
  })
})
