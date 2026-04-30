// admin.js - Admin and status endpoints (health, inventory, dashboard)
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DASHBOARD_HTML = readFileSync(
  join(__dirname, '..', 'dashboard', 'index.html'),
  'utf8',
)

export function setupAdminRoutes(app, discoveryManager, loadManager) {
  const handleScanNow = async (req, res) => {
    try {
      const scanStatus = discoveryManager.getScanStatus()
      if (scanStatus.inProgress) {
        return res.status(409).json({
          error: 'Scan already in progress',
          status: scanStatus,
        })
      }

      // Trigger scan and wait for completion with timeout
      const scanPromise = discoveryManager.discoverNetworkNodes()
      await Promise.race([
        scanPromise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Scan timeout')), 30000),
        ),
      ])

      const finalStatus = discoveryManager.getScanStatus()
      const inventory = discoveryManager.getNodes()

      res.json({
        success: true,
        message: 'Network scan completed',
        status: finalStatus,
        nodeCount: inventory.size,
        nodes: Array.from(inventory.keys()),
      })
    } catch (err) {
      res.status(500).json({
        error: 'Scan failed',
        message: err.message,
      })
    }
  }

  /**
   * GET /health - Health check endpoint
   */
  app.get('/health', (req, res) => {
    const reachableCount = discoveryManager.getReachableNodeCount()
    const totalNodes = discoveryManager.getNodes().size
    const activeRequests = loadManager.getTotalActiveRequests()

    res.json({
      status: reachableCount > 0 ? 'healthy' : 'degraded',
      nodes_reachable: reachableCount,
      total_nodes: totalNodes,
      active_requests: activeRequests,
    })
  })

  /**
   * GET /inventory - Detailed inventory of nodes and models
   */
  app.get('/inventory', (req, res) => {
    const inventory = discoveryManager.getNodes()

    res.json({
      timestamp: Date.now(),
      nodes: Object.fromEntries(
        Array.from(inventory.entries()).map(([nodeHost, node]) => [
          nodeHost,
          {
            host: node.host,
            reachable: node.reachable,
            lastSeen: node.lastSeen,
            // Bug 4: activeRequests now kept in sync via LoadManager callback (app.js)
            activeRequests: node.activeRequests,
            models: Object.fromEntries(
              Array.from(node.models.entries()).map(
                ([modelName, modelInfo]) => [
                  modelName,
                  {
                    name: modelInfo.name,
                    family: modelInfo.family,
                    size: modelInfo.size,
                    profile: modelInfo.profile,
                    // Bug 4: status and per-model activeRequests are load-tracked at
                    // node level (not per-model). Removed to avoid misleading zeros.
                    recentLatency: modelInfo.recentLatency,
                    recentTps: modelInfo.recentTps,
                    failures: modelInfo.failures,
                    totalRequests: modelInfo.totalRequests,
                    lastSeen: modelInfo.lastSeen,
                    lastRoutingEndpoint: modelInfo.lastRoutingEndpoint,
                    lastRoutedAt: modelInfo.lastRoutedAt,
                  },
                ],
              ),
            ),
          },
        ]),
      ),
    })
  })

  /**
   * POST /discovery/scan-now - Trigger immediate network scan
   */
  app.post('/discovery/scan-now', handleScanNow)

  app.get('/dashboard', (req, res) => {
    res.setHeader('Content-Type', 'text/html')
    res.send(DASHBOARD_HTML)
  })

  app.get('/dashboard/requests', (req, res) => {
    res.setHeader('Content-Type', 'text/html')
    res.send(DASHBOARD_HTML)
  })
}
