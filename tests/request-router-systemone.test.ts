// request-router-systemone.test.ts — /v1/systemone routes ONLY decision models
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals'
import type { Response } from 'express'
import { RequestRouter } from '../src/request-router.js'
import { maxChoiceCriteria } from '../src/request-router.js'
import { parseCriteriaCap, selectCandidatesOrHandleError } from '../src/routes/request-helpers.js'
import { LoadManager } from '../src/load-manager.js'
import { DiscoveryManager } from '../src/discovery-manager.js'
import { RequestHistoryManager } from '../src/request-history.js'
import { createLogger } from '../src/logger.js'
import { disabledModelsStore } from '../src/disabled-models-store.js'
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

  it('rejects an explicit decision model when its learned cap is too small', async () => {
    const router = routerWithCap(26)
    const select = jest.spyOn(router as unknown as { _selectCandidates: () => unknown }, '_selectCandidates')
    await expect(router.selectForSystemone({ model: 'decision-base:2b', questions: questions(27) })).rejects.toMatchObject({
      code: 'CRITERIA_LIMIT', statusCode: 400,
      message: 'Decision model decision-base:2b accepts at most 26 criteria per question; this request has 27',
    })
    expect(select).not.toHaveBeenCalled()
    select.mockRestore()
  })

  it('rejects an oversized request before selecting or waking an offline host', async () => {
    const router = routerWithCap(26)
    const node = router.discovery.inventory.get('http://node-a:11434')!
    node.reachable = false
    node.mac = 'aa:bb:cc:dd:ee:ff'
    const wake = jest.spyOn(router.discovery, 'tryWakeNodesForRequest').mockReturnValue(false)
    const select = jest.spyOn(router as unknown as { _selectCandidates: () => unknown }, '_selectCandidates')
    await expect(router.selectForSystemone({ model: 'decision-base:2b', questions: questions(27) })).rejects.toMatchObject({
      code: 'CRITERIA_LIMIT', statusCode: 400,
    })
    expect(select).not.toHaveBeenCalled()
    expect(wake).not.toHaveBeenCalled()
    select.mockRestore()
    wake.mockRestore()
  })

  it('uses the largest known cap for the same model across reachable and offline nodes', async () => {
    const hostA = 'http://node-a:11434'
    const hostB = 'http://node-b:11434'
    const model = 'decision-base:2b'
    const discovery = makeDiscovery({
      [hostA]: { [model]: { supportsDecision: true } },
      [hostB]: { [model]: { supportsDecision: true } },
    })
    const nodeA = discovery.inventory.get(hostA)!
    const nodeB = discovery.inventory.get(hostB)!
    nodeA.models.get(model)!.systemoneMaxCriteria = 26
    nodeB.models.get(model)!.systemoneMaxCriteria = 40
    nodeB.reachable = false
    const router = new RequestRouter(discovery, new LoadManager())
    const wake = jest.spyOn(discovery, 'tryWakeNodesForRequest').mockReturnValue(false)
    await expect(router.selectForSystemone({ model, questions: questions(41) })).rejects.toMatchObject({
      code: 'CRITERIA_LIMIT', statusCode: 400,
      message: `Decision model ${model} accepts at most 40 criteria per question; this request has 41`,
    })
    await expect(router.selectForSystemone({ model, questions: questions(30) })).resolves.toEqual([
      expect.objectContaining({ nodeHost: hostA, modelName: model }),
    ])
    expect(wake).not.toHaveBeenCalled()
    nodeB.reachable = true
    await expect(router.selectForSystemone({ model, questions: questions(40) })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeHost: hostA, modelName: model }),
      expect.objectContaining({ nodeHost: hostB, modelName: model }),
    ]))
    wake.mockRestore()
  })

  it('does not apply a cap belonging only to a non-decision model', async () => {
    const discovery = makeDiscovery({ 'http://node-a:11434': { 'chat:2b': {} } })
    discovery.inventory.get('http://node-a:11434')!.models.get('chat:2b')!.systemoneMaxCriteria = 2
    const router = new RequestRouter(discovery, new LoadManager())
    await expect(router.selectForSystemone({ model: 'chat:2b', questions: questions(3) })).rejects.toMatchObject({
      code: 'MODEL_NOT_DECISION', statusCode: 400,
    })
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

  it('rejects an unknown explicit decision model with MODEL_NOT_FOUND', async () => {
    await expect(router.selectForSystemone({ model: 'missing:2b' })).rejects.toMatchObject({
      code: 'MODEL_NOT_FOUND',
      statusCode: 404,
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

describe('concrete model wake fallback', () => {
  const host = 'http://192.168.1.10:11434'
  const model = 'decision-base:2b'

  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
    disabledModelsStore.reset()
  })

  it('wakes an offline decision host and keeps polling until it becomes reachable', async () => {
    jest.useFakeTimers()
    const discovery = makeDiscovery({
      [host]: { [model]: { supportsDecision: true, parameters: 2, contextLength: 8192 } },
    })
    const node = discovery.inventory.get(host)!
    node.reachable = false
    node.mac = 'aa:bb:cc:dd:ee:ff'
    const wake = jest.spyOn(discovery as unknown as { _triggerWol: (host: string, mac: string) => void }, '_triggerWol').mockImplementation(() => {})
    const router = new RequestRouter(discovery, new LoadManager())
    const selection = router.selectForSystemone({ model })
    let settled = false
    void selection.then(() => { settled = true }, () => { settled = true })

    await jest.advanceTimersByTimeAsync(2000)
    expect(wake).toHaveBeenCalledTimes(1)
    expect(wake).toHaveBeenCalledWith(host, node.mac)
    expect(settled).toBe(false)
    node.reachable = true
    await jest.advanceTimersByTimeAsync(1000)
    await expect(selection).resolves.toEqual([
      expect.objectContaining({ nodeHost: host, modelName: model }),
    ])
  })

  it('responds 503 and finishes request history when a decision host never wakes', async () => {
    jest.useFakeTimers()
    const discovery = makeDiscovery({ [host]: { [model]: { supportsDecision: true } } })
    const node = discovery.inventory.get(host)!
    node.reachable = false
    node.mac = 'aa:bb:cc:dd:ee:ff'
    const wake = jest.spyOn(discovery as unknown as { _triggerWol: (host: string, mac: string) => void }, '_triggerWol').mockImplementation(() => {})
    const router = new RequestRouter(discovery, new LoadManager())
    const history = new RequestHistoryManager()
    const reqBody = { model }
    history.startRequest({ requestId: 'offline', endpointType: 'systemone', reqBody, analysis: {} })
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    }
    const selection = selectCandidatesOrHandleError({
      requestId: 'offline', reqBody, taskType: 'systemone', res: res as unknown as Response,
      requestHistoryManager: history,
      selectFn: (body) => router.selectForSystemone(body),
      selectionErrorMessage: 'Systemone model selection error',
      logger: createLogger('test'),
    })

    await jest.advanceTimersByTimeAsync(30_000)
    await expect(selection).resolves.toBeNull()
    expect(wake).toHaveBeenCalledTimes(1)
    expect(wake).toHaveBeenCalledWith(host, node.mac)
    expect(res.status).toHaveBeenCalledWith(503)
    const message = `No node can serve decision model ${model} right now`
    expect(res.json).toHaveBeenCalledWith({ error: message })
    expect(history.getRecentRequests()[0]).toMatchObject({
      status: 'failed', responseStatus: 503, error: message,
      failureCategory: 'capacity', retryHint: 'retry_later',
    })
  })

  it('rejects an offline non-decision model without waking its host', async () => {
    const discovery = makeDiscovery({ [host]: { [model]: { supportsDecision: false } } })
    const node = discovery.inventory.get(host)!
    node.reachable = false
    node.mac = 'aa:bb:cc:dd:ee:ff'
    const wake = jest.spyOn(discovery, 'tryWakeNodesForRequest').mockReturnValue(false)
    const router = new RequestRouter(discovery, new LoadManager())
    await expect(router.selectForSystemone({ model })).rejects.toMatchObject({
      code: 'MODEL_NOT_DECISION', statusCode: 400,
    })
    expect(wake).not.toHaveBeenCalled()
  })

  it('recognizes decision capability on a later node with the same model name', async () => {
    const discovery = makeDiscovery({
      'http://node-a:11434': { [model]: { supportsDecision: false } },
      [host]: { [model]: { supportsDecision: true } },
    })
    discovery.inventory.get(host)!.reachable = false
    const wake = jest.spyOn(discovery, 'tryWakeNodesForRequest').mockReturnValue(false)
    const router = new RequestRouter(discovery, new LoadManager())
    await expect(router.selectForSystemone({ model })).rejects.toMatchObject({
      code: 'MODEL_UNAVAILABLE', statusCode: 503,
      message: `No node can serve decision model ${model} right now`,
    })
    expect(wake).toHaveBeenCalledTimes(1)
  })

  it('reports the decision model as unavailable when it is at capacity or disabled', async () => {
    const discovery = makeDiscovery({ [host]: { [model]: { supportsDecision: true } } })
    const load = new LoadManager({ maxConcurrentPerNode: 1 })
    const router = new RequestRouter(discovery, load)
    load.incrementLoad(host)
    const unavailable = { code: 'MODEL_UNAVAILABLE', statusCode: 503, message: `No node can serve decision model ${model} right now` }
    await expect(router.selectForSystemone({ model })).rejects.toMatchObject(unavailable)
    load.decrementLoad(host)
    disabledModelsStore.disable(host, model)
    await expect(router.selectForSystemone({ model })).rejects.toMatchObject(unavailable)
  })

  it('returns null instead of an availability error when aborted during the wake wait', async () => {
    jest.useFakeTimers()
    const discovery = makeDiscovery({ [host]: { [model]: { supportsDecision: true } } })
    const node = discovery.inventory.get(host)!
    node.reachable = false
    node.mac = 'aa:bb:cc:dd:ee:ff'
    const wake = jest.spyOn(discovery as unknown as { _triggerWol: (host: string, mac: string) => void }, '_triggerWol').mockImplementation(() => {})
    const router = new RequestRouter(discovery, new LoadManager())
    const controller = new AbortController()
    const selection = router.selectForSystemone({ model }, controller.signal)
    await jest.advanceTimersByTimeAsync(1000)
    expect(wake).toHaveBeenCalledTimes(1)
    controller.abort()
    await jest.advanceTimersByTimeAsync(1000)
    await expect(selection).resolves.toBeNull()
  })

  it('wakes only the decision host for a systemone auto request', async () => {
    jest.useFakeTimers()
    const chatHost = 'http://192.168.1.11:11434'
    const discovery = makeDiscovery({
      [chatHost]: { 'chat:2b': { parameters: 2, contextLength: 8192 } },
      [host]: { [model]: { supportsDecision: true, parameters: 2, contextLength: 8192 } },
    })
    const chatNode = discovery.inventory.get(chatHost)!
    chatNode.reachable = false
    chatNode.mac = 'aa:bb:cc:dd:ee:01'
    const decisionNode = discovery.inventory.get(host)!
    decisionNode.reachable = false
    decisionNode.mac = 'aa:bb:cc:dd:ee:02'
    const wake = jest.spyOn(discovery as unknown as { _triggerWol: (host: string, mac: string) => void }, '_triggerWol').mockImplementation(() => {})
    const router = new RequestRouter(discovery, new LoadManager())
    const selection = router.selectForSystemone({ model: 'auto' })
    await jest.advanceTimersByTimeAsync(1000)
    expect(wake).toHaveBeenCalledTimes(1)
    expect(wake).toHaveBeenCalledWith(host, decisionNode.mac)
    decisionNode.reachable = true
    await jest.advanceTimersByTimeAsync(1000)
    await expect(selection).resolves.toEqual([
      expect.objectContaining({ nodeHost: host, modelName: model }),
    ])
  })

  it('rejects chat naming a sleeping decision model without waking it', async () => {
    jest.useFakeTimers()
    const discovery = makeDiscovery({ [host]: { [model]: { supportsDecision: true } } })
    const node = discovery.inventory.get(host)!
    node.reachable = false
    node.mac = 'aa:bb:cc:dd:ee:ff'
    const wake = jest.spyOn(discovery as unknown as { _triggerWol: (host: string, mac: string) => void }, '_triggerWol').mockImplementation(() => {})
    const router = new RequestRouter(discovery, new LoadManager())
    const selection = router.selectForChat({ model, messages: [] })
    void selection.catch(() => {})
    await jest.advanceTimersByTimeAsync(30_000)
    await expect(selection).rejects.toMatchObject({
      code: 'MODEL_NOT_DECISION', statusCode: 400,
      message: `Model ${model} is a decision model — decision requests must use /v1/systemone`,
    })
    expect(wake).not.toHaveBeenCalled()
  })

  it('rejects chat naming a decision model that is at capacity or disabled', async () => {
    const discovery = makeDiscovery({ [host]: { [model]: { supportsDecision: true } } })
    const load = new LoadManager({ maxConcurrentPerNode: 1 })
    const router = new RequestRouter(discovery, load)
    const wrongType = { code: 'MODEL_NOT_DECISION', statusCode: 400 }
    load.incrementLoad(host)
    await expect(router.selectForChat({ model, messages: [] })).rejects.toMatchObject(wrongType)
    load.decrementLoad(host)
    disabledModelsStore.disable(host, model)
    await expect(router.selectForChat({ model, messages: [] })).rejects.toMatchObject(wrongType)
  })

  it('wakes an offline host for an explicitly named normal chat model', async () => {
    jest.useFakeTimers()
    const chatModel = 'chat:2b'
    const discovery = makeDiscovery({ [host]: { [chatModel]: { parameters: 2, contextLength: 8192 } } })
    const node = discovery.inventory.get(host)!
    node.reachable = false
    node.mac = 'aa:bb:cc:dd:ee:ff'
    const wake = jest.spyOn(discovery as unknown as { _triggerWol: (host: string, mac: string) => void }, '_triggerWol').mockImplementation(() => {})
    const router = new RequestRouter(discovery, new LoadManager())
    const selection = router.selectForChat({ model: chatModel, messages: [] })

    await jest.advanceTimersByTimeAsync(1000)
    expect(wake).toHaveBeenCalledTimes(1)
    expect(wake).toHaveBeenCalledWith(host, node.mac)
    node.reachable = true
    await jest.advanceTimersByTimeAsync(1000)
    await expect(selection).resolves.toEqual([
      expect.objectContaining({ nodeHost: host, modelName: chatModel }),
    ])
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

  it('rejects an explicit chat request naming a decision model with MODEL_NOT_DECISION', async () => {
    const loadManager = new LoadManager({ maxConcurrentPerNode: 3 })
    const discovery = makeDiscovery({
      'http://node-a:11434': {
        'gemma4:e4b': { supportsThinking: true, parameters: 4.5, contextLength: 128000 },
        'decision-base:2b': { supportsDecision: true, parameters: 2, contextLength: 8192 },
      },
    })
    const router = new RequestRouter(discovery, loadManager)
    await expect(
      router.selectForChat({
        model: 'decision-base:2b',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toMatchObject({
      code: 'MODEL_NOT_DECISION',
      statusCode: 400,
    })
  })
})
