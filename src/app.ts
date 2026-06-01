// app.ts - Application factory
import http from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { createLogger } from './logger.js'
import { DiscoveryManager } from './discovery-manager.js'
import { LoadManager } from './load-manager.js'
import { RequestHistoryManager } from './request-history.js'
import { RequestRouter } from './request-router.js'
import { WsManager } from './ws-manager.js'
import { createRoutes } from './routes/index.js'
import {
  OLLAMA_CLOUD_URL,
  OLLAMA_CLOUD_API_KEY,
  DISABLED_MODELS_FILE,
} from './config.js'
import { disabledModelsStore } from './disabled-models-store.js'

const logger = createLogger('app')

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

  disabledModelsStore.configure(DISABLED_MODELS_FILE)

  const discoveryManager = new DiscoveryManager({
    ollamaNodes: config.ollamaNodes,
    discoveryInterval: config.discoveryInterval,
    autoDiscover: config.autoDiscover,
    networkScanInterval: config.networkScanInterval,
    metricsFile: config.metricsFile ?? null,
    cloudUrl: OLLAMA_CLOUD_URL,
    cloudApiKey: OLLAMA_CLOUD_API_KEY,
  })

  const loadManager = new LoadManager({
    maxConcurrentPerNode: config.maxConcurrentPerNode,
    onNodeLoadChange: (nodeHost, currentLoad) => {
      const node = discoveryManager.getNodes().get(nodeHost)
      if (node) node.activeRequests = currentLoad
    },
  })

  // Cloud node has no concurrency cap — register it as unlimited.
  if (OLLAMA_CLOUD_URL && OLLAMA_CLOUD_API_KEY) {
    loadManager.setUnlimited(OLLAMA_CLOUD_URL)
  }

  discoveryManager.setInventoryUpdateHandler((inventory) => {
    const activeNodeHosts = new Set(inventory.keys())
    loadManager.cleanupOrphanedNodes(activeNodeHosts)
  })

  const requestRouter = new RequestRouter(discoveryManager, loadManager)
  const requestHistoryManager = new RequestHistoryManager()

  // Run discovery in the background so the HTTP server can start immediately.
  // startPeriodicProbe() is chained to run after initialize() completes.
  discoveryManager
    .initialize()
    .then((reachableCount) => {
      if (reachableCount === 0) {
        logger.warn(
          {
            autoDiscover: config.autoDiscover,
            configuredNodes: config.ollamaNodes.length,
          },
          'No reachable nodes found after discovery — will retry on next probe interval',
        )
      }
      discoveryManager.startPeriodicProbe()
    })
    .catch((err: Error) =>
      logger.warn({ err: err.message }, 'Background initialization failed'),
    )

  const app = express()
  app.use((_req, res, next) => {
    res.setHeader('X-Ollama-Router', '1')
    next()
  })
  app.use(express.json({ limit: '10mb' }))
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = dirname(__filename)
  app.use('/dashboard-assets', express.static(join(__dirname, 'dashboard')))
  // In dev (tsx), __dirname resolves to src/ which has no bundle; also serve dist/src/dashboard/
  app.use(
    '/dashboard-assets',
    express.static(join(__dirname, '../dist/src/dashboard')),
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
