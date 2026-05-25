// admin.ts - Internal admin + inventory routes
import express from 'express'
import type { Router } from 'express'
import { request as undiciRequest } from 'undici'
import type { DiscoveryManager } from '../discovery-manager.js'
import type { LoadManager } from '../load-manager.js'
import type { RequestHistoryManager } from '../request-history.js'
import { createLogger } from '../logger.js'

const logger = createLogger('admin')

export interface AdminRouterDeps {
  discoveryManager: DiscoveryManager
  loadManager: LoadManager
  requestHistoryManager: RequestHistoryManager
}

export function createAdminRouter({
  discoveryManager,
  loadManager,
  requestHistoryManager,
}: AdminRouterDeps): Router {
  const r = express.Router()

  r.get('/health', (_req, res) => {
    const reachableNodes = discoveryManager.getReachableNodeCount()
    const status = reachableNodes > 0 ? 'ok' : 'degraded'
    const httpStatus = reachableNodes > 0 ? 200 : 503
    res.status(httpStatus).json({ status, reachableNodes })
  })

  r.get('/inventory', (_req, res) => {
    const nodes = discoveryManager.getNodes()
    const scanStatus = discoveryManager.getScanStatus()
    const reachableCount = discoveryManager.getReachableNodeCount()
    const result: Record<string, unknown> = {
      reachableCount,
      nodeCount: nodes.size,
      nodes: Object.fromEntries(
        Array.from(nodes.entries()).map(([host, node]) => {
          const isCloud = node.cloud ?? false
          return [
            host,
            {
              host: node.host,
              reachable: node.reachable,
              cloud: isCloud,
              lastSeen: node.lastSeen,
              failures: node.failures,
              activeRequests: loadManager.getCurrentLoad(host),
              // Cloud nodes have no concurrency cap — return null so UI hides the capacity bar
              maxConcurrentRequests: isCloud ? null : loadManager.getMaxConcurrentPerNode(),
              atCapacity: loadManager.isAtCapacity(host),
              utilization: loadManager.getUtilization(host),
              modelCount: node.models.size,
              models: Object.fromEntries(
                Array.from(node.models.entries()).map(([name, info]) => [
                  name,
                  {
                    name: info.name,
                    family: info.family,
                    size: info.size,
                    profile: info.profile,
                    recentLatency: info.recentLatency,
                    recentTps: info.recentTps,
                    failures: info.failures,
                    totalRequests: info.totalRequests,
                    lastRoutingEndpoint: info.lastRoutingEndpoint,
                    lastRoutedAt: info.lastRoutedAt,
                  },
                ]),
              ),
            },
          ]
        }),
      ),
      scan: {
        ...scanStatus,
        autoDiscover: discoveryManager.autoDiscover,
        isNetworkConnected: discoveryManager.isConnectedToNetworkNodes(),
      },
    }
    res.json(result)
  })

  r.delete('/inventory/nodes/:host', (req, res) => {
    const host = decodeURIComponent(req.params.host)
    const node = discoveryManager.getNodes().get(host)
    if (!node) {
      res.status(404).json({ error: 'Node not found' })
      return
    }
    if (node.cloud) {
      res.status(403).json({ error: 'Cloud node cannot be removed via this endpoint' })
      return
    }
    discoveryManager.removeNode(host)
    logger.info({ host, reachable: node.reachable }, 'Node removed via admin API')
    res.json({ ok: true, host })
  })

  r.post('/discovery/scan-now', async (_req, res) => {
    const scanStatus = discoveryManager.getScanStatus()
    if (scanStatus.inProgress) {
      res.status(409).json({ error: 'Scan already in progress' })
      return
    }
    try {
      await discoveryManager.discoverNetworkNodes()
      const nodes = discoveryManager.getNodes()
      const nodeCount = nodes.size
      res.json({
        ok: true,
        nodeCount,
        nodes: Array.from(nodes.keys()),
      })
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'Manual scan failed')
      res.status(500).json({ error: 'Scan failed' })
    }
  })

  r.get('/requests', (_req, res) => {
    res.json(requestHistoryManager.getRecentRequests())
  })

  r.delete('/requests/:requestId', (req, res) => {
    const { requestId } = req.params
    const entry = requestHistoryManager.getRecentRequests().find((r) => r.requestId === requestId)
    if (!entry) {
      res.status(404).json({ error: 'Request not found' })
      return
    }
    const activeStatuses = new Set(['waiting', 'running'])
    if (!activeStatuses.has(entry.status)) {
      res.status(409).json({ error: 'Request is not active' })
      return
    }
    const terminated = requestHistoryManager.terminateRequest(requestId)
    if (!terminated) {
      res.status(409).json({ error: 'Request has no active abort handle' })
      return
    }
    logger.info({ requestId }, 'Request terminated via admin API')
    res.json({ ok: true, requestId })
  })

  // ---------------------------------------------------------------------------
  // Cloud model management
  // ---------------------------------------------------------------------------

  /**
   * GET /admin/cloud/models
   * Returns models currently active on the cloud node (from discoveryManager)
   * plus all models available on ollama.com (/api/tags) for the "add" UI.
   * Falls back gracefully if the ollama.com request fails.
   */
  r.get('/cloud/models', async (_req, res) => {
    const info = discoveryManager.getCloudInfo()

    if (!info.configured) {
      res.status(503).json({ error: 'Cloud not configured (missing OLLAMA_CLOUD_URL or OLLAMA_CLOUD_API_KEY)' })
      return
    }

    let available: Array<{ name: string; size: number; modified_at: string }> = []
    try {
      const resp = await undiciRequest(`${info.cloudUrl}/api/tags`, {
        headers: { Authorization: `Bearer ${info.cloudApiKey}` },
        headersTimeout: 8000,
        bodyTimeout: 8000,
      })
      if (resp.statusCode === 200) {
        const data = (await resp.body.json()) as { models?: Array<Record<string, unknown>> }
        available = (data.models ?? []).map((m) => ({
          name: m.name as string,
          size: (m.size as number) ?? 0,
          modified_at: (m.modified_at as string) ?? '',
        }))
      } else {
        await resp.body.dump()
        logger.warn({ status: resp.statusCode }, 'ollama.com /api/tags returned non-200')
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Failed to fetch ollama.com /api/tags')
    }

    res.json({
      active: info.models,
      available,
    })
  })

  /**
   * POST /admin/cloud/models
   * Body: { name: string }
   * Adds a model to the active cloud node model list.
   */
  r.post('/cloud/models', (req, res) => {
    const info = discoveryManager.getCloudInfo()
    if (!info.configured) {
      res.status(503).json({ error: 'Cloud not configured' })
      return
    }
    const name = (req.body as Record<string, unknown>)?.name
    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'Missing or invalid "name" field' })
      return
    }
    const wasAlreadyActive = discoveryManager.cloudModels.includes(name)
    if (wasAlreadyActive) {
      res.status(409).json({ error: `Model "${name}" already active` })
      return
    }
    discoveryManager.addCloudModel(name)
    logger.info({ name }, 'Cloud model added via admin API')
    res.json({ ok: true, active: discoveryManager.cloudModels })
  })

  /**
   * DELETE /admin/cloud/models/:name
   * Removes a model from the active cloud node model list.
   */
  r.delete('/cloud/models/:name', (req, res) => {
    const info = discoveryManager.getCloudInfo()
    if (!info.configured) {
      res.status(503).json({ error: 'Cloud not configured' })
      return
    }
    const name = decodeURIComponent(req.params.name)
    const removed = discoveryManager.removeCloudModel(name)
    if (!removed) {
      res.status(404).json({ error: `Model "${name}" not in active list` })
      return
    }
    logger.info({ name }, 'Cloud model removed via admin API')
    res.json({ ok: true, active: discoveryManager.cloudModels })
  })

  return r
}
