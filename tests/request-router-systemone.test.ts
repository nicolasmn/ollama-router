// request-router-systemone.test.ts — /v1/systemone routes ONLY decision models
import { describe, it, expect, beforeEach, jest } from '@jest/globals'
import { RequestRouter } from '../src/request-router.js'
import { maxChoiceCriteria } from '../src/request-router.js'
import { parseCriteriaCap } from '../src/routes/request-helpers.js'
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

describe('systemone criteria-cap filtering (learned from upstream 400s)', () => {
  const questions = (n: number) => ({
    q: {
      type: 'choice',
      instructions: 'Pick one',
      criteria: Object.fromEntries(Array.from({ length: n }, (_, i) => [`c${i}`, `Option ${i}`])),
    },
  })

  function routerWithCap(cap: number): RequestRouter {
    const loadManager = new LoadManager({ maxConcurrentPerNode: 3 })
    const discovery = makeDiscovery({
      'http://node-a:11434': {
        'decision-base:2b': { supportsDecision: true, parameters: 2, contextLength: 8192 },
      },
    })
    for (const node of discovery.getNodes().values()) {
      for (const info of node.models.values()) info.systemoneMaxCriteria = cap
    }
    return new RequestRouter(discovery, loadManager)
  }

  it('skips a model whose learned cap cannot fit the request', async () => {
    const router = routerWithCap(26)
    const result = await router.selectForSystemone({ model: 'auto', state: {}, questions: questions(27) })
    expect(result).toBeNull()
    // Small enough to fit → still routed.
    const fits = await router.selectForSystemone({ model: 'auto', state: {}, questions: questions(26) })
    expect(fits?.length).toBeGreaterThan(0)
  })

  it('routes normally when the cap is unknown (0)', async () => {
    const router = routerWithCap(0)
    const result = await router.selectForSystemone({ model: 'auto', state: {}, questions: questions(27) })
    expect(result?.length).toBeGreaterThan(0)
  })

  it('parseCriteriaCap extracts the cap from upstream 400 messages', () => {
    expect(parseCriteriaCap('question "next": criteria must contain 2\u201326 candidates')).toBe(26)
    expect(parseCriteriaCap('criteria must contain 2-26 candidates')).toBe(26)
    expect(parseCriteriaCap('questions must contain 1\u201364 fields')).toBeNull()
    expect(parseCriteriaCap('Value looks like object')).toBeNull()
  })

  it('maxChoiceCriteria reads the largest criteria set from the body', () => {
    expect(maxChoiceCriteria({ questions: questions(27) })).toBe(27)
    expect(maxChoiceCriteria({ questions: [{ criteria: ['a', 'b', 'c'] }] })).toBe(3)
    expect(maxChoiceCriteria({})).toBe(0)
    expect(maxChoiceCriteria(undefined)).toBe(0)
  })
})

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

  it('returns null when no decision models exist on any node', async () => {    const discovery = makeDiscovery({
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
