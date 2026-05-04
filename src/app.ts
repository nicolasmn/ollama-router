// app.ts - Application factory
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

export interface AppConfig {
  ollamaNodes: string[]
  discoveryInterval: number
  maxConcurrentPerNode: number
  port: number
  autoDiscover: boolean
  networkScanInterval: number
  metricsFile?: string | null
}

export interface AppManagers {
  discovery: DiscoveryManager
  load: LoadManager
  requests: RequestHistoryManager
  router: RequestRouter
  ws: WsManager
}

export interface AppResult {
  server: http.Server
  managers: AppManagers
}

export async function createApp(config: AppConfig): Promise<AppResult> {
  logger.info(
    {
      nodeCount: config.ollamaNodes?.length,
      discoveryInterval: config.discoveryInterval,
      maxConcurrentPerNode: config.maxConcurrentPerNode,
      autoDiscover: config.autoDiscover,
    },
    'Creating application with config',
  )

  const discoveryManager = new DiscoveryManager({
    ollamaNodes: config.ollamaNodes,
    discoveryInterval: config.discoveryInterval,
    autoDiscover: config.autoDiscover,
    networkScanInterval: config.networkScanInterval,
    metricsFile: config.metricsFile ?? null,
  })

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

  const reachableCount = await discoveryManager.initialize()
  if (reachableCount === 0) {
    logger.warn(
      {
        autoDiscover: config.autoDiscover,
        configuredNodes: config.ollamaNodes.length,
      },
      'No reachable nodes found at startup — will retry on next probe interval',
    )
  }

  discoveryManager.startPeriodicProbe()

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
