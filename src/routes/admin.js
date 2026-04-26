// admin.js - Admin and status endpoints (health, inventory, dashboard)
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sendWakeOnLan } from '../wol.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DASHBOARD_HTML = readFileSync(
  join(__dirname, '..', 'dashboard', 'index.html'),
  'utf8',
)

export function setupAdminRoutes(app, discoveryManager, loadManager) {
  /**
   * GET /health - Health check endpoint
   */
  app.get('/health', (req, res) => {
    const reachableCount = discoveryManager.getReachableNodeCount()
    const totalNodes = discoveryManager.getNodes().size
    const activeRequests = loadManager.getTotalActiveRequests()

    res.json({
      status: 'healthy',
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
            activeRequests: loadManager.getCurrentLoad(nodeHost),
            models: Object.fromEntries(
              Array.from(node.models.entries()).map(
                ([modelName, modelInfo]) => [
                  modelName,
                  {
                    name: modelInfo.name,
                    family: modelInfo.family,
                    size: modelInfo.size,
                    profile: modelInfo.profile,
                    status: modelInfo.status,
                    recentLatency: modelInfo.recentLatency,
                    recentTps: modelInfo.recentTps,
                    failures: modelInfo.failures,
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
   * GET /dashboard - Beautiful real-time dashboard powered by WebSocket
   */
  app.get('/dashboard', (req, res) => {
    res.setHeader('Content-Type', 'text/html')
    res.send(DASHBOARD_HTML)
  })

  app.get('/dashboard/requests', (req, res) => {
    res.setHeader('Content-Type', 'text/html')
    res.send(DASHBOARD_HTML)
  })

  /**
   * POST /nodes/wake - Manually send a WoL magic packet to a node.
   * Body: { mac: "aa:bb:cc:dd:ee:ff", host?: "http://192.168.1.10:11434" }
   * The 'mac' field is required. 'host' is used to derive the subnet broadcast
   * address for better WiFi reliability.
   */
  app.post('/nodes/wake', async (req, res) => {
    const { mac, host } = req.body ?? {}

    if (!mac || typeof mac !== 'string') {
      return res.status(400).json({ error: 'mac is required' })
    }

    try {
      await sendWakeOnLan(mac, { nodeHost: host })
      res.json({ ok: true, mac, host: host ?? null })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })
}
