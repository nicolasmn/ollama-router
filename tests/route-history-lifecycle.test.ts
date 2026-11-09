/**
 * route-history-lifecycle.test.ts
 *
 * Verifies that RequestHistoryManager.finishRequest is called (entry leaves
 * "waiting" state) for every early-exit path in the route handlers:
 *   - MODEL_NOT_FOUND (unknown concrete model)
 *   - no candidates (empty inventory)
 *
 * Uses Node's built-in http module to avoid a supertest dependency.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals'
import http from 'node:http'
import express from 'express'
import { RequestRouter } from '../src/request-router.js'
import { LoadManager } from '../src/load-manager.js'
import { DiscoveryManager } from '../src/discovery-manager.js'
import { RequestHistoryManager } from '../src/request-history.js'
import { NodeInfo, ModelInfo, ModelProfile } from '../src/models.js'
import type { ModelProfileData } from '../src/models.js'
import { setupChatRoutes } from '../src/routes/chat.js'
import { setupEmbeddingsRoutes } from '../src/routes/embeddings.js'
import { setupResponsesRoutes } from '../src/routes/responses.js'
import { setupSystemoneRoutes } from '../src/routes/systemone.js'

function makeDiscovery(nodes: Record<string, Record<string, ModelProfileData>>): DiscoveryManager {
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

function makeApp(
  discovery: DiscoveryManager,
  loadManager: LoadManager,
  requestHistoryManager: RequestHistoryManager,
) {
  const app = express()
  app.use(express.json())
  const router = new RequestRouter(discovery, loadManager)
  setupChatRoutes(app, discovery, loadManager, router, requestHistoryManager)
  setupEmbeddingsRoutes(app, discovery, loadManager, router, requestHistoryManager)
  setupResponsesRoutes(app, discovery, loadManager, router, requestHistoryManager)
  setupSystemoneRoutes(app, discovery, loadManager, router, requestHistoryManager)
  return app
}

function post(server: http.Server, path: string, body: unknown): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const addr = server.address() as { port: number }
    const req = http.request(
      { hostname: '127.0.0.1', port: addr.port, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        let raw = ''
        res.on('data', (chunk) => { raw += chunk })
        res.on('end', () => {
          try { resolve({ status: res.statusCode ?? 0, data: JSON.parse(raw) }) }
          catch { resolve({ status: res.statusCode ?? 0, data: raw }) }
        })
      },
    )
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

function listen(app: express.Application): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer(app)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

const BASE_NODES = {
  'http://node-a:11434': {
    'gemma4:e4b': { supportsTools: true, parameters: 4.5, contextLength: 128000 },
  },
  'http://node-b:11434': {
    'nomic-embed-text:latest': { isEmbedding: true, parameters: 0.1, contextLength: 8192 },
  },
}

describe('Route history lifecycle — finishRequest on early exit', () => {
  let loadManager: LoadManager
  let history: RequestHistoryManager

  beforeEach(() => {
    loadManager = new LoadManager({ maxConcurrentPerNode: 3 })
    history = new RequestHistoryManager({ limit: 20 })
  })

  function lastEntry() {
    return history.getRecentRequests()[0]
  }

  // ── MODEL_NOT_FOUND ────────────────────────────────────────────────────────

  describe('MODEL_NOT_FOUND', () => {
    it.each([
      { model: 'gemma4:e4b', status: 400, category: 'wrong_model_type' },
      { model: 'ghost:7b', status: 404, category: 'model_not_found' },
    ])('systemone: $model returns $status and preserves its history classification', async ({ model, status, category }) => {
      const server = await listen(makeApp(makeDiscovery(BASE_NODES), loadManager, history))
      try {
        const res = await post(server, '/v1/systemone', { model, state: {}, questions: [] })
        expect(res.status).toBe(status)
        expect(lastEntry()).toMatchObject({
          status: 'failed', responseStatus: status, failureCategory: category, retryHint: 'no_retry',
        })
      } finally { await close(server) }
    })

    it('chat: entry is finished with status=failed after 404', async () => {
      const server = await listen(makeApp(makeDiscovery(BASE_NODES), loadManager, history))
      try {
        const res = await post(server, '/v1/chat/completions', { model: 'ghost:7b', messages: [{ role: 'user', content: 'hi' }] })
        expect(res.status).toBe(404)
        const entry = lastEntry()
        expect(entry).toBeDefined()
        expect(entry.status).toBe('failed')
        expect(entry.finishedAt).toBeGreaterThan(0)
        expect(entry.responseStatus).toBe(404)
      } finally { await close(server) }
    })

    it('embeddings: entry is finished with status=failed after 404', async () => {
      const server = await listen(makeApp(makeDiscovery(BASE_NODES), loadManager, history))
      try {
        const res = await post(server, '/v1/embeddings', { model: 'ghost-embed:latest', input: 'hello' })
        expect(res.status).toBe(404)
        const entry = lastEntry()
        expect(entry).toBeDefined()
        expect(entry.status).toBe('failed')
        expect(entry.finishedAt).toBeGreaterThan(0)
        expect(entry.responseStatus).toBe(404)
      } finally { await close(server) }
    })

    it('responses: entry is finished with status=failed after 404', async () => {
      const server = await listen(makeApp(makeDiscovery(BASE_NODES), loadManager, history))
      try {
        const res = await post(server, '/v1/responses', { model: 'ghost:7b', input: 'hi' })
        expect(res.status).toBe(404)
        const entry = lastEntry()
        expect(entry).toBeDefined()
        expect(entry.status).toBe('failed')
        expect(entry.finishedAt).toBeGreaterThan(0)
        expect(entry.responseStatus).toBe(404)
      } finally { await close(server) }
    })
  })

  describe('systemone criteria limits', () => {
    const model = 'decision:2b'
    const upstreamMessage = 'question "next": criteria must contain 2–2 candidates'
    const body = { model, state: {}, questions: [{ criteria: ['a', 'b', 'c'] }] }
    const routerMessage = `Decision model ${model} accepts at most 2 criteria per question; this request has 3`

    it.each([
      { kind: 'JSON error', detail: JSON.stringify({ error: upstreamMessage }) },
      { kind: 'raw detail', detail: upstreamMessage },
      { kind: 'escaped JSON error', detail: JSON.stringify({ error: upstreamMessage }).replace('–', '\\u2013') },
      { kind: 'JSON without an error field', detail: JSON.stringify({ detail: upstreamMessage }) },
    ])('passes through $kind and rejects the next request without reaching the upstream', async ({ kind, detail }) => {
      let upstreamCalls = 0
      const upstreamApp = express()
      upstreamApp.post('/v1/systemone', (_req, res) => {
        upstreamCalls++
        res.status(400).send(detail)
      })
      const upstream = await listen(upstreamApp)
      const host = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`
      const discovery = makeDiscovery({ [host]: { [model]: { supportsDecision: true } } })
      const server = await listen(makeApp(discovery, loadManager, history))
      try {
        const message = kind === 'JSON without an error field' ? detail : upstreamMessage
        expect(await post(server, '/v1/systemone', body)).toEqual({ status: 400, data: { error: message } })
        expect(upstreamCalls).toBe(1)
        expect(lastEntry()).toMatchObject({
          status: 'failed', responseStatus: 400, failureCategory: 'invalid_request', retryHint: 'no_retry',
        })
        expect(discovery.inventory.get(host)!.models.get(model)!.systemoneMaxCriteria).toBe(2)
        expect(await post(server, '/v1/systemone', body)).toEqual({ status: 400, data: { error: routerMessage } })
        expect(upstreamCalls).toBe(1)
        expect(lastEntry()).toMatchObject({
          status: 'failed', responseStatus: 400, error: routerMessage,
          failureCategory: 'invalid_request', retryHint: 'no_retry',
        })
      } finally {
        await close(server)
        await close(upstream)
      }
    })

    it('keeps the generic 503 for auto when all decision models exceed their cap', async () => {
      const host = 'http://node-a:11434'
      const discovery = makeDiscovery({ [host]: { [model]: { supportsDecision: true } } })
      discovery.inventory.get(host)!.models.get(model)!.systemoneMaxCriteria = 2
      const server = await listen(makeApp(discovery, loadManager, history))
      try {
        expect(await post(server, '/v1/systemone', { ...body, model: 'auto' })).toEqual({
          status: 503, data: { error: 'No suitable models available' },
        })
      } finally { await close(server) }
    })

    it('does not bypass a known cap through a cached chat candidate', async () => {
      let upstreamCalls = 0
      const upstreamApp = express()
      upstreamApp.post('/v1/systemone', (_req, res) => {
        upstreamCalls++
        res.json({ answers: {} })
      })
      const upstream = await listen(upstreamApp)
      const host = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`
      const decisionHost = 'http://node-b:11434'
      const discovery = makeDiscovery({
        [host]: { [model]: {} },
        [decisionHost]: { [model]: { supportsDecision: true } },
      })
      discovery.inventory.get(decisionHost)!.models.get(model)!.systemoneMaxCriteria = 2
      const router = new RequestRouter(discovery, loadManager)
      await router.selectForChat({ model, messages: [] })
      expect(router.peekSignalCache(body)).not.toBeNull()
      const app = express()
      app.use(express.json())
      setupSystemoneRoutes(app, discovery, loadManager, router, history)
      const server = await listen(app)
      try {
        expect(await post(server, '/v1/systemone', body)).toEqual({ status: 400, data: { error: routerMessage } })
        expect(upstreamCalls).toBe(0)
        expect(lastEntry()).toMatchObject({ failureCategory: 'invalid_request', retryHint: 'no_retry' })
      } finally {
        await close(server)
        await close(upstream)
      }
    })

    it.each([
      { kind: 'success', secondStatus: 200, secondError: '', expectedStatus: 200, expectedData: { model, answers: {} } },
      { kind: 'server error', secondStatus: 500, secondError: 'upstream failure', expectedStatus: 503, expectedData: { error: 'All upstream nodes failed' } },
      { kind: 'other client error', secondStatus: 400, secondError: 'invalid state', expectedStatus: 503, expectedData: { error: 'All upstream nodes failed' } },
      { kind: 'criteria limit', secondStatus: 400, secondError: 'criteria must contain 2-3 candidates', expectedStatus: 400, expectedData: { error: 'criteria must contain 2-3 candidates' } },
    ])('continues to the next candidate and handles its final $kind result', async ({ secondStatus, secondError, expectedStatus, expectedData }) => {
      let firstCalls = 0
      let secondCalls = 0
      const firstApp = express()
      firstApp.post('/v1/systemone', (_req, res) => {
        firstCalls++
        res.status(400).json({ error: upstreamMessage })
      })
      const secondApp = express()
      secondApp.post('/v1/systemone', (_req, res) => {
        secondCalls++
        if (secondStatus === 200) res.json({ answers: {} })
        else res.status(secondStatus).json({ error: secondError })
      })
      const first = await listen(firstApp)
      const second = await listen(secondApp)
      const firstHost = `http://127.0.0.1:${(first.address() as { port: number }).port}`
      const secondHost = `http://127.0.0.1:${(second.address() as { port: number }).port}`
      const discovery = makeDiscovery({
        [firstHost]: { [model]: { supportsDecision: true } },
        [secondHost]: { [model]: { supportsDecision: true } },
      })
      const server = await listen(makeApp(discovery, loadManager, history))
      try {
        const requestBody = { ...body, questions: [{ criteria: ['a', 'b', 'c', 'd'] }] }
        expect(await post(server, '/v1/systemone', requestBody)).toEqual({ status: expectedStatus, data: expectedData })
        expect(firstCalls).toBe(1)
        expect(secondCalls).toBe(1)
        expect(discovery.inventory.get(firstHost)!.models.get(model)!.systemoneMaxCriteria).toBe(2)
      } finally {
        await close(server)
        await close(first)
        await close(second)
      }
    })
  })

  // ── No candidates (empty node) ─────────────────────────────────────────────

  describe('no candidates', () => {
    it('systemone: an offline decision model with no wake option returns 503 and finishes history', async () => {
      const host = 'http://node-a:11434'
      const discovery = makeDiscovery({ [host]: { 'decision:2b': { supportsDecision: true } } })
      discovery.inventory.get(host)!.reachable = false
      const wake = jest.spyOn(discovery, 'tryWakeNodesForRequest').mockReturnValue(false)
      const server = await listen(makeApp(discovery, loadManager, history))
      try {
        const res = await post(server, '/v1/systemone', { model: 'decision:2b', state: {}, questions: [] })
        const message = 'No node can serve decision model decision:2b right now'
        expect(res).toEqual({ status: 503, data: { error: message } })
        expect(wake).toHaveBeenCalledTimes(1)
        expect(lastEntry()).toMatchObject({
          status: 'failed', responseStatus: 503, error: message,
          failureCategory: 'capacity', retryHint: 'retry_later',
        })
        expect(lastEntry().finishedAt).toBeGreaterThan(0)
      } finally { await close(server) }
    })

    it('systemone: an unavailable auto request keeps the generic 503', async () => {
      const server = await listen(makeApp(makeDiscovery(BASE_NODES), loadManager, history))
      try {
        const res = await post(server, '/v1/systemone', { model: 'auto', state: {}, questions: [] })
        expect(res).toEqual({ status: 503, data: { error: 'No suitable models available' } })
        expect(lastEntry()).toMatchObject({ status: 'failed', responseStatus: 503 })
      } finally { await close(server) }
    })

    it('chat: entry is finished with status=failed after 503', async () => {
      const server = await listen(makeApp(makeDiscovery({ 'http://empty:11434': {} }), loadManager, history))
      try {
        const res = await post(server, '/v1/chat/completions', { model: 'auto', messages: [{ role: 'user', content: 'hi' }] })
        expect(res.status).toBe(503)
        const entry = lastEntry()
        expect(entry).toBeDefined()
        expect(entry.status).toBe('failed')
        expect(entry.finishedAt).toBeGreaterThan(0)
      } finally { await close(server) }
    })

    it('embeddings: entry is finished with status=failed after 503', async () => {
      const server = await listen(makeApp(makeDiscovery({ 'http://empty:11434': {} }), loadManager, history))
      try {
        const res = await post(server, '/v1/embeddings', { model: 'auto', input: 'hello' })
        expect(res.status).toBe(503)
        const entry = lastEntry()
        expect(entry).toBeDefined()
        expect(entry.status).toBe('failed')
        expect(entry.finishedAt).toBeGreaterThan(0)
      } finally { await close(server) }
    })
  })
})
