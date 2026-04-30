// admin.ts - Internal admin + inventory routes
import express from 'express'
import type { Router } from 'express'
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
        Array.from(nodes.entries()).map(([host, node]) => [
          host,
          {
            host: node.host,
            reachable: node.reachable,
            lastSeen: node.lastSeen,
            failures: node.failures,
            activeRequests: loadManager.getCurrentLoad(host),
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
        ]),
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
    if (node.reachable) {
      res.status(409).json({ error: 'Cannot remove a reachable node' })
      return
    }
    discoveryManager.removeNode(host)
    logger.info({ host }, 'Node removed via admin API')
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

  return r
}
