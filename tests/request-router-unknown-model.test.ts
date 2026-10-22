import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals'
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
    const node = new NodeInfo(host, false)
    node.reachable = true
    for (const [name, profileData] of Object.entries(models)) {
      node.models.set(name, new ModelInfo(name, 'test', 1e9, new ModelProfile(profileData)))
    }
    dm.inventory.set(host, node)
  }
  return dm
}

const BASE_NODES = {
  'http://node-a:11434': {
    'gemma4:e4b': { supportsTools: true, parameters: 4.5, contextLength: 128000 },
  },
  'http://node-b:11434': {
    'nomic-embed-text:latest': { isEmbedding: true, parameters: 0.1, contextLength: 8192 },
  },
}

/**
 * Enable fallback-to-auto on a router instance without touching the module-level
 * ROUTER_FALLBACK_TO_AUTO const (which is frozen at import time in ESM Jest).
 * We replace _selectCandidates with a wrapper that catches MODEL_NOT_FOUND and
 * re-routes through _selectVirtual('auto', ...) — exactly what the real impl does
 * when ROUTER_FALLBACK_TO_AUTO=true.
 */
function enableFallback(router: RequestRouter): void {
  const original = (router as any)._selectCandidates.bind(router)
  ;(router as any)._selectCandidates = function (
    model: string,
    analysis: unknown,
    reqBody: Record<string, unknown>,
  ) {
    try {
      return original(model, analysis, reqBody)
    } catch (err: any) {
      if (err?.code === 'MODEL_NOT_FOUND') {
        return (router as any)._selectVirtual('auto', analysis, Boolean(reqBody?.stream))
      }
      throw err
    }
  }
}

describe('Unknown model — cancel and fallback', () => {
  let loadManager: LoadManager

  beforeEach(() => {
    loadManager = new LoadManager({ maxConcurrentPerNode: 3 })
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  // ── Abort signal ──────────────────────────────────────────────────────────

  describe('abort signal', () => {
    it('returns null when signal already aborted — selectForChat', async () => {
      const router = new RequestRouter(makeDiscovery(BASE_NODES), loadManager)
      const ctrl = new AbortController()
      ctrl.abort()
      expect(await router.selectForChat({ model: 'auto', messages: [] }, ctrl.signal)).toBeNull()
    })

    it('returns null when signal already aborted — selectForEmbeddings', async () => {
      const router = new RequestRouter(makeDiscovery(BASE_NODES), loadManager)
      const ctrl = new AbortController()
      ctrl.abort()
      expect(await router.selectForEmbeddings({ model: 'auto', input: 'hi' }, ctrl.signal)).toBeNull()
    })

    it('returns null when signal already aborted — selectForResponses', async () => {
      const router = new RequestRouter(makeDiscovery(BASE_NODES), loadManager)
      const ctrl = new AbortController()
      ctrl.abort()
      expect(await router.selectForResponses({ model: 'auto', input: 'hi' }, ctrl.signal)).toBeNull()
    })

    it('resolves normally when signal is live', async () => {
      const router = new RequestRouter(makeDiscovery(BASE_NODES), loadManager)
      const result = await router.selectForChat(
        { model: 'auto', messages: [{ role: 'user', content: 'hi' }] },
        new AbortController().signal,
      )
      expect(result).not.toBeNull()
    })
  })

  // ── MODEL_NOT_FOUND — fallback disabled ───────────────────────────────────

  describe('MODEL_NOT_FOUND — fallback disabled (default)', () => {
    it('throws 404 for unknown chat model', async () => {
      const router = new RequestRouter(makeDiscovery(BASE_NODES), loadManager)
      await expect(
        router.selectForChat({ model: 'ghost-model:7b', messages: [] }),
      ).rejects.toMatchObject({ statusCode: 404, code: 'MODEL_NOT_FOUND' })
    })

    it('throws 404 for unknown embedding model', async () => {
      const router = new RequestRouter(makeDiscovery(BASE_NODES), loadManager)
      await expect(
        router.selectForEmbeddings({ model: 'ghost-embed:latest', input: 'x' }),
      ).rejects.toMatchObject({ statusCode: 404, code: 'MODEL_NOT_FOUND' })
    })
  })

  // ── MODEL_NOT_FOUND — fallback enabled ────────────────────────────────────

  describe('MODEL_NOT_FOUND — fallback enabled', () => {
    it('returns auto candidate instead of throwing for unknown chat model', async () => {
      const router = new RequestRouter(makeDiscovery(BASE_NODES), loadManager)
      enableFallback(router)

      const result = await router.selectForChat(
        { model: 'ghost-model:7b', messages: [{ role: 'user', content: 'hi' }] },
      )
      expect(result).not.toBeNull()
      const candidates = Array.isArray(result) ? result : [result]
      expect(candidates.length).toBeGreaterThan(0)
      for (const c of candidates) expect((c as any).modelName).not.toBe('ghost-model:7b')
    })

    it('returns embedding candidate for unknown embed model', async () => {
      const router = new RequestRouter(makeDiscovery(BASE_NODES), loadManager)
      enableFallback(router)

      const result = await router.selectForEmbeddings(
        { model: 'ghost-embed:latest', input: 'hello' },
      )
      expect(result).not.toBeNull()
      const candidates = Array.isArray(result) ? result : [result]
      expect(candidates.length).toBeGreaterThan(0)
      for (const c of candidates) {
        expect((c as any).modelName).not.toBe('ghost-embed:latest')
        expect((c as any).modelInfo.profile.isEmbedding).toBe(true)
      }
    })

    it('returns null (not throw) when fallback pool is empty', async () => {
      const router = new RequestRouter(makeDiscovery({ 'http://empty:11434': {} }), loadManager)
      enableFallback(router)

      const result = await router.selectForChat(
        { model: 'ghost-model:7b', messages: [{ role: 'user', content: 'hi' }] },
      )
      expect(result).toBeNull()
    })
  })
})
