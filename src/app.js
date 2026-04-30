// app.js - Application factory
import http from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import pino from 'pino'
import { DiscoveryManager } from './discovery-manager.js'
import { LoadManager } from './load-manager.js'
import { RequestHistoryManager } from './request-history.js'
import { RequestRouter } from './request-router.js'
import { WsManager } from './ws-manager.js'
import { createRoutes } from './routes/index.js'

const logger = pino()
const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * Create and configure the application with Express, WebSocket support, and all managers.
 * @param {Object} config - configuration object
 * @param {Array<string>} config.ollamaNodes - list of Ollama node addresses
 * @param {number} config.discoveryInterval - interval for periodic discovery in ms
 * @param {number} config.maxConcurrentPerNode - max concurrent requests per node
 * @param {number} config.port - server port
 * @returns {Promise<{server: http.Server, managers: Object}>}
 */
export async function createApp(config) {
  logger.info('Creating application with config:', {
    nodeCount: config.ollamaNodes?.length,
    discoveryInterval: config.discoveryInterval,
    maxConcurrentPerNode: config.maxConcurrentPerNode,
    autoDiscover: config.autoDiscover,
  })

  // Create managers
  const discoveryManager = new DiscoveryManager({
    ollamaNodes: config.ollamaNodes,
    discoveryInterval: config.discoveryInterval,
    autoDiscover: config.autoDiscover,
    networkScanInterval: config.networkScanInterval,
    metricsFile: config.metricsFile || null,
  })

  // Bug 4: wire LoadManager -> DiscoveryManager so NodeInfo.activeRequests stays accurate.
  // The callback fires on every increment/decrement keeping the inventory in sync
  // without requiring route handlers to know about DiscoveryManager internals.
  const loadManager = new LoadManager({
    maxConcurrentPerNode: config.maxConcurrentPerNode,
    onNodeLoadChange: (nodeHost, currentLoad) => {
      const node = discoveryManager.getNodes().get(nodeHost)
      if (node) node.activeRequests = currentLoad
    },
  })

  discoveryManager.setInventoryUpdateHandler((inventory) => {
    const activeNodeHosts = new Set(inventory.keys())
    loadManager.cleanupOrphanedNodes(activeNodeHosts)
  })

  const requestRouter = new RequestRouter(discoveryManager, loadManager)
  const requestHistoryManager = new RequestHistoryManager()

  // Initialize discovery
  const reachableCount = await discoveryManager.initialize()
  if (reachableCount === 0) {
    if (config.autoDiscover) {
      logger.warn('No reachable nodes found at startup — will keep scanning the network')
    } else {
      logger.error('No reachable nodes at startup')
      throw new Error('No reachable nodes available')
    }
  }

  // Start periodic probe
  discoveryManager.startPeriodicProbe()

  // Create Express app and HTTP server
  const app = express()
  app.use(express.json({ limit: '10mb' }))
  app.use('/dashboard-assets', express.static(join(__dirname, 'dashboard')))
  app.use(
    '/dashboard-vendor/lit',
    express.static(join(__dirname, '..', 'node_modules', 'lit')),
  )
  app.use(
    '/dashboard-vendor/lit-html',
    express.static(join(__dirname, '..', 'node_modules', 'lit-html')),
  )
  app.use(
    '/dashboard-vendor/lit-element',
    express.static(join(__dirname, '..', 'node_modules', 'lit-element')),
  )
  app.use(
    '/dashboard-vendor/@lit',
    express.static(join(__dirname, '..', 'node_modules', '@lit')),
  )
  createRoutes(
    app,
    discoveryManager,
    loadManager,
    requestRouter,
    requestHistoryManager,
  )

  const server = http.createServer(app)
  const wsManager = new WsManager({
    server,
    discoveryManager,
    loadManager,
    requestHistoryManager,
  })

  return {
    server,
    managers: {
      discovery: discoveryManager,
      load: loadManager,
      requests: requestHistoryManager,
      router: requestRouter,
      ws: wsManager,
    },
  }
}
