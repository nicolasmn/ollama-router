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

  // ── No candidates (empty node) ─────────────────────────────────────────────

  describe('no candidates', () => {
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
