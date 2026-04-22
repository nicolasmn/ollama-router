// app.js - Application factory
import express from 'express'
import pino from 'pino'
import { DiscoveryManager } from './discovery-manager.js'
import { LoadManager } from './load-manager.js'
import { RequestRouter } from './request-router.js'
import { createRoutes } from './routes.js'

const logger = pino()

/**
 * Create and configure the Express application
 * @param {Object} config - configuration object
 * @param {Array<string>} config.ollamaNodes - list of Ollama node addresses
 * @param {number} config.discoveryInterval - interval for periodic discovery in ms
 * @param {number} config.maxConcurrentPerNode - max concurrent requests per node
 * @param {number} config.port - server port
 * @returns {Promise<{app: Express.Application, managers: Object}>}
 */
export async function createApp(config) {
  logger.info('Creating application with config:', {
    nodeCount: config.ollamaNodes?.length,
    discoveryInterval: config.discoveryInterval,
    maxConcurrentPerNode: config.maxConcurrentPerNode,
  })

  // Create managers
  const discoveryManager = new DiscoveryManager({
    ollamaNodes: config.ollamaNodes,
    discoveryInterval: config.discoveryInterval,
  })

  const loadManager = new LoadManager({
    maxConcurrentPerNode: config.maxConcurrentPerNode,
  })

  discoveryManager.setInventoryUpdateHandler((inventory) => {
    const activeNodeHosts = new Set(inventory.keys())
    loadManager.cleanupOrphanedNodes(activeNodeHosts)
  })

  const requestRouter = new RequestRouter(discoveryManager, loadManager)

  // Initialize discovery
  const reachableCount = await discoveryManager.initialize()
  if (reachableCount === 0) {
    logger.error('No reachable nodes at startup')
    throw new Error('No reachable nodes available')
  }

  // Start periodic probe
  discoveryManager.startPeriodicProbe()

  // Create Express app
  const app = express()
  app.use(express.json({ limit: '10mb' }))

  // Setup routes
  createRoutes(app, discoveryManager, loadManager, requestRouter)

  // Return app and managers
  return {
    app,
    managers: {
      discovery: discoveryManager,
      load: loadManager,
      router: requestRouter,
    },
  }
}
