// admin.js - Admin and diagnostic routes
import { createLogger } from '../logger.js'

const logger = createLogger('admin')

export function setupAdminRoutes(app, discoveryManager, loadManager, requestHistoryManager) {
  app.get('/health', (req, res) => {
    const reachableCount = discoveryManager.getReachableNodeCount()
    const status = reachableCount > 0 ? 'healthy' : 'degraded'
    res.json({
      status,
      reachableNodes: reachableCount,
      timestamp: new Date().toISOString(),
    })
  })

  app.get('/inventory', (req, res) => {
    const nodes = []
    for (const [host, node] of discoveryManager.getNodes()) {
      const models = []
      for (const [name, modelInfo] of node.models) {
        models.push({
          name,
          family: modelInfo.family,
          size: modelInfo.size,
          recentLatency: modelInfo.recentLatency,
          recentTps: modelInfo.recentTps,
          failures: modelInfo.failures,
          totalRequests: modelInfo.totalRequests,
          activeRequests: loadManager.getCurrentLoad(host),
          lastRoutingEndpoint: modelInfo.lastRoutingEndpoint,
          profile: modelInfo.profile?.toJSON?.() ?? null,
        })
      }
      nodes.push({
        host,
        reachable: node.reachable,
        failures: node.failures,
        lastSeen: node.lastSeen,
        activeRequests: loadManager.getCurrentLoad(host),
        models,
      })
    }
    res.json({ nodes })
  })

  app.post('/discovery/scan-now', async (req, res) => {
    try {
      logger.info('Manual network scan triggered')
      await discoveryManager.discoverNetworkNodes()
      const nodes = [...discoveryManager.getNodes().entries()].map(([host, node]) => ({
        host,
        reachable: node.reachable,
        modelCount: node.models.size,
      }))
      res.json({ status: 'ok', nodeCount: nodes.length, nodes })
    } catch (err) {
      logger.error({ err: err.message }, 'Manual scan failed')
      res.status(500).json({ error: err.message })
    }
  })

  app.get('/requests', (req, res) => {
    const limit = parseInt(req.query.limit) || 50
    const history = requestHistoryManager.getRequests(limit)
    res.json({ requests: history })
  })

  app.get('/requests/:id', (req, res) => {
    const entry = requestHistoryManager.getRequest(req.params.id)
    if (!entry) return res.status(404).json({ error: 'Request not found' })
    res.json(entry)
  })
}
